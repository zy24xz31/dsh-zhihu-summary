import { loadHostDeps } from './hostdeps.mjs'
import {
  CONSOLE_URL,
  ZhihuError,
  checkActiveAccountHealth,
  downloadZhihuImages,
  evaluateTarget,
  extractUrlFromText,
  fetchComments,
  fetchFollowMoments,
  fetchHomeFeed,
  fetchHotList,
  fetchMemberProfile,
  fetchNotifications,
  fetchQuestionAnswers,
  fetchUserCollections,
  getLatestQrAttempt,
  getRiskVerificationUrl,
  manageAnswerDraft,
  manageArticleDraft,
  manageCollectionItems,
  pollQrLogin,
  readZhihuUrl,
  searchZhihu,
  startQrLogin,
  verifyAndSaveCookieString,
} from './zhihu-api.js'
import {
  DEFAULT_SETTINGS,
  getActiveAccount,
  hasSettingsFile,
  listPublicAccounts,
  readSettings,
  removeAccount,
  setAccountBlocked,
  switchAccount,
  writeSettings,
} from './store.js'
import { registerWebConsole } from './web-console.js'

export const name = 'dsh-zhihu-summary'

const { defineTool, z } = await loadHostDeps()

export const Config = !z ? undefined : z.object({
  homeLimit: z.natural().default(DEFAULT_SETTINGS.homeLimit).description('主页推荐抓取条数（1-20）').extra('volatile', true),
  homeMaxChars: z.natural().default(DEFAULT_SETTINGS.homeMaxChars).description('主页单条正文上限字数（1000-100000）').extra('volatile', true),
  hotQuestions: z.natural().default(DEFAULT_SETTINGS.hotQuestions).description('热榜抓取问题数（1-20）').extra('volatile', true),
  hotAnswersPerQuestion: z.natural().default(DEFAULT_SETTINGS.hotAnswersPerQuestion).description('热榜每题抓取回答数（1-10）').extra('volatile', true),
  hotMaxChars: z.natural().default(DEFAULT_SETTINGS.hotMaxChars).description('热榜单回答上限字数（1000-100000）').extra('volatile', true),
  yanxuanTrialMaxChars: z.natural().default(DEFAULT_SETTINGS.yanxuanTrialMaxChars).description('盐选试读每章上限字数（3000-100000）').extra('volatile', true),
  readUrlMaxChars: z.natural().default(DEFAULT_SETTINGS.readUrlMaxChars).description('指定链接单次默认上限字数（5000-200000）').extra('volatile', true),
  imageReadMode: z.union(['off', 'index', 'auto']).default(DEFAULT_SETTINGS.imageReadMode).description('正文读图模式：index（按需保留[图N]索引，默认）/ auto（读单篇链接自动拉图）/ off（关闭读图）').extra('volatile', true),
  maxImagesPerItem: z.natural().default(DEFAULT_SETTINGS.maxImagesPerItem).description('单篇最多拉取图片数（1-15）').extra('volatile', true),
})

const safeJson = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

function formatToolError(err) {
  if (err instanceof ZhihuError) {
    const riskUrl = err.code === 'RISK_CONTROL' ? (err.detail?.redirect || getRiskVerificationUrl()) : undefined
    return {
      ok: false,
      errorCode: err.code,
      message: err.message,
      ...(riskUrl ? { riskUrl } : {}),
      consoleUrl: CONSOLE_URL,
      hint: err.code === 'RISK_CONTROL'
        ? `触发知乎风控：请打开验证链接 ${riskUrl} 或控制台 ${CONSOLE_URL} 完成人机验证后重试。`
        : `请打开 ${CONSOLE_URL} 登录或切换知乎账号。`,
    }
  }
  return { ok: false, errorCode: 'UNKNOWN', message: err?.message || String(err), consoleUrl: CONSOLE_URL }
}

function accountSnapshot(extra = {}) {
  const accounts = listPublicAccounts()
  const active = getActiveAccount()
  const cfg = readSettings()
  const statusText = !active
    ? '未登录知乎账号'
    : (active.blocked ? `受阻：${active.blocked.message || '需要人机验证'}` : `当前账号：${active.name}${active.isVip ? '（盐选会员）' : ''}`)
  const accountList = accounts.map((a) => ({
    title: a.name,
    subtitle: a.blocked ? `风控暂停：${a.blocked.message || '需要验证'}` : (a.urlToken ? `@${a.urlToken}` : '点击切换到此账号'),
    trailing: a.active ? '当前使用' : '切换',
    icon: a.active ? 'check' : 'user',
    tone: a.blocked ? 'bad' : (a.active ? 'good' : 'info'),
    action: { id: 'switchAccount', args: { id: a.id } },
  }))
  const qr = getLatestQrAttempt()
  return {
    loggedIn: Boolean(active?.cookies?.z_c0),
    activeId: active?.id || '',
    activeName: active?.name || '未登录',
    statusTone: !active ? 'warn' : (active.blocked ? 'bad' : 'good'),
    statusText,
    riskUrl: getRiskVerificationUrl(),
    consoleUrl: CONSOLE_URL,
    accountCount: String(accounts.length),
    limitsSummary: `主页${cfg.homeLimit}条(${cfg.homeMaxChars}字) · 热榜${cfg.hotQuestions}×${cfg.hotAnswersPerQuestion} · 盐选试读${cfg.yanxuanTrialMaxChars}字 · 链接${cfg.readUrlMaxChars}字 · 读图:${cfg.imageReadMode === 'auto' ? `自动(${cfg.maxImagesPerItem}张)` : (cfg.imageReadMode === 'off' ? '关' : '按需')}`,
    accountList,
    qrImage: qr?.qrDataUrl || null,
    qrHint: qr?.message || '点击「扫码登录」生成二维码，或先复制知乎 Cookie 再点「导入剪贴板Cookie」。',
    ...extra,
  }
}

function extractZhihuCandidate(text) {
  const url = extractUrlFromText(text)
  if (/^https?:\/\//i.test(url) && /(zhihu\.com|zhuanlan\.zhihu\.com|zhihu\.app\.link)/i.test(url)) return url
  return ''
}

function copyRiskUrlEffect() {
  return { copy: getRiskVerificationUrl(), toast: '已复制知乎验证链接，请用浏览器打开' }
}

export async function apply(ctx, config) {
  if (!hasSettingsFile() && config && typeof config === 'object' && Object.keys(config).length > 0) {
    try { writeSettings(config) } catch { /* ignore */ }
  }

  ctx.inject(['tools'], (c) => {
    const reg = (spec) => c.tools.register(defineTool({
      ...spec,
      output: spec.output || textOutput,
      async execute(args, exec) {
        try {
          return safeJson(await spec.execute(args || {}, exec))
        } catch (err) {
          return safeJson(formatToolError(err))
        }
      },
    }))

    reg({
      name: 'zhihu_account_status',
      description: '查看当前知乎登录状态、已保存账号列表、当前字数与抓取设置，以及知乎登录/人机验证控制台地址。',
      parameters: {},
      async execute() {
        const snap = accountSnapshot()
        return {
          ok: true,
          loggedIn: snap.loggedIn,
          activeName: snap.activeName,
          statusText: snap.statusText,
          consoleUrl: CONSOLE_URL,
          settings: readSettings(),
          accounts: listPublicAccounts(),
        }
      },
    })

    reg({
      name: 'zhihu_home_digest',
      description: '读取当前登录知乎账号的主页推荐流非付费内容（自动过滤广告和盐选付费内容，补全长回答正文），供总结。默认条数与单条字数遵循插件设置。',
      parameters: {
        limit: { type: 'number', description: '抓取条数，可选，默认遵循插件设置（默认 10，最大 20）。' },
      },
      async execute(args) {
        const cfg = readSettings()
        const data = await fetchHomeFeed({ limit: Number(args.limit) || cfg.homeLimit, fetchFull: true, maxChars: cfg.homeMaxChars })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_hot_digest',
      description: '读取当前知乎热榜问题，并抓取每个问题下非付费高赞回答正文，供总结。默认题数、回答数与单回答字数遵循插件设置。',
      parameters: {
        topQuestions: { type: 'number', description: '热榜前几题，可选，默认遵循插件设置（默认 5）。' },
        answersPerQuestion: { type: 'number', description: '每题读取回答数，可选，默认遵循插件设置（默认 3）。' },
      },
      async execute(args) {
        const cfg = readSettings()
        const data = await fetchHotList({
          topQuestions: Number(args.topQuestions) || cfg.hotQuestions,
          answersPerQuestion: Number(args.answersPerQuestion) || cfg.hotAnswersPerQuestion,
          maxChars: cfg.hotMaxChars,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_evaluate',
      description: '判断某个知乎收藏夹、专栏或盐选小说/作品值不值得读（返回收藏夹高赞抽样或盐选小说简介、试读目录/试读正文及社区评价，盐选试读字数上限遵循插件设置，默认 15,000 字）。',
      parameters: {
        target: { type: 'string', required: true, description: '知乎收藏夹链接、专栏链接、盐选小说链接或作品名称关键词。' },
      },
      async execute(args) {
        const cfg = readSettings()
        const data = await evaluateTarget(String(args.target || ''), { yanxuanTrialMaxChars: cfg.yanxuanTrialMaxChars })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_read_url',
      description: '读取指定的知乎回答、专栏文章、问题、想法或分享短链的正文、配图索引与高赞评论，供总结。单次默认字数上限遵循插件设置（默认 60,000 字，最大 200,000）；若返回 truncated: true，可传入 offset: nextOffset 继续分段读取。默认按插件读图模式返回 [图N] 锚点与图片清单，也可通过 withImages 临时覆盖（off/index/auto）。',
      parameters: {
        url: { type: 'string', required: true, description: '知乎回答、文章、问题或分享短链 URL。' },
        offset: { type: 'number', description: '可选，分段读取起始字符偏移量，默认 0。' },
        maxChars: { type: 'number', description: '可选，单次最大返回字数，默认遵循插件设置（默认 60000，最大 200000）。' },
        withImages: { type: 'string', description: '可选，单次覆盖正文读图模式：index（返回[图N]锚点与图片URL清单）/ auto（自动下载前N张到本地缓存供 read_image 查看）/ off（纯文字）。省略时遵循插件设置。' },
      },
      async execute(args) {
        const cfg = readSettings()
        const data = await readZhihuUrl(String(args.url || ''), {
          offset: args.offset,
          maxChars: args.maxChars || cfg.readUrlMaxChars,
          withImages: args.withImages,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_collections',
      description: '列出当前账号（或指定 urlToken）的知乎收藏夹列表；传入 collectionId（支持收藏夹 ID、链接或名称如「待看」）则分页读取该收藏夹内的条目与正文预览。',
      parameters: {
        collectionId: { type: 'string', description: '可选，收藏夹 ID、链接或名称（如 "待看"）；省略时返回收藏夹列表。' },
        urlToken: { type: 'string', description: '可选，其他知乎用户的 urlToken，默认当前登录账号。' },
        offset: { type: 'number', description: '可选，分页偏移量，默认 0。' },
        limit: { type: 'number', description: '可选，每页条数（1-20），默认 20。' },
        maxChars: { type: 'number', description: '可选，单条正文最大返回字数，默认 4000。' },
      },
      async execute(args) {
        const data = await fetchUserCollections({
          urlToken: args.urlToken,
          collectionId: args.collectionId,
          offset: args.offset,
          limit: args.limit,
          maxChars: args.maxChars,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_manage_collection',
      description: '向指定知乎收藏夹批量添加或取消收藏条目，内置 2.4~3.8 秒随机防风控间隔。修改账号数据前请先向用户确认目标条目。',
      parameters: {
        collectionId: { type: 'string', required: true, description: '收藏夹 ID、链接或名称（如 "待看"）。' },
        action: { type: 'string', description: '操作类型："remove"（取消收藏，默认）或 "add"（添加收藏）。' },
        items: { type: 'array', required: true, description: '要操作的条目数组，每项可以是回答/文章链接、纯 ID 字符串，或 { id, type } 对象。', items: { type: 'object', additionalProperties: true } },
        intervalMinMs: { type: 'number', description: '可选，最小请求间隔毫秒数，默认 2400。' },
        intervalMaxMs: { type: 'number', description: '可选，最大请求间隔毫秒数，默认 3800。' },
      },
      async execute(args) {
        const data = await manageCollectionItems({
          collectionId: args.collectionId,
          action: args.action || 'remove',
          items: args.items,
          intervalMinMs: args.intervalMinMs,
          intervalMaxMs: args.intervalMaxMs,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_comments',
      description: '读取指定知乎回答、文章、想法、问题的评论区（固定每页 9 条主评论并保留热门楼中楼预览）；也支持传入某条主评论 ID 并指定 type: "comment" 完整分页展开该层楼中楼回复（固定每页 20 条，保留 replyToAuthor 与 replyToCommentId 对话链及配图）。',
      parameters: {
        target: { type: 'string', required: true, description: '知乎回答/文章/想法/问题链接、内容 ID；展开楼中楼时传入主评论 id（并配合 type: "comment"）。' },
        type: { type: 'string', enum: ['answer', 'article', 'pin', 'question', 'comment'], description: '当 target 为纯数字 ID 时指定类型：answer（默认）/ article / pin / question / comment（展开单条评论下的完整楼中楼）。' },
        order: { type: 'string', enum: ['normal', 'ts'], description: '排序方式：normal（按热度，主评论区默认）或 ts（按时间顺序，楼中楼默认）。' },
        offset: { type: 'string', description: '分页游标或偏移量，默认从头开始；继续翻页请传入上次返回的 nextOffset。' },
      },
      async execute(args) {
        const data = await fetchComments(String(args.target || ''), {
          type: args.type,
          order: args.order,
          offset: args.offset,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_search',
      description: '使用知乎综合搜索接口（签名 v4 search_v3）按关键词搜索回答、文章和问题。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索关键词。' },
        limit: { type: 'number', description: '返回条数（1-20），默认 10。' },
        offset: { type: 'number', description: '分页偏移量，默认 0。' },
      },
      async execute(args) {
        const data = await searchZhihu(String(args.query || ''), {
          limit: args.limit,
          offset: args.offset,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_member',
      description: '读取指定知乎用户的主页简介、获赞/关注统计，以及其近期动态和代表作回答列表。',
      parameters: {
        target: { type: 'string', required: true, description: '知乎用户主页链接（/people/xxx）或 urlToken。' },
        sortBy: { type: 'string', description: '回答排序：voteups（按赞同数，默认）或 created（按最新发布）。' },
        limit: { type: 'number', description: '抓取条数（1-20），默认 10。' },
        offset: { type: 'number', description: '分页偏移量，默认 0。' },
        maxChars: { type: 'number', description: '单条内容最大字数，默认 4000。' },
      },
      async execute(args) {
        const data = await fetchMemberProfile(String(args.target || ''), {
          sortBy: args.sortBy,
          limit: args.limit,
          offset: args.offset,
          maxChars: args.maxChars,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_question_answers',
      description: '分页读取指定知乎问题下的回答列表（支持按默认热度或最新发布排序，并可通过 nextCursor 连续翻页）。',
      parameters: {
        target: { type: 'string', required: true, description: '知乎问题链接或纯问题 ID。' },
        order: { type: 'string', description: '排序方式：default（默认热度排序）或 updated（按最新发布时间）。' },
        limit: { type: 'number', description: '每页抓取回答数（1-20），默认 10。' },
        cursor: { type: 'string', description: '翻页游标，直接传入上次返回的 nextCursor 即可继续读取下一页。' },
        maxChars: { type: 'number', description: '单条回答最大字数，默认遵循热榜单回答设置。' },
        includePaid: { type: 'boolean', description: '是否包含盐选付费回答，默认 false。' },
      },
      async execute(args) {
        const data = await fetchQuestionAnswers(String(args.target || ''), {
          order: args.order,
          limit: args.limit,
          cursor: args.cursor,
          maxChars: args.maxChars,
          includePaid: Boolean(args.includePaid),
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_follow',
      description: '读取当前登录知乎账号的「关注」动态流（关注的人赞同、回答或发布的想法，自动过滤广告与付费内容）。',
      parameters: {
        limit: { type: 'number', description: '读取条数（1-20），默认 10。' },
        cursor: { type: 'string', description: '翻页游标，传入上次返回的 nextCursor 继续往下刷。' },
        fetchFull: { type: 'boolean', description: '是否自动补全较短摘要的完整正文，默认 true。' },
      },
      async execute(args) {
        const data = await fetchFollowMoments({
          limit: args.limit,
          cursor: args.cursor,
          fetchFull: args.fetchFull !== false,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_notifications',
      description: '读取当前知乎账号的通知收件箱，默认读取评论与回复（自动跨页过滤掉淹没消息的回答邀请），也支持读全部通知、回答邀请、赞同感谢、新关注或总览。',
      parameters: {
        category: { type: 'string', description: '通知分类：comments（评论与回复，默认）/ all（全部）/ invites（回答邀请）/ likes（赞同感谢）/ follows（新关注）/ summary（未读总览）。' },
        limit: { type: 'number', description: '返回条数（1-20），默认 15。' },
        offset: { type: 'string', description: '翻页游标，传入上次返回的 nextOffset 继续翻页。' },
        unreadOnly: { type: 'boolean', description: '是否仅返回未读通知，默认 false。' },
      },
      async execute(args) {
        const data = await fetchNotifications({
          category: args.category || 'comments',
          limit: args.limit,
          offset: args.offset,
          unreadOnly: Boolean(args.unreadOnly),
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_answer_draft',
      description: '查看、保存或删除指定知乎问题的回答草稿（绝不自动公开发布）。保存时自动将 Markdown 转为知乎富文本 HTML，且默认开启防覆盖保护（若问题下已有草稿会中止并返回原草稿供用户决定覆盖或追加）。',
      parameters: {
        question: { type: 'string', required: true, description: '知乎问题链接（/question/xxx）或纯问题 ID。' },
        action: { type: 'string', description: '操作类型：get（查看现有草稿，默认）/ save（保存草稿）/ delete（删除草稿，删除前需先向用户确认）。' },
        content: { type: 'string', description: '当 action 为 save 时必填，支持标准 Markdown 或 HTML 正文。' },
        format: { type: 'string', description: '正文格式：auto（自动识别，默认）/ markdown / html。' },
        mode: { type: 'string', description: '当 action 为 save 时的写入策略：create_only（默认，已有草稿时不覆盖）/ append（追加到原草稿末尾）/ overwrite（强制覆盖原草稿）。' },
      },
      async execute(args) {
        const data = await manageAnswerDraft({
          question: args.question,
          action: args.action || 'get',
          content: args.content,
          format: args.format || 'auto',
          mode: args.mode || 'create_only',
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_article_draft',
      description: '列出、查看、新建/更新或删除知乎专栏文章草稿（绝不自动公开发布）。保存时自动将 Markdown 转为知乎富文本 HTML（正文中无需重复写一级标题 # Title），默认开启防覆盖与防同名重复创建保护。',
      parameters: {
        action: { type: 'string', description: '操作类型：list（列出已知草稿，默认）/ get（读取指定草稿）/ save（新建或更新草稿）/ delete（删除草稿，删除前需先向用户确认）。' },
        articleId: { type: 'string', description: '文章草稿 ID 或编辑链接（如 /p/123456/edit）。get / delete 必填；save 时留空则新建草稿，传入则修改对应草稿。' },
        title: { type: 'string', description: '文章标题（新建草稿时必填；修改已有草稿时可选，不传则保留原标题）。' },
        content: { type: 'string', description: '文章正文，支持标准 Markdown 或 HTML（新建草稿时必填；正文中无需重复放主标题）。' },
        format: { type: 'string', description: '正文格式：auto（自动识别，默认）/ markdown / html。' },
        mode: { type: 'string', description: '当 action 为 save 时的写入策略：create_only（默认，遇到已有内容或同名草稿中止防误覆盖）/ append（追加到原草稿末尾）/ overwrite（强制覆盖）/ new（即使同名也强制另建新草稿）。' },
        limit: { type: 'number', description: '当 action 为 list 时最多返回的草稿条数（1-30），默认 20。' },
      },
      async execute(args) {
        const data = await manageArticleDraft({
          action: args.action || 'list',
          articleId: args.articleId,
          title: args.title,
          content: args.content,
          format: args.format || 'auto',
          mode: args.mode || 'create_only',
          limit: args.limit,
        })
        return { ok: true, ...data }
      },
    })

    reg({
      name: 'zhihu_download_images',
      description: '按需下载知乎正文配图（仅允许 *.zhimg.com 图床链接）到本机临时缓存目录并返回 localPath，下载后可直接用 read_image 工具查看图片内容（缓存超过 24 小时自动清理）。',
      parameters: {
        urls: { type: 'array', items: { type: 'string' }, required: true, description: '要下载的知乎图片 URL 列表（来自 zhihu_read_url / zhihu_home_digest 等工具返回的 images[].url 或 originalUrl）。' },
        maxCount: { type: 'number', description: '可选，本次最多下载张数（1-15），默认遵循插件设置的单篇最多拉取图片数。' },
      },
      async execute(args) {
        const cfg = readSettings()
        const data = await downloadZhihuImages(args.urls, {
          maxCount: args.maxCount || cfg.maxImagesPerItem,
        })
        return { ok: true, ...data }
      },
    })
  })

  ctx.inject(['webServer'], (c) => {
    c.effect(() => registerWebConsole(c), 'dsh-zhihu-summary: /zhihu 控制台路由')
  })

  ctx.inject(['dshGo'], (c) => {
    const requireLoggedIn = () => {
      const acc = getActiveAccount()
      if (!acc?.cookies?.z_c0) return { err: { toast: '请先登录知乎账号', open: 'panel:zhihu-account' } }
      return { acc }
    }
    c.dshGo.panel('zhihu-digest', {
      view: (_scope, caps) => {
        const en = String(caps.locale || '').startsWith('en')
        return {
          type: 'stack',
          title: en ? 'Zhihu Digest' : '知乎总结',
          children: [
            { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
            {
              type: 'actions',
              items: [
                { label: en ? 'Home Feed' : '主页推荐', icon: 'home', action: 'runHome' },
                { label: en ? 'Hot List' : '知乎热榜', icon: 'star', action: 'runHot' },
                { label: en ? 'Following' : '关注动态', icon: 'chats', action: 'runFollow' },
                { label: en ? 'Search' : '搜知乎', icon: 'search', action: 'runSearch' },
              ],
            },
            {
              type: 'actions',
              items: [
                { label: en ? 'Collections' : '我的收藏夹', icon: 'bookmark', action: 'runCollections' },
                { label: en ? 'Comments' : '读评论区', icon: 'forum', action: 'runComments' },
                { label: en ? 'Q Answers' : '问题回答', icon: 'list', action: 'runQuestion' },
                { label: en ? 'Member' : '查答主', icon: 'user', action: 'runMember' },
              ],
            },
            {
              type: 'actions',
              items: [
                { label: en ? 'Inbox' : '评论通知', icon: 'bell', action: 'runNotifications' },
                { label: en ? 'Draft Answer' : '代答草稿', icon: 'write', action: 'runAnswerDraft' },
                { label: en ? 'Eval Work' : '评收藏/盐选', icon: 'book', action: 'runEval' },
                { label: en ? 'Read Link' : '总结链接', icon: 'link', action: 'runUrl' },
              ],
            },
            {
              type: 'actions',
              items: [
                { label: en ? 'Draft Article' : '写文章草稿', icon: 'write', action: 'runArticleDraft' },
                { label: en ? 'Account' : '账号与设置', icon: 'settings', action: 'openAccount' },
                { label: en ? 'Verify Link' : '复制验证链接', icon: 'copy', action: 'copyRiskUrl' },
              ],
            },
            {
              type: 'text',
              tone: 'muted',
              text: en
                ? 'Copy a Zhihu link, keyword, or @user first; tapping a button inserts the prompt with clipboard filled.'
                : '可先复制链接/关键词/答主主页，再点上方按钮自动带入输入框（仅填入，不自动发送）。',
            },
          ],
        }
      },
      data: (_scope, emit) => {
        emit(accountSnapshot())
        return () => {}
      },
      actions: {
        runHome: () => {
          const { err } = requireLoggedIn()
          if (err) return err
          return { insert: '调用知乎工具刷一下首页，简单判断内容的价值，详细总结高价值高熵内容，可以把里边的金句或特别搞笑、离谱的事摘出来，其余的简单总结。' }
        },
        runHot: () => {
          const { err } = requireLoggedIn()
          if (err) return err
          const cfg = readSettings()
          return { insert: `帮我调用知乎工具总结当前知乎热榜前${cfg.hotQuestions}个问题（每题至少读${cfg.hotAnswersPerQuestion}个回答）。` }
        },
        runFollow: () => {
          const { err } = requireLoggedIn()
          if (err) return err
          return { insert: '帮我调用 zhihu_follow 工具读取我关注的知乎用户最新动态并总结重点。' }
        },
        runSearch: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const clip = String(scope.clipboard || '').trim()
          if (clip && clip.length <= 60 && !clip.includes('\n') && !/^https?:\/\//i.test(clip)) {
            return { insert: `帮我调用 zhihu_search 工具搜索知乎并总结高赞结果：${clip}` }
          }
          return { insert: '帮我调用 zhihu_search 工具搜索知乎并总结高赞结果：', toast: '请在输入框后面填入搜索关键词' }
        },
        runCollections: () => {
          const { err } = requireLoggedIn()
          if (err) return err
          return { insert: '帮我调用 zhihu_collections 工具列出我的知乎收藏夹（如需读取或整理指定收藏夹，请在后面补充名称）。' }
        },
        runComments: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const url = extractZhihuCandidate(scope.clipboard || '')
          if (url) {
            return { insert: `帮我调用 zhihu_comments 工具读取这个知乎链接的热评与楼中楼讨论：${url}` }
          }
          return { insert: '帮我调用 zhihu_comments 工具读取这个知乎链接的评论区：', toast: '请在输入框后面粘贴知乎链接' }
        },
        runQuestion: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const url = extractZhihuCandidate(scope.clipboard || '')
          if (url) {
            return { insert: `帮我调用 zhihu_question_answers 工具读取这个问题下的更多高赞与最新回答：${url}` }
          }
          return { insert: '帮我调用 zhihu_question_answers 工具读取这个问题下的回答列表：', toast: '请在输入框后面粘贴知乎问题链接' }
        },
        runMember: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const clip = String(scope.clipboard || '').trim()
          const url = extractZhihuCandidate(clip)
          if (url && /\/people\//i.test(url)) {
            return { insert: `帮我调用 zhihu_member 工具查看该知乎答主的主页简介、近期动态与代表作：${url}` }
          }
          if (clip && clip.length <= 40 && !clip.includes('\n') && !/^https?:\/\//i.test(clip)) {
            return { insert: `帮我调用 zhihu_member 工具查看该知乎答主的主页简介、近期动态与代表作：${clip}` }
          }
          return { insert: '帮我调用 zhihu_member 工具查看知乎答主主页（请补充主页链接或 urlToken）：', toast: '请在输入框后面粘贴答主主页链接或 urlToken' }
        },
        runNotifications: () => {
          const { err } = requireLoggedIn()
          if (err) return err
          return { insert: '帮我调用 zhihu_notifications 工具查看我最近的知乎评论与回复通知，并整理出需要回复的重点。' }
        },
        runAnswerDraft: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const url = extractZhihuCandidate(scope.clipboard || '')
          if (url && /\/question\/\d+/i.test(url)) {
            return { insert: `帮我先阅读这个问题与高赞回答，再起草一篇高质量回答并用 zhihu_answer_draft 保存到草稿箱（不要发布）：${url}` }
          }
          return {
            insert: '帮我先阅读这个问题与高赞回答，再起草一篇高质量回答并用 zhihu_answer_draft 保存到草稿箱（不要发布）：',
            toast: '请在输入框后面粘贴知乎问题链接',
          }
        },
        runArticleDraft: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const clip = String(scope.clipboard || '').trim()
          const url = extractZhihuCandidate(clip)
          if (url && /zhuanlan\.zhihu\.com\/p\/\d+/i.test(url)) {
            return { insert: `帮我用 zhihu_article_draft 读取并完善这篇知乎专栏草稿（不要发布）：${url}` }
          }
          if (clip && clip.length <= 80 && !clip.includes('\n') && !/^https?:\/\//i.test(clip)) {
            return { insert: `帮我围绕这个主题写一篇知乎专栏文章，并用 zhihu_article_draft 保存到草稿箱（不要发布）：${clip}` }
          }
          return {
            insert: '帮我写一篇知乎专栏文章并用 zhihu_article_draft 保存到草稿箱（不要发布），主题/要求：',
            toast: '请在输入框后面填写文章主题或粘贴 /p/xxx/edit 草稿链接',
          }
        },
        runEval: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const clip = String(scope.clipboard || '').trim()
          const url = extractZhihuCandidate(clip)
          if (url) {
            return { insert: `帮我调用知乎工具评估这个收藏夹或盐选作品值不值得读：${url}` }
          }
          if (clip && clip.length <= 60 && !clip.includes('\n')) {
            return { insert: `帮我调用知乎工具评估这部盐选小说值不值得读：${clip}` }
          }
          return {
            insert: '帮我调用知乎工具评估这个收藏夹或盐选小说值不值得读：',
            toast: '请在输入框后面粘贴链接或小说名',
          }
        },
        runUrl: (scope) => {
          const { err } = requireLoggedIn()
          if (err) return err
          const url = extractZhihuCandidate(scope.clipboard || '')
          if (url) {
            return { insert: `帮我调用知乎工具读取并总结这个知乎链接：${url}` }
          }
          return {
            insert: '帮我调用知乎工具读取并总结这个知乎链接：',
            toast: '请在输入框后面粘贴知乎链接',
          }
        },
        openAccount: () => ({ open: 'panel:zhihu-account' }),
        copyRiskUrl: () => copyRiskUrlEffect(),
      },
    })

    c.dshGo.panel('zhihu-account', {
      view: (_scope, caps) => {
        const en = String(caps.locale || '').startsWith('en')
        return {
          type: 'stack',
          title: en ? 'Zhihu Account & Settings' : '知乎账号与设置',
          children: [
            { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
            {
              type: 'keyValue',
              items: [
                [en ? 'Active Account' : '当前账号', { $: 'data.activeName' }],
                [en ? 'Saved Accounts' : '已存账号数', { $: 'data.accountCount' }],
                [en ? 'Limits' : '抓取配置', { $: 'data.limitsSummary' }],
                [en ? 'Verify URL' : '风控验证链接', { $: 'data.riskUrl' }],
                [en ? 'Console URL' : '本地控制台', { $: 'data.consoleUrl' }],
              ],
            },
            {
              type: 'actions',
              items: [
                { label: en ? 'QR Login' : '扫码登录', icon: 'qr', action: 'startQr' },
                { label: en ? 'Check QR' : '查扫码结果', icon: 'refresh', action: 'pollQr' },
                { label: en ? 'Paste Cookie' : '导入剪贴板Cookie', icon: 'paste', action: 'importClipboard' },
                { label: en ? 'Copy Verify Link' : '复制验证链接', icon: 'copy', action: 'copyRiskUrl' },
              ],
            },
            { type: 'text', text: { $: 'data.qrHint' }, tone: 'muted' },
            { type: 'image', src: { $: 'data.qrImage' }, alt: en ? 'Zhihu QR' : '知乎扫码登录二维码', aspect: 1 },
            {
              type: 'list',
              items: { $: 'data.accountList' },
            },
            {
              type: 'actions',
              items: [
                { label: en ? 'Health Check' : '检测账号连通性', icon: 'check', action: 'checkHealth' },
                { label: en ? 'Clear Block' : '解除风控暂停', icon: 'refresh', action: 'unblock' },
                { label: en ? 'Remove Active' : '删除当前账号', icon: 'delete', action: 'removeActive' },
              ],
            },
          ],
        }
      },
      data: (_scope, emit) => {
        emit(accountSnapshot())
        return () => {}
      },
      actions: {
        startQr: () => ({
          pending: { label: '生成二维码', timeoutMs: 25_000 },
          result: async () => {
            const r = await startQrLogin({ useChromiumPrewarm: false })
            return { toast: r.status === 'waiting' ? '请扫二维码' : r.message, patch: accountSnapshot({ qrHint: r.message, qrImage: r.qrDataUrl || null }) }
          },
        }),
        pollQr: () => ({
          pending: { label: '查询扫码', timeoutMs: 15_000 },
          result: async () => {
            const r = await pollQrLogin()
            const snap = accountSnapshot({ qrHint: r.message, qrImage: r.qrDataUrl || null })
            return { toast: r.status === 'succeeded' ? '登录成功' : (r.status === 'risk_control' ? '需在控制台过验证' : r.message), patch: snap }
          },
        }),
        importClipboard: (scope) => {
          const clip = String(scope.clipboard || '').trim()
          if (!clip) return { toast: '剪贴板里没有 Cookie 内容' }
          return {
            pending: { label: '验证Cookie', timeoutMs: 15_000 },
            result: async () => {
              try {
                const acc = await verifyAndSaveCookieString(clip)
                return { toast: `已登录：${acc.name}`, patch: accountSnapshot({ qrHint: `已通过 Cookie 导入账号「${acc.name}」` }) }
              } catch (err) {
                return { toast: err?.message || 'Cookie 验证失败' }
              }
            },
          }
        },
        switchAccount: (_scope, event) => {
          const id = event?.value?.id || event?.value
          if (!id) return { toast: '未指定账号' }
          try {
            const acc = switchAccount(String(id))
            return { toast: `已切换：${acc.name}`, patch: accountSnapshot() }
          } catch (err) {
            return { toast: err?.message || '切换失败' }
          }
        },
        checkHealth: () => ({
          pending: { label: '检测连通性', timeoutMs: 15_000 },
          result: async () => {
            try {
              const acc = await checkActiveAccountHealth()
              return { toast: `账号正常：${acc.name}`, patch: accountSnapshot() }
            } catch (err) {
              return { toast: err?.message || '账号异常', patch: accountSnapshot() }
            }
          },
        }),
        unblock: () => {
          const active = getActiveAccount()
          if (!active) return { toast: '没有可恢复的账号' }
          setAccountBlocked(active.id, null)
          return { toast: '已解除暂停标记', patch: accountSnapshot() }
        },
        removeActive: () => {
          const active = getActiveAccount()
          if (!active) return { toast: '没有可删除的账号' }
          removeAccount(active.id)
          return { toast: `已删除：${active.name}`, patch: accountSnapshot() }
        },
        copyRiskUrl: () => copyRiskUrlEffect(),
      },
    })
  })
}
