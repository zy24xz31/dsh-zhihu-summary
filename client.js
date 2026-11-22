/**
 * dsh-zhihu-summary —— DSH 网页版客户端入口
 * 1) 设置 → 知乎总结 (settings.section)：账号管理、扫码/Cookie登录、抓取条数与字数上限设置
 * 2) 左侧主导航 → 知乎总结 (main + sidebar.panellist)：网页版一站式快捷入口与配置工作台
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhihu-summary',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'dsh-zhihu-summary'
    const API = '/zhihu/api'
    const CONSOLE_PATH = '/zhihu/console'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 未鉴权）' : res.status === 403 ? '（被宿主拦截）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const copyText = async (text) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* fallback */ }
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }

    const CSS = `
[data-lz-page]{display:flex;flex-direction:column;gap:16px;padding:4px 4px 16px;max-width:720px;color:var(--dsw-alias-label-primary,inherit);}
[data-lz-page][data-lz-main]{max-width:860px;margin:0 auto;padding:24px 20px 40px;height:100%;overflow-y:auto;box-sizing:border-box;}
[data-lz-card]{background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.2));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
[data-lz-h]{font-size:12px;font-weight:600;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#9aa0a6);text-transform:uppercase;}
[data-lz-title]{font-size:18px;font-weight:600;margin:0;}
[data-lz-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-lz-grow]{flex:1;min-width:0;}
[data-lz-note]{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-lz-badge]{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 9px;border-radius:999px;font-weight:500;}
[data-lz-badge="good"]{background:rgba(34,197,94,.15);color:#22c55e;}
[data-lz-badge="warn"]{background:rgba(245,158,11,.15);color:#f59e0b;}
[data-lz-badge="bad"]{background:rgba(239,68,68,.15);color:#ef4444;}
[data-lz-btn]{appearance:none;border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.28));background:var(--dsw-alias-bg-primary,transparent);color:inherit;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:opacity .12s,background .12s;}
[data-lz-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));}
[data-lz-btn]:disabled{opacity:.5;cursor:not-allowed;}
[data-lz-btn="primary"]{background:#0066ff;border-color:#0066ff;color:#fff;}
[data-lz-btn="primary"]:hover{background:#0055d6;}
[data-lz-btn="danger"]{border-color:rgba(239,68,68,.45);color:#ef4444;}
[data-lz-input]{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.28));background:var(--dsw-alias-bg-primary,rgba(0,0,0,.04));color:inherit;border-radius:8px;padding:7px 10px;font-size:13px;outline:none;}
[data-lz-input]:focus{border-color:#0066ff;}
[data-lz-grid]{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;}
[data-lz-field]{display:flex;flex-direction:column;gap:4px;}
[data-lz-field] label{font-size:12px;font-weight:500;}
[data-lz-acc]{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-primary,rgba(128,128,128,.06));border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.16));}
[data-lz-qr]{width:180px;height:180px;border-radius:10px;background:#fff;padding:8px;box-sizing:border-box;border:1px solid rgba(128,128,128,.2);}
[data-lz-toast]{font-size:12px;padding:8px 12px;border-radius:8px;background:rgba(0,102,255,.14);color:#60a5fa;border:1px solid rgba(0,102,255,.3);}
[data-lz-toast="err"]{background:rgba(239,68,68,.14);color:#f87171;border-color:rgba(239,68,68,.3);}
[data-lz-tabs]{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.2));padding-bottom:8px;}
[data-lz-tab]{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:6px 12px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;}
[data-lz-tab][data-active="1"]{background:rgba(0,102,255,.16);color:#60a5fa;}
`

    const ensureStyles = () => {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-zhihu-summary-client-css')) return
      const el = document.createElement('style')
      el.id = 'dsh-zhihu-summary-client-css'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    const SETTING_FIELDS = [
      { key: 'homeLimit', label: '主页推荐条数', note: '1–20 条（默认 10）', min: 1, max: 20 },
      { key: 'homeMaxChars', label: '主页单条字数上限', note: '1,000–100,000 字（默认 15,000）', min: 1000, max: 100000 },
      { key: 'hotQuestions', label: '热榜抓取问题数', note: '1–20 题（默认 5）', min: 1, max: 20 },
      { key: 'hotAnswersPerQuestion', label: '热榜每题回答数', note: '1–10 个（默认 3）', min: 1, max: 10 },
      { key: 'hotMaxChars', label: '热榜单回答字数上限', note: '1,000–100,000 字（默认 10,000）', min: 1000, max: 100000 },
      { key: 'yanxuanTrialMaxChars', label: '盐选试读每章字数上限', note: '3,000–100,000 字（默认 15,000）', min: 3000, max: 100000 },
      { key: 'readUrlMaxChars', label: '指定链接单次字数上限', note: '5,000–200,000 字（默认 60,000）', min: 5000, max: 200000 },
      { key: 'maxImagesPerItem', label: '单篇最多拉取图片数', note: '1–15 张（默认 4）', min: 1, max: 15 },
    ]

    function useZhihuState() {
      const [loading, setLoading] = React.useState(true)
      const [accounts, setAccounts] = React.useState([])
      const [activeId, setActiveId] = React.useState('')
      const [settings, setSettings] = React.useState({
        homeLimit: 10,
        homeMaxChars: 15000,
        hotQuestions: 5,
        hotAnswersPerQuestion: 3,
        hotMaxChars: 10000,
        yanxuanTrialMaxChars: 15000,
        readUrlMaxChars: 60000,
        imageReadMode: 'index',
        maxImagesPerItem: 4,
      })
      const [toast, setToast] = React.useState(null)

      const flash = React.useCallback((msg, isErr) => {
        setToast({ msg, isErr: Boolean(isErr) })
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const data = await jget('/status')
          if (data && data.ok) {
            setAccounts(Array.isArray(data.accounts) ? data.accounts : [])
            setActiveId(data.activeId || '')
            if (data.settings) setSettings(data.settings)
          }
        } catch (err) {
          flash('读取知乎插件状态失败：' + (err?.message || err), true)
        } finally {
          setLoading(false)
        }
      }, [flash])

      React.useEffect(() => { refresh() }, [refresh])

      const active = accounts.find((a) => a.id === activeId) || accounts.find((a) => a.active) || null
      return { loading, accounts, activeId, active, settings, setSettings, toast, flash, refresh }
    }

    function SettingsSection({ state, embedded }) {
      const { accounts, active, settings, setSettings, toast, flash, refresh } = state
      const [draft, setDraft] = React.useState(settings)
      const [saving, setSaving] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [cookieText, setCookieText] = React.useState('')
      const [qr, setQr] = React.useState(null)
      const pollRef = React.useRef(null)

      React.useEffect(() => { setDraft(settings) }, [settings])
      React.useEffect(() => () => {
        if (pollRef.current) clearInterval(pollRef.current)
      }, [])

      const saveSettings = async (reset) => {
        setSaving(true)
        try {
          const res = await jpost('/config', reset ? { reset: true } : { settings: draft })
          if (!res.ok) throw new Error(res.error || '保存失败')
          setSettings(res.settings)
          setDraft(res.settings)
          flash(reset ? '已恢复默认配置' : '配置已保存并立即生效')
        } catch (err) {
          flash(err?.message || '保存失败', true)
        } finally {
          setSaving(false)
        }
      }

      const startQr = async () => {
        setBusy(true)
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        try {
          const res = await jpost('/qr/start', { useChromiumPrewarm: false })
          if (!res.ok) throw new Error(res.error || '获取二维码失败')
          setQr(res)
          flash(res.message || '请使用知乎 App 扫码')
          if (res.id) {
            pollRef.current = setInterval(async () => {
              try {
                const p = await jget('/qr/poll?id=' + encodeURIComponent(res.id))
                setQr((prev) => ({ ...(prev || {}), ...p }))
                if (p.status === 'succeeded') {
                  clearInterval(pollRef.current); pollRef.current = null
                  flash('扫码登录成功')
                  refresh()
                } else if (p.status === 'expired' || p.status === 'failed' || p.status === 'risk_control') {
                  clearInterval(pollRef.current); pollRef.current = null
                  flash(p.message || '扫码结束', p.status !== 'succeeded')
                }
              } catch { /* ignore transient */ }
            }, 2500)
          }
        } catch (err) {
          flash(err?.message || '获取二维码失败', true)
        } finally {
          setBusy(false)
        }
      }

      const importCookie = async () => {
        if (!cookieText.trim()) return flash('请先粘贴包含 z_c0 的 Cookie', true)
        setBusy(true)
        try {
          const res = await jpost('/cookie-login', { cookie: cookieText.trim() })
          if (!res.ok) throw new Error(res.error || 'Cookie 验证失败')
          setCookieText('')
          flash('Cookie 登录成功：' + (res.account?.name || ''))
          refresh()
        } catch (err) {
          flash(err?.message || 'Cookie 导入失败', true)
        } finally {
          setBusy(false)
        }
      }

      const runAction = async (path, body, okMsg) => {
        setBusy(true)
        try {
          const res = await jpost(path, body || {})
          if (!res.ok) throw new Error(res.error || '操作失败')
          flash(okMsg)
          refresh()
        } catch (err) {
          flash(err?.message || '操作失败', true)
        } finally {
          setBusy(false)
        }
      }

      const badgeTone = !active ? 'warn' : (active.blocked ? 'bad' : 'good')
      const badgeText = !active
        ? '未登录'
        : (active.blocked ? ('风控暂停：' + (active.blocked.message || '需人机验证')) : ('已登录：' + active.name + (active.isVip ? '（盐选会员）' : '')))

      return h('div', { 'data-lz-page': '' },
        !embedded && h('div', { 'data-lz-row': '' },
          h('h3', { 'data-lz-title': '', 'data-lz-grow': '' }, '知乎总结插件设置'),
          h('a', { 'data-lz-btn': '', href: CONSOLE_PATH, target: '_blank', rel: 'noreferrer' }, '打开独立控制台 ↗')
        ),
        toast && h('div', { 'data-lz-toast': toast.isErr ? 'err' : '' }, toast.msg),

        /* 1. 抓取与字数上限设置 */
        h('div', { 'data-lz-card': '' },
          h('div', { 'data-lz-row': '' },
            h('div', { 'data-lz-h': '', 'data-lz-grow': '' }, '抓取条数与字数上限'),
            h('button', { 'data-lz-btn': '', disabled: saving, onClick: () => saveSettings(true) }, '恢复默认'),
            h('button', { 'data-lz-btn': 'primary', disabled: saving, onClick: () => saveSettings(false) }, saving ? '保存中…' : '保存设置')
          ),
          h('div', { 'data-lz-grid': '' },
            h('div', { 'data-lz-field': '' },
              h('label', null, '正文读图模式'),
              h('select', {
                'data-lz-input': '',
                value: draft.imageReadMode || 'index',
                onChange: (e) => setDraft((prev) => ({ ...prev, imageReadMode: e.target.value })),
              },
                h('option', { value: 'index' }, '按需读图（默认，保留 [图N] 索引）'),
                h('option', { value: 'auto' }, '自动拉图（读单篇链接自动下载前 N 张）'),
                h('option', { value: 'off' }, '关闭读图（纯文字，仍还原数学公式）')
              ),
              h('div', { 'data-lz-note': '' }, '按需模式省流量，聊天时也可临时要求 AI 看图')
            ),
            SETTING_FIELDS.map((f) => h('div', { key: f.key, 'data-lz-field': '' },
              h('label', null, f.label),
              h('input', {
                'data-lz-input': '',
                type: 'number',
                min: f.min,
                max: f.max,
                value: draft[f.key] ?? '',
                onChange: (e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value })),
              }),
              h('div', { 'data-lz-note': '' }, f.note)
            ))
          )
        ),

        /* 2. 账号状态与管理 */
        h('div', { 'data-lz-card': '' },
          h('div', { 'data-lz-row': '' },
            h('div', { 'data-lz-h': '', 'data-lz-grow': '' }, '知乎账号管理'),
            h('span', { 'data-lz-badge': badgeTone }, badgeText)
          ),
          h('div', { 'data-lz-row': '' },
            h('button', { 'data-lz-btn': '', disabled: busy, onClick: () => runAction('/account/check', {}, '账号连通正常') }, '检测连通性'),
            active && active.blocked && h('button', { 'data-lz-btn': '', disabled: busy, onClick: () => runAction('/account/unblock', { id: active.id }, '已解除风控暂停标记') }, '解除风控暂停'),
            h('button', { 'data-lz-btn': '', disabled: busy, onClick: startQr }, '扫码登录'),
            h('a', { 'data-lz-btn': '', href: CONSOLE_PATH, target: '_blank', rel: 'noreferrer' }, '风控人机验证台 ↗')
          ),
          qr && qr.qrDataUrl && h('div', { 'data-lz-row': '' },
            h('img', { 'data-lz-qr': '', src: qr.qrDataUrl, alt: '知乎扫码登录' }),
            h('div', { 'data-lz-grow': '', 'data-lz-note': '' }, qr.message || '请打开知乎 App 扫描二维码')
          ),
          accounts.length > 0 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            accounts.map((a) => h('div', { key: a.id, 'data-lz-acc': '' },
              h('div', { 'data-lz-grow': '' },
                h('div', { style: { fontSize: '13px', fontWeight: 500 } }, a.name + (a.isVip ? ' · 盐选' : '') + (a.active ? '（当前）' : '')),
                h('div', { 'data-lz-note': '' }, a.blocked ? ('风控暂停：' + (a.blocked.message || '需验证')) : (a.urlToken ? '@' + a.urlToken : a.id))
              ),
              h('div', { 'data-lz-row': '' },
                !a.active && h('button', { 'data-lz-btn': '', disabled: busy, onClick: () => runAction('/account/switch', { id: a.id }, '已切换账号：' + a.name) }, '切换'),
                h('button', { 'data-lz-btn': 'danger', disabled: busy, onClick: () => runAction('/account/delete', { id: a.id }, '已删除账号：' + a.name) }, '删除')
              )
            ))
          ),
          h('div', { 'data-lz-field': '' },
            h('label', null, '粘贴 Cookie 导入（需含 z_c0）'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '180px' },
                type: 'password',
                placeholder: '粘贴浏览器请求头中的 Cookie 字符串…',
                value: cookieText,
                onChange: (e) => setCookieText(e.target.value),
              }),
              h('button', { 'data-lz-btn': 'primary', disabled: busy, onClick: importCookie }, '验证并保存')
            )
          )
        )
      )
    }

    function SettingsPanel() {
      ensureStyles()
      const state = useZhihuState()
      return h(SettingsSection, { state, embedded: false })
    }

    function MainWorkspace() {
      ensureStyles()
      const state = useZhihuState()
      const { active, settings, toast, flash } = state
      const [tab, setTab] = React.useState('quick')
      const [evalTarget, setEvalTarget] = React.useState('')
      const [readUrl, setReadUrl] = React.useState('')
      const [searchQuery, setSearchQuery] = React.useState('')
      const [collectionName, setCollectionName] = React.useState('')
      const [commentUrl, setCommentUrl] = React.useState('')
      const [commentOrder, setCommentOrder] = React.useState('normal')
      const [questionUrl, setQuestionUrl] = React.useState('')
      const [questionOrder, setQuestionOrder] = React.useState('default')
      const [memberTarget, setMemberTarget] = React.useState('')
      const [notifCategory, setNotifCategory] = React.useState('comments')
      const [draftQuestionUrl, setDraftQuestionUrl] = React.useState('')
      const [articleDraftInput, setArticleDraftInput] = React.useState('')

      const copyPrompt = async (prompt) => {
        const ok = await copyText(prompt)
        flash(ok ? '已复制提示词，切回对话粘贴发送即可' : '复制失败，请手动复制：' + prompt, !ok)
      }

      const badgeTone = !active ? 'warn' : (active.blocked ? 'bad' : 'good')
      const badgeText = !active
        ? '未登录（请先在下方设置登录）'
        : (active.blocked ? '风控暂停（需打开控制台验证）' : ('当前账号：' + active.name))

      return h('div', { 'data-lz-page': '', 'data-lz-main': '' },
        h('div', { 'data-lz-row': '' },
          h('h2', { 'data-lz-title': '', 'data-lz-grow': '' }, '知乎总结工作台'),
          h('span', { 'data-lz-badge': badgeTone }, badgeText),
          h('a', { 'data-lz-btn': '', href: CONSOLE_PATH, target: '_blank', rel: 'noreferrer' }, '独立控制台 ↗')
        ),
        h('div', { 'data-lz-tabs': '' },
          h('button', { 'data-lz-tab': '', 'data-active': tab === 'quick' ? '1' : '0', onClick: () => setTab('quick') }, '快捷入口'),
          h('button', { 'data-lz-tab': '', 'data-active': tab === 'settings' ? '1' : '0', onClick: () => setTab('settings') }, '账号与设置')
        ),
        toast && h('div', { 'data-lz-toast': toast.isErr ? 'err' : '' }, toast.msg),

        tab === 'quick' ? h(React.Fragment, null,
          h('div', { 'data-lz-note': '' },
            '提示：直接在任意对话里发知乎链接或说“总结知乎主页/热榜”也会自动调用工具；这里提供一键生成标准指令和调整字数上限。'
          ),
          h('div', { 'data-lz-grid': '' },
            h('div', { 'data-lz-card': '' },
              h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '主页推荐总结'),
              h('div', { 'data-lz-note': '' }, `抓取前 ${settings.homeLimit} 条非付费内容（单条上限 ${settings.homeMaxChars} 字）`),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => copyPrompt(`帮我调用知乎工具总结主页推荐前${settings.homeLimit}条非付费内容。`),
              }, '复制指令')
            ),
            h('div', { 'data-lz-card': '' },
              h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '知乎热榜总结'),
              h('div', { 'data-lz-note': '' }, `前 ${settings.hotQuestions} 题 × 每题 ${settings.hotAnswersPerQuestion} 个高赞回答（单回答上限 ${settings.hotMaxChars} 字）`),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => copyPrompt(`帮我调用知乎工具总结当前知乎热榜前${settings.hotQuestions}个问题（每题至少读${settings.hotAnswersPerQuestion}个回答）。`),
              }, '复制指令')
            ),
            h('div', { 'data-lz-card': '' },
              h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '关注动态流'),
              h('div', { 'data-lz-note': '' }, '拉取关注的人赞同、回答或想法，自动过滤广告与付费内容'),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => copyPrompt('帮我调用 zhihu_follow 工具读取我关注的知乎用户最新动态并总结重点。'),
              }, '复制指令')
            ),
            h('div', { 'data-lz-card': '' },
              h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '我的收藏夹'),
              h('div', { 'data-lz-note': '' }, '列出收藏夹，或输入名称（如“待看”）读取/整理条目'),
              h('div', { 'data-lz-row': '' },
                h('input', {
                  'data-lz-input': '',
                  style: { flex: 1, minWidth: '120px' },
                  placeholder: '可选：收藏夹名称或 ID…',
                  value: collectionName,
                  onChange: (e) => setCollectionName(e.target.value),
                }),
                h('button', {
                  'data-lz-btn': 'primary',
                  onClick: () => {
                    const v = collectionName.trim()
                    copyPrompt(v ? `帮我调用 zhihu_collections 工具读取收藏夹「${v}」的内容并总结。` : '帮我调用 zhihu_collections 工具列出我的知乎收藏夹。')
                  },
                }, '复制指令')
              )
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '通知与评论收件箱'),
            h('div', { 'data-lz-note': '' }, '查看谁回复/评论了你、谁邀请你回答或赞同了你，自动跨页筛掉噪音'),
            h('div', { 'data-lz-row': '' },
              h('select', {
                'data-lz-input': '',
                style: { width: 'auto', minWidth: '130px' },
                value: notifCategory,
                onChange: (e) => setNotifCategory(e.target.value),
              },
                h('option', { value: 'comments' }, '评论与回复'),
                h('option', { value: 'invites' }, '回答邀请'),
                h('option', { value: 'likes' }, '赞同与感谢'),
                h('option', { value: 'follows' }, '新关注'),
                h('option', { value: 'all' }, '全部通知'),
                h('option', { value: 'summary' }, '未读总览')
              ),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => copyPrompt(`帮我调用 zhihu_notifications 工具（category: "${notifCategory}"）查看我最近的知乎通知并整理重点。`),
              }, '复制查通知指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '代答存草稿（审后手动发）'),
            h('div', { 'data-lz-note': '' }, '自动将 Markdown 转为知乎富文本 HTML 存入该问题草稿箱，默认防覆盖、绝不自动发布'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '粘贴知乎问题链接或问题 ID…',
                value: draftQuestionUrl,
                onChange: (e) => setDraftQuestionUrl(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = draftQuestionUrl.trim()
                  copyPrompt(v ? `帮我先阅读这个问题与高赞回答，再起草一篇高质量回答并用 zhihu_answer_draft 保存到草稿箱（不要发布）：${v}` : '帮我先阅读这个问题与高赞回答，再起草一篇高质量回答并用 zhihu_answer_draft 保存到草稿箱（不要发布）：')
                },
              }, '复制代答草稿指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '写专栏文章存草稿（审后手动发）'),
            h('div', { 'data-lz-note': '' }, '将 Markdown 文章自动转为知乎富文本并保存到专栏草稿箱，支持查草稿、防覆盖、绝不自动发布'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '输入文章主题/标题，或粘贴 /p/xxx/edit 草稿链接…',
                value: articleDraftInput,
                onChange: (e) => setArticleDraftInput(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = articleDraftInput.trim()
                  if (/zhuanlan\.zhihu\.com\/p\/\d+|^\d{10,}$/i.test(v)) {
                    copyPrompt(`帮我用 zhihu_article_draft 读取并完善这篇知乎专栏草稿（不要发布）：${v}`)
                  } else {
                    copyPrompt(v ? `帮我围绕这个主题写一篇知乎专栏文章，并用 zhihu_article_draft 保存到草稿箱（不要发布）：${v}` : '帮我写一篇知乎专栏文章并用 zhihu_article_draft 保存到草稿箱（不要发布），主题/要求：')
                  }
                },
              }, '复制写文章指令'),
              h('button', {
                'data-lz-btn': '',
                onClick: () => copyPrompt('帮我调用 zhihu_article_draft（action: "list"）查看我的知乎文章草稿列表。'),
              }, '查看文章草稿箱')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '知乎综合搜索'),
            h('div', { 'data-lz-note': '' }, '走签名 search_v3 接口搜索回答、文章与问题'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '输入搜索关键词…',
                value: searchQuery,
                onChange: (e) => setSearchQuery(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = searchQuery.trim()
                  copyPrompt(v ? `帮我调用 zhihu_search 工具搜索知乎并总结高赞结果：${v}` : '帮我调用 zhihu_search 工具搜索知乎并总结高赞结果：')
                },
              }, '复制搜索指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '读取问题回答列表（支持排序与翻页）'),
            h('div', { 'data-lz-note': '' }, '支持按默认热度或最新发布读取问题下的多个回答，并用游标继续翻页'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '180px' },
                placeholder: '粘贴知乎问题链接或问题 ID…',
                value: questionUrl,
                onChange: (e) => setQuestionUrl(e.target.value),
              }),
              h('select', {
                'data-lz-input': '',
                style: { width: 'auto', minWidth: '115px' },
                value: questionOrder,
                onChange: (e) => setQuestionOrder(e.target.value),
              },
                h('option', { value: 'default' }, '默认热度'),
                h('option', { value: 'updated' }, '最新发布')
              ),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = questionUrl.trim()
                  const ord = questionOrder === 'updated' ? '按最新发布时间' : '按默认热度'
                  copyPrompt(v ? `帮我调用 zhihu_question_answers 工具（${ord}）读取这个问题的回答列表：${v}` : `帮我调用 zhihu_question_answers 工具（${ord}）读取这个问题的回答列表：`)
                },
              }, '复制指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '读取评论区（热评 / 最新 / 楼中楼）'),
            h('div', { 'data-lz-note': '' }, '支持回答、专栏文章、想法和问题链接'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '180px' },
                placeholder: '粘贴知乎回答 / 文章 / 想法链接…',
                value: commentUrl,
                onChange: (e) => setCommentUrl(e.target.value),
              }),
              h('select', {
                'data-lz-input': '',
                style: { width: 'auto', minWidth: '105px' },
                value: commentOrder,
                onChange: (e) => setCommentOrder(e.target.value),
              },
                h('option', { value: 'normal' }, '按热评'),
                h('option', { value: 'ts' }, '按最新')
              ),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = commentUrl.trim()
                  const ord = commentOrder === 'ts' ? '最新' : '热评'
                  copyPrompt(v ? `帮我调用 zhihu_comments 工具读取这个知乎链接的${ord}评论区与子回复：${v}` : `帮我调用 zhihu_comments 工具读取这个知乎链接的${ord}评论区：`)
                },
              }, '复制读评指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '查看答主主页与代表作'),
            h('div', { 'data-lz-note': '' }, '读取用户简介、统计、近期动态及高赞作品'),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '粘贴知乎用户主页链接(/people/xxx)或 urlToken…',
                value: memberTarget,
                onChange: (e) => setMemberTarget(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = memberTarget.trim()
                  copyPrompt(v ? `帮我调用 zhihu_member 工具查看该知乎答主的主页简介、近期动态与代表作：${v}` : '帮我调用 zhihu_member 工具查看知乎答主主页：')
                },
              }, '复制查答主指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '评估收藏夹 / 专栏 / 盐选小说'),
            h('div', { 'data-lz-note': '' }, `盐选试读每章上限当前为 ${settings.yanxuanTrialMaxChars} 字（可在「账号与设置」调整）`),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '粘贴收藏夹 / 专栏 / 盐选链接，或输入盐选小说名…',
                value: evalTarget,
                onChange: (e) => setEvalTarget(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = evalTarget.trim()
                  copyPrompt(v ? `帮我调用知乎工具评估这个收藏夹或盐选作品值不值得读：${v}` : '帮我调用知乎工具评估这个收藏夹或盐选小说值不值得读：')
                },
              }, '复制评估指令')
            )
          ),
          h('div', { 'data-lz-card': '' },
            h('div', { style: { fontWeight: 600, fontSize: '14px' } }, '读取并总结指定知乎链接'),
            h('div', { 'data-lz-note': '' }, `单次上限 ${settings.readUrlMaxChars} 字，超长长文支持自动分段续读`),
            h('div', { 'data-lz-row': '' },
              h('input', {
                'data-lz-input': '',
                style: { flex: 1, minWidth: '200px' },
                placeholder: '粘贴知乎回答 / 专栏文章 / 问题 / 分享短链…',
                value: readUrl,
                onChange: (e) => setReadUrl(e.target.value),
              }),
              h('button', {
                'data-lz-btn': 'primary',
                onClick: () => {
                  const v = readUrl.trim()
                  copyPrompt(v ? `帮我调用知乎工具读取并总结这个知乎链接：${v}` : '帮我调用知乎工具读取并总结这个知乎链接：')
                },
              }, '复制总结指令')
            )
          )
        ) : h(SettingsSection, { state, embedded: true })
      )
    }

    function SidebarIcon() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15.5a1 1 0 0 1-1 1H6.5A2.5 2.5 0 0 1 4 18V5.5Z' }),
        h('path', { d: 'M8 8h8' }),
        h('path', { d: 'M8 12h8' }),
        h('path', { d: 'M8 16h5' })
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || (ctx && ctx.slots)
        if (!slots) return
        ensureStyles()

        const stops = [
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: PANEL_ID, order: 55, label: '知乎总结' },
            () => h(SettingsPanel)
          )),
          slots.inject('main', () => slots.register(
            { name: 'main', key: PANEL_ID },
            MainWorkspace
          )),
          slots.inject('sidebar.panellist', () => slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 35, label: '知乎总结' },
            SidebarIcon
          )),
        ]

        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            for (const stop of stops) {
              try { if (typeof stop === 'function') stop() } catch { /* ignore */ }
            }
          })
        }
      },
    }
  },
})
