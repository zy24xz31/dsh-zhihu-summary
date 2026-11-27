import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { signHeaders } from './sign.js'
import {
  cleanHtml,
  cleanupImageCache,
  decodeHtmlEntities,
  downloadZhihuImages,
  extractHtmlWithImages,
  isAllowedZhimgUrl,
  normalizeZhihuImgUrl,
  resolveImageMode,
} from './images.js'
export {
  cleanHtml,
  cleanupImageCache,
  decodeHtmlEntities,
  downloadZhihuImages,
  extractHtmlWithImages,
  isAllowedZhimgUrl,
  resolveImageMode,
}
import {
  DEFAULT_UA,
  cookieHeader,
  getActiveAccount,
  parseCookieString,
  parseSingleSetCookie,
  readArticleDraftIndex,
  readSettings,
  readStore,
  removeArticleDraftIndex,
  sanitizeCookies,
  setAccountBlocked,
  updateAccountCookies,
  upsertAccount,
  upsertArticleDraftIndex,
} from './store.js'

const ORIGIN = 'https://www.zhihu.com'
const ZHUANLAN = 'https://zhuanlan.zhihu.com'

function findChromiumExecutable() {
  const candidates = []
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p) }
  push(process.env.DSH_CHROME_PATH)
  push(process.env.CHROME_PATH)
  push(process.env.PUPPETEER_EXECUTABLE_PATH)

  const home = homedir()
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    push(join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push(join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    push(join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    const pwDir = join(local, 'ms-playwright')
    try {
      for (const d of readdirSync(pwDir)) {
        if (/^chromium/i.test(d)) {
          push(join(pwDir, d, 'chrome-win64', 'chrome.exe'))
          push(join(pwDir, d, 'chrome-win', 'chrome.exe'))
        }
      }
    } catch { /* ignore */ }
  } else if (process.platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    const pwDir = join(home, '.cache', 'ms-playwright')
    try {
      for (const d of readdirSync(pwDir)) {
        if (/^chromium/i.test(d)) {
          push(join(pwDir, d, 'chrome-linux', 'chrome'))
          push(join(pwDir, d, 'chrome-linux64', 'chrome'))
        }
      }
    } catch { /* ignore */ }
    push(join(home, '.dsh', 'aistudio', 'runtime', 'camoufox', 'browser', 'chrome'))
    push('/usr/bin/google-chrome')
    push('/usr/bin/chromium')
    push('/usr/bin/chromium-browser')
  }
  return candidates.find((p) => existsSync(p)) || ''
}

export const CONSOLE_URL = `${process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'}/zhihu/console`

export class ZhihuError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ZhihuError'
    this.code = code
    this.detail = detail
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function jitterDelay(min = 600, max = 1200) {
  return sleep(min + Math.floor(Math.random() * (max - min + 1)))
}

function buildImageFields(images, maxList = 8) {
  if (!Array.isArray(images) || images.length === 0) return {}
  return {
    imageCount: images.length,
    images: images.slice(0, maxList),
  }
}

function extractPinImages(p) {
  const out = []
  const seen = new Set()
  const arr = Array.isArray(p?.content) ? p.content : []
  for (const seg of arr) {
    if (!seg || seg.type !== 'image') continue
    const url = normalizeZhihuImgUrl(seg.url || seg.original_url)
    const orig = normalizeZhihuImgUrl(seg.original_url || seg.url)
    if (!url) continue
    const key = url.split('?')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      index: out.length + 1,
      url,
      ...(orig && orig !== url ? { originalUrl: orig } : {}),
    })
  }
  return out
}

function sliceText(fullText, { offset = 0, maxChars = 60000 } = {}) {
  const text = String(fullText || '')
  const totalLength = text.length
  const start = Math.max(0, Math.min(totalLength, Math.trunc(Number(offset) || 0)))
  const limit = Math.max(1000, Math.min(200000, Math.trunc(Number(maxChars) || 60000)))
  const content = text.slice(start, start + limit)
  const nextOffset = start + content.length
  const truncated = nextOffset < totalLength
  return {
    content,
    totalLength,
    offset: start,
    nextOffset: truncated ? nextOffset : null,
    truncated,
  }
}

export function extractUrlFromText(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const m = raw.match(/https?:\/\/[^\s<>"'\])]+/i)
  return m ? m[0].replace(/[.,;!?，。；！？]+$/, '') : raw
}

function parseSetCookies(res) {
  const out = {}
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const line of list) {
    Object.assign(out, parseSingleSetCookie(line))
  }
  return out
}

function buildHeaders(url, account, extra = {}, body = '') {
  const dc0 = account?.cookies?.d_c0 || ''
  const signed = signHeaders(url, dc0, body, account?.cookies?.['x-zst-81'] || '')
  const ua = account?.userAgent || DEFAULT_UA
  const cookie = cookieHeader(account?.cookies)
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': `${ORIGIN}/`,
    'Origin': ORIGIN,
    ...signed,
    ...extra,
  }
  if (account?.cookies?._xsrf) headers['x-xsrftoken'] = account.cookies._xsrf
  if (cookie) headers['Cookie'] = cookie
  return headers
}

function requireActiveAccount() {
  const acc = getActiveAccount()
  if (!acc || !acc.cookies?.z_c0) {
    throw new ZhihuError('NO_ACCOUNT', `还没有登录知乎账号。请先打开知乎控制台完成登录：${CONSOLE_URL}`, { consoleUrl: CONSOLE_URL })
  }
  return acc
}

function parseZhihuJson(text) {
  if (!text) return null
  return JSON.parse(text, (_k, v, ctx) => {
    if (
      typeof v === 'number' &&
      !Number.isSafeInteger(v) &&
      ctx?.source &&
      /^-?\d+$/.test(ctx.source)
    ) {
      return ctx.source
    }
    return v
  })
}

async function zhihuFetchJson(url, { account, method = 'GET', body, extraHeaders = {}, timeoutMs = 15000, allowEmpty = false, allowBlocked = false } = {}) {
  const acc = account || requireActiveAccount()
  if (!allowBlocked && acc?.blocked && ['LOGIN_REQUIRED', 'RATE_LIMITED'].includes(acc.blocked.code)) {
    throw new ZhihuError(
      acc.blocked.code,
      `当前账号「${acc.name}」已暂停请求（${acc.blocked.message || acc.blocked.code}）。请打开 ${CONSOLE_URL} 处理或点击「检测连通性」恢复。`,
      { consoleUrl: CONSOLE_URL, blocked: acc.blocked }
    )
  }
  const headers = buildHeaders(url, acc, extraHeaders, body)
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
      redirect: 'manual',
    })
  } catch (err) {
    throw new ZhihuError('NETWORK_ERROR', `请求知乎失败：${err?.message || '网络超时'}`, { url })
  } finally {
    clearTimeout(timer)
  }

  const freshCookies = parseSetCookies(res)
  if (Object.keys(freshCookies).length && acc?.id && readStore().accounts[acc.id]) {
    updateAccountCookies(acc.id, freshCookies)
    Object.assign(acc.cookies, freshCookies)
  }

  const text = await res.text()
  let data = null
  try { data = parseZhihuJson(text) } catch { /* non-JSON */ }
  const errCode = Number(data?.error?.code)
  const redirect = data?.error?.redirect || ''

  if (res.status === 401 || errCode === 100 || errCode === 401) {
    if (acc?.id) setAccountBlocked(acc.id, { code: 'LOGIN_REQUIRED', message: '登录凭证已失效，请重新登录', redirect: `${ORIGIN}/signin` })
    throw new ZhihuError('LOGIN_REQUIRED', `知乎登录态已失效（HTTP ${res.status}），请打开 ${CONSOLE_URL} 重新扫码或更新 Cookie。`, { httpStatus: res.status, consoleUrl: CONSOLE_URL })
  }
  if (res.status === 429) {
    if (acc?.id) setAccountBlocked(acc.id, { code: 'RATE_LIMITED', message: '请求过于频繁，已自动暂停', redirect: '' })
    throw new ZhihuError('RATE_LIMITED', `知乎限流（HTTP 429），已立即暂停请求以保护账号。请稍后再点「恢复访问」。`, { httpStatus: 429, consoleUrl: CONSOLE_URL })
  }
  if (errCode === 10003) {
    throw new ZhihuError('API_PARAMS_REJECTED', `知乎接口拒绝了当前请求签名或参数（错误码 10003）：${data?.error?.message || '请求参数异常'}`, { httpStatus: res.status, errCode: 10003 })
  }
  if (res.status === 403 || [40352, 40362, 62, 10001, 10002].includes(errCode) || /unhuman|zh-zse-ck|安全验证/.test(text.slice(0, 800))) {
    const msg = data?.error?.message || (res.status === 403 ? '知乎触发了安全/环境验证' : `错误码 ${errCode}`)
    const riskRedirect = normalizeRiskUrl(redirect, text)
    if (acc?.id) setAccountBlocked(acc.id, { code: 'RISK_CONTROL', message: msg, redirect: riskRedirect })
    throw new ZhihuError(
      'RISK_CONTROL',
      `触发知乎安全验证（HTTP ${res.status}${Number.isFinite(errCode) && errCode ? `，错误码 ${errCode}` : ''}）：${msg}。请打开 ${riskRedirect} 或控制台 ${CONSOLE_URL} 完成人机验证后重试。`,
      { httpStatus: res.status, errCode: Number.isFinite(errCode) ? errCode : null, redirect: riskRedirect, consoleUrl: CONSOLE_URL }
    )
  }
  if (res.status >= 400) {
    throw new ZhihuError('HTTP_ERROR', `知乎接口异常（HTTP ${res.status}）${data?.error?.message ? '：' + data.error.message : ''}`, { httpStatus: res.status })
  }
  const emptyOk = res.status === 204 || (allowEmpty && !text.trim())
  if (!data && !emptyOk) {
    throw new ZhihuError('HTTP_ERROR', `知乎接口返回非 JSON 内容（HTTP ${res.status}）`, { httpStatus: res.status })
  }
  if (acc?.blocked && acc?.id) {
    setAccountBlocked(acc.id, null)
    acc.blocked = null
  }
  return data || {}
}

async function fetchArticleJson(pid, acc) {
  try {
    return await zhihuFetchJson(`${ORIGIN}/api/v4/articles/${pid}?include=content,voteup_count,comment_count,author,title,excerpt`, { account: acc })
  } catch {
    return await zhihuFetchJson(`${ZHUANLAN}/api/articles/${pid}`, { account: acc })
  }
}

function isDisallowedShortLinkHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true
  const m172 = h.match(/^172\.(\d{1,3})\./)
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true
  if (/^(fc|fd|fe80)/i.test(h)) return true
  return false
}

function isAllowedShortLinkHost(hostname) {
  if (isDisallowedShortLinkHost(hostname)) return false
  const h = String(hostname || '').trim().toLowerCase()
  return /(^|\.)zhihu\.com$/i.test(h) || /(^|\.)zhihu\.app\.link$/i.test(h) || /^(t\.cn|url\.cn|dwz\.cn|bit\.ly|b23\.tv)$/i.test(h)
}

export async function resolveFinalUrl(inputUrl, account = null) {
  const cleaned = extractUrlFromText(inputUrl)
  if (!cleaned) throw new ZhihuError('BAD_INPUT', '请提供有效的知乎链接')
  let u
  try { u = new URL(cleaned) } catch { return { url: cleaned, isUrl: false } }
  if (!/^https?:$/.test(u.protocol)) throw new ZhihuError('BAD_INPUT', '仅支持 http/https 链接')
  if (isDisallowedShortLinkHost(u.hostname)) {
    throw new ZhihuError('BAD_INPUT', `拒绝访问内网或受限地址：${u.hostname}`)
  }
  // Follow short links (zhihu.app.link, /appview/, etc.)
  const needsExpand = (!/(^|\.)zhihu\.com$/.test(u.hostname) || u.pathname.startsWith('/appview/')) && isAllowedShortLinkHost(u.hostname)
  if (needsExpand) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const res = await fetch(u.href, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': account?.userAgent || DEFAULT_UA },
      })
      await res.body?.cancel()
      if (res.url) return { url: res.url, isUrl: true }
    } catch { /* fallback to original */ } finally {
      clearTimeout(timer)
    }
  }
  return { url: u.href, isUrl: true }
}

export async function verifyAndSaveCookieString(rawCookie, label = '') {
  const cookies = parseCookieString(rawCookie)
  if (!cookies.z_c0) {
    throw new ZhihuError('BAD_COOKIE', 'Cookie 里缺少关键登录字段 z_c0，请确认复制完整。')
  }
  if (!cookies.d_c0) {
    try {
      const udidRes = await fetch(`${ORIGIN}/udid`, { method: 'POST', headers: { 'User-Agent': DEFAULT_UA, Referer: `${ORIGIN}/` } })
      const sc = parseSetCookies(udidRes)
      if (sc.d_c0) cookies.d_c0 = sc.d_c0
    } catch { /* ignore */ }
  }
  const tempAcc = { id: 'tmp', name: 'tmp', userAgent: DEFAULT_UA, cookies }
  const me = await zhihuFetchJson(`${ORIGIN}/api/v4/me`, { account: tempAcc })
  const id = String(me.uid || me.id || me.url_token || randomUUID())
  const saved = upsertAccount({
    id,
    name: label || me.name || me.url_token || `知乎用户_${id.slice(-4)}`,
    urlToken: me.url_token || '',
    isVip: Boolean(me.vip_info?.is_vip),
    cookies,
    userAgent: DEFAULT_UA,
  })
  return {
    id: saved.id,
    name: saved.name,
    urlToken: saved.urlToken,
    isVip: saved.isVip,
    headline: me.headline || '',
  }
}

export async function checkActiveAccountHealth() {
  const acc = requireActiveAccount()
  const me = await zhihuFetchJson(`${ORIGIN}/api/v4/me`, { account: acc, allowBlocked: true })
  upsertAccount({
    id: acc.id,
    name: me.name || acc.name,
    urlToken: me.url_token || acc.urlToken,
    isVip: Boolean(me.vip_info?.is_vip),
    cookies: acc.cookies,
    userAgent: acc.userAgent,
  })
  return {
    id: acc.id,
    name: me.name || acc.name,
    urlToken: me.url_token || '',
    isVip: Boolean(me.vip_info?.is_vip),
    headline: me.headline || '',
  }
}

function isPaidTarget(t, row) {
  if (!t || typeof t !== 'object') return false
  if (row?.adjson || row?.type === 'feed_advert' || row?.promotion_extra || t.is_advert) return true
  if (t.is_paid === true || t.content_need_pay === true || t.has_column_sku === true) return true
  if (t.paid_info || t.sku_info || t.vip_info?.is_vip_content) return true
  if (t.label_info?.type === 'paid' || t.question?.question_type === 'paid') return true
  const url = String(t.url || '')
  if (/\/(?:xen|market|pub|km)\//i.test(url)) return true
  const badgeText = JSON.stringify(t.right_badge || t.label_info || '')
  if (/盐选|付费|会员专享|专栏购买/.test(badgeText)) return true
  return false
}

// ─── Feature 1: 主页推荐前 10 条非付费内容 ───
export async function fetchHomeFeed({ limit, fetchFull = true, maxChars } = {}) {
  const cfg = readSettings()
  limit = Number(limit) || cfg.homeLimit
  const itemMaxChars = Number(maxChars) || cfg.homeMaxChars
  const acc = requireActiveAccount()
  const targetCount = Math.max(1, Math.min(20, Number(limit) || 10))
  const collected = []
  const seen = new Set()
  let nextUrl = `${ORIGIN}/api/v3/feed/topstory/recommend?action=down&desktop=true&limit=20`
  let skippedPaidOrAd = 0

  for (let page = 0; page < 4 && collected.length < targetCount && nextUrl; page++) {
    if (page > 0) await jitterDelay(180, 350)
    const data = await zhihuFetchJson(nextUrl, { account: acc })
    const rows = Array.isArray(data?.data) ? data.data : []
    for (const row of rows) {
      const t = row?.target
      if (!t || !['answer', 'article'].includes(t.type)) {
        skippedPaidOrAd++
        continue
      }
      if (isPaidTarget(t, row)) {
        skippedPaidOrAd++
        continue
      }
      const id = String(t.id || '')
      if (!id || seen.has(`${t.type}:${id}`)) continue
      seen.add(`${t.type}:${id}`)

      const isAnswer = t.type === 'answer'
      const qid = isAnswer ? String(t.question?.id || '') : ''
      const webUrl = isAnswer && qid
        ? `${ORIGIN}/question/${qid}/answer/${id}`
        : (t.type === 'article' ? `${ZHUANLAN}/p/${id}` : String(t.url || ''))
      const title = isAnswer ? cleanHtml(t.question?.title || '', 200) : cleanHtml(t.title || '', 200)
      const includeImages = resolveImageMode(undefined, cfg) !== 'off'
      let rawHtml = t.content || t.excerpt || ''
      // topstory/recommend 接口已在 t.content 中返回完整 HTML，仅当 t.content 缺失时才补发单条请求，大幅减少请求次数防风控
      const needsFull = fetchFull && (!t.content || String(t.content).length < 120)

      if (needsFull && collected.length < targetCount) {
        try {
          await jitterDelay(650, 1300)
          if (isAnswer) {
            const full = await zhihuFetchJson(`${ORIGIN}/api/v4/answers/${id}?include=content,voteup_count,comment_count,author`, { account: acc })
            if (full?.content) rawHtml = full.content
          } else {
            const full = await fetchArticleJson(id, acc)
            if (full?.content) rawHtml = full.content
          }
        } catch (err) {
          if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED'].includes(err.code)) throw err
        }
      }
      const parsedBody = extractHtmlWithImages(rawHtml, { maxLen: itemMaxChars, includeImages })

      collected.push({
        index: collected.length + 1,
        type: t.type,
        title,
        author: t.author?.name || '匿名用户',
        voteupCount: Number(t.voteup_count ?? t.voteupCount ?? 0),
        commentCount: Number(t.comment_count ?? 0),
        url: webUrl,
        content: parsedBody.text,
        ...buildImageFields(parsedBody.images, 8),
      })
      if (collected.length >= targetCount) break
    }
    nextUrl = data?.paging?.is_end ? '' : (data?.paging?.next || '')
  }

  return {
    account: acc.name,
    count: collected.length,
    skippedPaidOrAd,
    items: collected,
  }
}

// ─── Feature 2: 当前热榜前 N 题（每题若干高赞回答） ───
export async function fetchHotList({ topQuestions, answersPerQuestion, maxChars } = {}) {
  const cfg = readSettings()
  topQuestions = Number(topQuestions) || cfg.hotQuestions
  answersPerQuestion = Number(answersPerQuestion) || cfg.hotAnswersPerQuestion
  const ansMaxChars = Number(maxChars) || cfg.hotMaxChars
  const acc = requireActiveAccount()
  const qLimit = Math.max(1, Math.min(20, Math.trunc(Number(topQuestions) || 5)))
  const aLimit = Math.max(1, Math.min(10, Math.trunc(Number(answersPerQuestion) || 3)))
  const hotFetchLimit = Math.min(50, Math.max(25, qLimit * 2))

  const hotData = await zhihuFetchJson(`${ORIGIN}/api/v3/feed/topstory/hot-lists/total?limit=${hotFetchLimit}&desktop=true`, {
    account: acc,
    extraHeaders: { Referer: `${ORIGIN}/hot` },
  })
  const rawList = Array.isArray(hotData?.data) ? hotData.data : []
  const results = []

  for (let i = 0; i < rawList.length && results.length < qLimit; i++) {
    const entry = rawList[i]
    const target = entry?.target || {}
    if (entry?.type === 'hot_list_advert' || isPaidTarget(target, entry)) continue
    const qidMatch = String(target.url || '').match(/questions?\/(\d+)/)
    if (target.type && target.type !== 'question' && !qidMatch) continue
    const qid = String(qidMatch?.[1] || target.id || '')
    if (!qid) continue

    await jitterDelay(450, 900)
    const answers = []
    let answersError = ''
    try {
      const feedLimit = Math.min(20, Math.max(10, aLimit * 2))
      const feedUrl = `${ORIGIN}/api/v4/questions/${qid}/feeds?include=data[*].target.content,excerpt,voteup_count,comment_count,author,created_time&limit=${feedLimit}&offset=0`
      const ansData = await zhihuFetchJson(feedUrl, {
        account: acc,
        extraHeaders: { Referer: `${ORIGIN}/question/${qid}` },
      })
      const rows = Array.isArray(ansData?.data) ? ansData.data : []
      for (const row of rows) {
        const a = row?.target || row
        if (!a || a.type !== 'answer' || isPaidTarget(a, row)) continue
        const parsedBody = extractHtmlWithImages(a.content || a.excerpt || '', {
          maxLen: ansMaxChars,
          includeImages: resolveImageMode(undefined, cfg) !== 'off',
        })
        if (!parsedBody.text) continue
        const aidMatch = String(a.url || '').match(/answers?\/(\d+)/)
        const aid = String(aidMatch?.[1] || a.id || '')
        answers.push({
          answerId: aid,
          author: a.author?.name || '匿名用户',
          voteupCount: Number(a.voteup_count || 0),
          commentCount: Number(a.comment_count || 0),
          url: aid ? `${ORIGIN}/question/${qid}/answer/${aid}` : `${ORIGIN}/question/${qid}`,
          content: parsedBody.text,
          ...buildImageFields(parsedBody.images, 6),
        })
        if (answers.length >= aLimit) break
      }
    } catch (err) {
      if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'NO_ACCOUNT'].includes(err.code)) {
        throw err
      }
      answersError = err?.message || '获取回答失败'
    }

    results.push({
      rank: results.length + 1,
      questionId: qid,
      title: cleanHtml(target.title || '', 200),
      heat: entry?.detail_text || '',
      questionExcerpt: cleanHtml(target.excerpt || '', 400),
      url: `${ORIGIN}/question/${qid}`,
      answerCountFetched: answers.length,
      ...(answersError ? { answersError } : {}),
      answers,
    })
  }

  return {
    account: acc.name,
    count: results.length,
    items: results,
  }
}

// ─── Feature 3: 判断收藏夹或盐选小说值不值得读 ───
export async function evaluateTarget(input, { yanxuanTrialMaxChars } = {}) {
  const cfg = readSettings()
  const trialMaxChars = Number(yanxuanTrialMaxChars) || cfg.yanxuanTrialMaxChars
  const acc = requireActiveAccount()
  const resolved = await resolveFinalUrl(input, acc)
  const raw = resolved.url

  // 3A. 收藏夹
  const colMatch = raw.match(/zhihu\.com\/collection\/(\d+)/i)
  if (colMatch) {
    const cid = colMatch[1]
    const meta = await zhihuFetchJson(`${ORIGIN}/api/v4/collections/${cid}`, { account: acc })
    await jitterDelay(140, 260)
    const itemsRes = await zhihuFetchJson(`${ORIGIN}/api/v4/collections/${cid}/items?offset=0&limit=20`, { account: acc })
    const rows = Array.isArray(itemsRes?.data) ? itemsRes.data : []
    const samples = []
    let paidCount = 0
    let totalVotes = 0
    for (const row of rows) {
      const c = row?.content || row?.target || row
      if (!c) continue
      if (isPaidTarget(c, row)) paidCount++
      const votes = Number(c.voteup_count || 0)
      totalVotes += votes
      if (samples.length < 12) {
        samples.push({
          type: c.type || 'unknown',
          title: cleanHtml(c.question?.title || c.title || '', 150),
          author: c.author?.name || '',
          voteupCount: votes,
          isPaid: isPaidTarget(c, row),
          excerpt: cleanHtml(c.excerpt || c.content || '', 1500),
          url: c.url || '',
        })
      }
    }
    const cInfo = meta?.collection || meta
    return {
      kind: 'collection',
      id: cid,
      url: `${ORIGIN}/collection/${cid}`,
      title: cleanHtml(cInfo?.title || '', 150),
      description: cleanHtml(cInfo?.description || '', 500),
      creator: cInfo?.creator?.name || '',
      followerCount: Number(cInfo?.follower_count || 0),
      itemCount: Number(cInfo?.item_count || rows.length),
      sampledCount: rows.length,
      paidInSample: paidCount,
      avgVotesInSample: rows.length ? Math.round(totalVotes / rows.length) : 0,
      samples,
    }
  }

  // 3B. 普通专栏
  const columnMatch = raw.match(/zhihu\.com\/column\/([A-Za-z0-9_-]+)/i)
  if (columnMatch) {
    const slug = columnMatch[1]
    const meta = await zhihuFetchJson(`${ORIGIN}/api/v4/columns/${slug}`, { account: acc })
    await jitterDelay(140, 260)
    const itemsRes = await zhihuFetchJson(`${ORIGIN}/api/v4/columns/${slug}/items?limit=15&offset=0`, { account: acc })
    const samples = (itemsRes?.data || []).slice(0, 12).map((c) => ({
      type: c.type || 'article',
      title: cleanHtml(c.title || c.question?.title || '', 150),
      voteupCount: Number(c.voteup_count || 0),
      excerpt: cleanHtml(c.excerpt || c.content || '', 1500),
      url: c.url || '',
    }))
    return {
      kind: 'column',
      id: slug,
      url: `${ORIGIN}/column/${slug}`,
      title: cleanHtml(meta?.title || '', 150),
      description: cleanHtml(meta?.description || meta?.intro || '', 600),
      author: meta?.author?.name || '',
      followers: Number(meta?.followers || 0),
      articlesCount: Number(meta?.articles_count || 0),
      samples,
    }
  }

  // 3C. 回答或文章形式的盐选小说/故事链接（纯走 v4 签名 API，彻底摒弃易触发 S6E3V1 风控的 HTML 直连抓取）
  const ansMatch = raw.match(/(?:question\/\d+\/)?answer\/(\d+)/i)
  if (ansMatch) {
    const aid = ansMatch[1]
    const a = await zhihuFetchJson(
      `${ORIGIN}/api/v4/answers/${aid}?include=content,excerpt,paid_info,label_info,voteup_count,comment_count,author,question.title,question.detail`,
      { account: acc }
    )
    let topComments = []
    if (Number(a.comment_count || 0) > 0) {
      await jitterDelay(500, 950)
      topComments = await fetchTopComments('answers', aid, acc, { limit: 9, maxChars: 500 })
    }
    const rawHtml = a.content || a.excerpt || ''
    const parsedTrial = extractHtmlWithImages(rawHtml, {
      maxLen: trialMaxChars,
      includeImages: resolveImageMode(undefined, cfg) !== 'off',
    })
    const trialContent = parsedTrial.text
    const isPaid = isPaidTarget(a) || /使用 App 查看完整内容|该付费内容的完整版|盐选专栏/.test(trialContent)
    return {
      kind: isPaid ? 'salt_answer' : 'answer_evaluation',
      id: aid,
      url: a.question?.id ? `${ORIGIN}/question/${a.question.id}/answer/${aid}` : raw,
      questionTitle: cleanHtml(a.question?.title || '', 200),
      questionDetail: cleanHtml(a.question?.detail || '', 1000),
      author: a.author?.name || '匿名用户',
      authorHeadline: a.author?.headline || '',
      voteupCount: Number(a.voteup_count || 0),
      commentCount: Number(a.comment_count || 0),
      isPaid,
      trialCharLength: trialContent.length,
      trialContent,
      ...buildImageFields(parsedTrial.images, 8),
      topComments,
      note: '已通过签名 v4 JSON 接口安全拉取试读正文与高赞评论（零 HTML 请求，规避 S6E3V1 风控）。',
    }
  }

  const artMatch = raw.match(/\/p\/(\d+)/i)
  if (artMatch) {
    const pid = artMatch[1]
    const a = await fetchArticleJson(pid, acc)
    let topComments = []
    if (Number(a.comment_count || 0) > 0) {
      await jitterDelay(500, 950)
      topComments = await fetchTopComments('articles', pid, acc, { limit: 9, maxChars: 500 })
    }
    const parsedTrial = extractHtmlWithImages(a.content || a.excerpt || '', {
      maxLen: trialMaxChars,
      includeImages: resolveImageMode(undefined, cfg) !== 'off',
    })
    const trialContent = parsedTrial.text
    const isPaid = isPaidTarget(a) || /使用 App 查看完整内容|该付费内容的完整版|盐选专栏/.test(trialContent)
    return {
      kind: isPaid ? 'salt_article' : 'article_evaluation',
      id: pid,
      url: `${ZHUANLAN}/p/${pid}`,
      title: cleanHtml(a.title || '', 200),
      author: a.author?.name || '匿名用户',
      voteupCount: Number(a.voteup_count || 0),
      commentCount: Number(a.comment_count || 0),
      isPaid,
      trialCharLength: trialContent.length,
      trialContent,
      ...buildImageFields(parsedTrial.images, 8),
      topComments,
    }
  }

  // 3D. 盐选专栏 / 付费出版物 / 故事名关键词（纯走 v4 签名接口，不走 zhihuFetchHtml）
  let titleQuery = ''
  let pageSummary = null
  const paidColMatch = raw.match(/(?:paid_column|remix\/well|pub\/book|xen\/market\/[^/]+)\/(\d+)/i)
  if (paidColMatch) {
    const skuId = paidColMatch[1]
    pageSummary = { finalUrl: raw, skuId }
    try {
      const sku = await zhihuFetchJson(`${ORIGIN}/api/v4/km/paid_columns/${skuId}`, { account: acc })
      pageSummary.skuTitle = sku?.title || ''
      pageSummary.intro = cleanHtml(sku?.description || sku?.intro || '', 2000)
      pageSummary.author = sku?.author?.name || sku?.authors?.[0]?.name || ''
      pageSummary.chapterCount = Number(sku?.section_count || sku?.chapter_count || 0)
      pageSummary.price = sku?.price?.origin_price ? sku.price.origin_price / 100 : undefined
      pageSummary.vipFree = Boolean(sku?.is_vip_free || sku?.svip_privileges)
      if (sku?.title) titleQuery = sku.title
    } catch { /* ignore */ }
    try {
      await jitterDelay(600, 1100)
      const cat = await zhihuFetchJson(`${ORIGIN}/api/v4/km/paid_columns/${skuId}/sections?limit=20&offset=0`, { account: acc })
      const secs = Array.isArray(cat?.data) ? cat.data : []
      pageSummary.chapters = secs.slice(0, 20).map((s, idx) => ({
        index: idx + 1,
        title: s.title || '',
        isFree: Boolean(s.is_free || s.can_read_free),
        excerpt: s.is_free ? cleanHtml(s.content || s.summary || '', trialMaxChars) : '',
      }))
    } catch { /* ignore */ }
  } else if (!resolved.isUrl) {
    titleQuery = String(input || '').trim()
  } else {
    // 其他未知知乎链接：如果带 question id 则走 question API
    const qMatch = raw.match(/\/question\/(\d+)/i)
    if (qMatch) return readZhihuUrl(raw, { maxChars: trialMaxChars })
    titleQuery = raw
  }

  const reviews = []
  if (titleQuery) {
    try {
      if (pageSummary) await jitterDelay(650, 1200)
      const q = encodeURIComponent(`${titleQuery} 盐选`)
      const searchRes = await zhihuFetchJson(`${ORIGIN}/api/v4/search_v3?t=general&q=${q}&offset=0&limit=10`, { account: acc })
      for (const row of searchRes?.data || []) {
        const obj = row?.object
        if (!obj) continue
        const snippet = cleanHtml(obj.content || obj.excerpt || '', Math.min(3000, trialMaxChars))
        if (!snippet) continue
        reviews.push({
          type: obj.type || row.type,
          id: String(obj.id || ''),
          title: cleanHtml(obj.question?.name || obj.question?.title || obj.title || '', 140),
          author: obj.author?.name || '',
          voteupCount: Number(obj.voteup_count || 0),
          commentCount: Number(obj.comment_count || 0),
          snippet,
          url: obj.question?.id && obj.id ? `${ORIGIN}/question/${obj.question.id}/answer/${obj.id}` : (obj.url || ''),
        })
        if (reviews.length >= 8) break
      }
    } catch (err) {
      if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED'].includes(err.code)) throw err
    }
  }

  return {
    kind: 'salt_or_work',
    query: titleQuery || input,
    url: resolved.isUrl ? raw : '',
    metadata: pageSummary,
    communityReviews: reviews,
    note: '已全程通过签名 v4 JSON 接口获取简介、目录或相关回答，不走易触发风控的 HTML 页面抓取。',
  }
}

async function attachReadUrlImages(images, imageMode, cfg, offset) {
  if (imageMode === 'off' || !Array.isArray(images) || images.length === 0) return {}
  const base = {
    imageMode,
    imageCount: images.length,
    images: images.slice(0, 300),
  }
  if (imageMode === 'auto' && !offset) {
    try {
      const dl = await downloadZhihuImages(images, { maxCount: cfg.maxImagesPerItem })
      const okItems = dl.items.filter((x) => x.ok)
      return {
        ...base,
        downloadedImages: okItems,
        imageHint: okItems.length
          ? `已自动下载前 ${okItems.length} 张正文图片到本机临时缓存，可直接调用 read_image 查看对应 localPath。`
          : '正文含图片，但自动下载未成功，可按需用 zhihu_download_images 重试。',
      }
    } catch {
      return {
        ...base,
        imageHint: '正文含图片，可按需调用 zhihu_download_images 下载后用 read_image 查看。',
      }
    }
  }
  return {
    ...base,
    imageHint: `正文包含 ${images.length} 张配图（位置已标为 [图N]）。如需查看具体图片内容，请调用 zhihu_download_images 下载对应 url 后用 read_image 查看。`,
  }
}

// ─── Feature 4: 手动总结指定回答/文章/问题/想法链接 ───
export async function readZhihuUrl(input, { offset = 0, maxChars, withImages } = {}) {
  const cfg = readSettings()
  maxChars = Number(maxChars) || cfg.readUrlMaxChars
  const imageMode = resolveImageMode(withImages, cfg)
  const includeImages = imageMode !== 'off'
  const acc = requireActiveAccount()
  const resolved = await resolveFinalUrl(input, acc)
  if (!resolved.isUrl) {
    throw new ZhihuError('BAD_INPUT', '请提供一个完整的知乎链接（如回答、专栏文章、问题、想法或收藏夹链接）')
  }
  const raw = resolved.url

  if (/zhihu\.com\/(?:collection|column|xen|market|pub)\//i.test(raw)) {
    return evaluateTarget(raw)
  }

  // Answer: /question/123/answer/456 or /answer/456
  const ansMatch = raw.match(/(?:question\/\d+\/)?answer\/(\d+)/i)
  if (ansMatch) {
    const aid = ansMatch[1]
    const a = await zhihuFetchJson(`${ORIGIN}/api/v4/answers/${aid}?include=content,voteup_count,comment_count,author,question.title,question.detail`, { account: acc })
    let comments = []
    if (Number(a.comment_count || 0) > 0 && !offset) {
      await jitterDelay(120, 240)
      comments = await fetchTopComments('answers', aid, acc, { limit: 6, maxChars: 400 })
    }
    const parsed = extractHtmlWithImages(a.content || '', { maxLen: 0, includeImages, maxImages: 300 })
    const sliced = sliceText(parsed.text, { offset, maxChars })
    const imgExtra = await attachReadUrlImages(parsed.images, imageMode, cfg, offset)
    return {
      kind: 'answer',
      id: aid,
      url: a.question?.id ? `${ORIGIN}/question/${a.question.id}/answer/${aid}` : raw,
      questionTitle: cleanHtml(a.question?.title || '', 200),
      questionDetail: cleanHtml(a.question?.detail || '', 1500),
      author: a.author?.name || '匿名用户',
      authorHeadline: a.author?.headline || '',
      voteupCount: Number(a.voteup_count || 0),
      commentCount: Number(a.comment_count || 0),
      ...sliced,
      ...imgExtra,
      topComments: comments,
    }
  }

  // Article: zhuanlan.zhihu.com/p/123 or zhihu.com/p/123
  const artMatch = raw.match(/\/p\/(\d+)/i)
  if (artMatch) {
    const pid = artMatch[1]
    const a = await fetchArticleJson(pid, acc)
    let comments = []
    if (Number(a.comment_count || 0) > 0 && !offset) {
      await jitterDelay(500, 900)
      comments = await fetchTopComments('articles', pid, acc, { limit: 6, maxChars: 400 })
    }
    const parsed = extractHtmlWithImages(a.content || '', { maxLen: 0, includeImages, maxImages: 300 })
    const sliced = sliceText(parsed.text, { offset, maxChars })
    const imgExtra = await attachReadUrlImages(parsed.images, imageMode, cfg, offset)
    return {
      kind: 'article',
      id: pid,
      url: `${ZHUANLAN}/p/${pid}`,
      title: cleanHtml(a.title || '', 200),
      author: a.author?.name || '',
      voteupCount: Number(a.voteup_count || 0),
      commentCount: Number(a.comment_count || 0),
      ...sliced,
      ...imgExtra,
      topComments: comments,
    }
  }

  // Question: /question/123
  const qMatch = raw.match(/\/question\/(\d+)/i)
  if (qMatch) {
    const qid = qMatch[1]
    const q = await zhihuFetchJson(`${ORIGIN}/api/v4/questions/${qid}?include=detail,answer_count,follower_count`, { account: acc })
    await jitterDelay(140, 260)
    const f = await zhihuFetchJson(`${ORIGIN}/api/v4/questions/${qid}/feeds?include=data[*].target.content,excerpt,voteup_count,author&limit=6&offset=0`, { account: acc })
    const parsedDetail = extractHtmlWithImages(q.detail || '', { maxLen: 2000, includeImages })
    const answers = []
    for (const row of f?.data || []) {
      const a = row?.target || row
      if (!a || a.type !== 'answer' || isPaidTarget(a, row)) continue
      const parsedAns = extractHtmlWithImages(a.content || a.excerpt || '', { maxLen: 10000, includeImages })
      answers.push({
        answerId: String(a.id || ''),
        author: a.author?.name || '匿名用户',
        voteupCount: Number(a.voteup_count || 0),
        content: parsedAns.text,
        ...buildImageFields(parsedAns.images, 6),
        url: `${ORIGIN}/question/${qid}/answer/${a.id}`,
      })
      if (answers.length >= 5) break
    }
    return {
      kind: 'question',
      id: qid,
      url: `${ORIGIN}/question/${qid}`,
      title: cleanHtml(q.title || '', 200),
      detail: parsedDetail.text,
      ...buildImageFields(parsedDetail.images, 6),
      answerCount: Number(q.answer_count || 0),
      answers,
    }
  }

  // Pin: /pin/123
  const pinMatch = raw.match(/\/pin\/(\d+)/i)
  if (pinMatch) {
    const pid = pinMatch[1]
    const p = await zhihuFetchJson(`${ORIGIN}/api/v4/pins/${pid}`, { account: acc })
    const parsed = extractHtmlWithImages(p.content_html || p.content?.map((x) => x.content).join('\n') || '', { maxLen: 0, includeImages, maxImages: 300 })
    const pinImages = includeImages ? (parsed.images.length ? parsed.images : extractPinImages(p)) : []
    const sliced = sliceText(parsed.text, { offset, maxChars })
    const imgExtra = await attachReadUrlImages(pinImages, imageMode, cfg, offset)
    return {
      kind: 'pin',
      id: pid,
      url: `${ORIGIN}/pin/${pid}`,
      author: p.author?.name || '',
      likeCount: Number(p.like_count || 0),
      ...sliced,
      ...imgExtra,
    }
  }

  // People profile URL fallback: /people/{urlToken}
  const peopleMatch = raw.match(/\/people\/([A-Za-z0-9_-]+)/i)
  if (peopleMatch) {
    const token = peopleMatch[1]
    const p = await zhihuFetchJson(`${ORIGIN}/api/v4/members/${token}?include=allow_message,is_followed,is_following,is_org,is_blocking,employments,answer_count,follower_count,articles_count,gender,badge[?(type=best_answerer)].topics`, { account: acc })
    return {
      kind: 'member',
      id: String(p.id || ''),
      urlToken: p.url_token || token,
      name: p.name || token,
      headline: cleanHtml(p.headline || '', 300),
      description: cleanHtml(p.description || '', 1000),
      answerCount: Number(p.answer_count || 0),
      articlesCount: Number(p.articles_count || 0),
      followerCount: Number(p.follower_count || 0),
      url: `${ORIGIN}/people/${token}`,
    }
  }

  throw new ZhihuError('UNSUPPORTED_URL', `暂不支持直接解析此知乎链接格式（已禁用易触发 403 风控的 HTML 裸抓）：${raw}。请传入回答(/answer/)、文章(/p/)、问题(/question/)、想法(/pin/)、收藏夹(/collection/)或专栏(/column/)链接。`)
}

// ─── Feature 5: 读取任意回答/文章/想法/问题的评论区（含热评与子回复） ───
const ROOT_COMMENT_PAGE_SIZE = 9
const CHILD_COMMENT_PAGE_SIZE = 20

export function parseZhihuTarget(input, explicitType = '') {
  const raw = String(input || '').trim()
  if (!raw) throw new ZhihuError('BAD_INPUT', '请提供知乎链接或内容 ID')
  const cmtMatch = raw.match(/\/comments?\/(\d+)/i)
  if (cmtMatch) return { type: 'comment', plural: 'comments', id: cmtMatch[1] }
  const ansMatch = raw.match(/(?:question\/\d+\/)?answer\/(\d+)/i)
  if (ansMatch) return { type: 'answer', plural: 'answers', id: ansMatch[1] }
  const artMatch = raw.match(/\/p\/(\d+)/i)
  if (artMatch) return { type: 'article', plural: 'articles', id: artMatch[1] }
  const pinMatch = raw.match(/\/pin\/(\d+)/i)
  if (pinMatch) return { type: 'pin', plural: 'pins', id: pinMatch[1] }
  const qMatch = raw.match(/\/question\/(\d+)/i)
  if (qMatch) return { type: 'question', plural: 'questions', id: qMatch[1] }
  const idOnly = raw.match(/^(\d+)$/)
  if (idOnly) {
    const t = ['article', 'pin', 'question', 'comment'].includes(explicitType) ? explicitType : 'answer'
    return { type: t, plural: `${t}s`, id: idOnly[1] }
  }
  throw new ZhihuError('BAD_INPUT', `无法从输入中识别知乎内容类型与 ID：${raw}`)
}

function extractCommentIp(c) {
  if (c?.address_text) return String(c.address_text)
  if (Array.isArray(c?.comment_tag)) {
    const ipTag = c.comment_tag.find((t) => t?.type === 'ip_info' && t?.text)
    if (ipTag?.text) return String(ipTag.text)
  }
  return ''
}

function formatChildComment(c, { includeImages, maxLen = 1500, maxImages = 6 } = {}) {
  const parsed = extractHtmlWithImages(c?.content || '', { maxLen, includeImages, maxImages })
  return {
    id: String(c?.id || ''),
    author: c?.author?.member?.name || c?.author?.name || '匿名用户',
    authorHeadline: c?.author?.member?.headline || c?.author?.headline || '',
    replyToCommentId: c?.reply_comment_id ? String(c.reply_comment_id) : '',
    replyToAuthor: c?.reply_to_author?.member?.name || c?.reply_to_author?.name || '',
    likeCount: Number(c?.like_count ?? c?.vote_count ?? 0),
    createdTime: c?.created_time ? new Date(c.created_time * 1000).toISOString() : '',
    ipInfo: extractCommentIp(c),
    content: parsed.text,
    ...buildImageFields(parsed.images, maxImages),
  }
}

async function fetchRootCommentsRaw({ plural, id, sortOrder = 'normal', limit = ROOT_COMMENT_PAGE_SIZE, offset = '', account }) {
  const rawOffset = String(offset ?? '').trim()
  const v5Offset = !rawOffset || rawOffset === '0' ? '' : encodeURIComponent(rawOffset)
  const v5Url = `${ORIGIN}/api/v4/comment_v5/${plural}/${id}/root_comment?order_by=${sortOrder === 'ts' ? 'ts' : 'score'}&limit=${limit}&offset=${v5Offset}`
  try {
    const data = await zhihuFetchJson(v5Url, { account })
    return { data, source: 'v5' }
  } catch (err) {
    if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED'].includes(err.code)) {
      throw err
    }
    const v4Offset = /^\d+$/.test(rawOffset) ? Math.max(0, Math.trunc(Number(rawOffset))) : 0
    const v4Url = `${ORIGIN}/api/v4/${plural}/${id}/root_comments?order=${sortOrder}&limit=${limit}&offset=${v4Offset}`
    const data = await zhihuFetchJson(v4Url, { account })
    return { data, source: 'v4' }
  }
}

async function fetchTopComments(plural, id, account, { limit = 6, maxChars = 400 } = {}) {
  try {
    const safeLimit = Math.max(1, Math.min(ROOT_COMMENT_PAGE_SIZE, Math.trunc(Number(limit) || 6)))
    const includeImages = resolveImageMode(undefined, readSettings()) !== 'off'
    const { data } = await fetchRootCommentsRaw({
      plural,
      id,
      sortOrder: 'normal',
      limit: safeLimit,
      offset: '',
      account,
    })
    return (Array.isArray(data?.data) ? data.data : []).slice(0, safeLimit).map((c) => {
      const parsed = extractHtmlWithImages(c.content || '', { maxLen: maxChars, includeImages, maxImages: 6 })
      const replyCount = Number(c.child_comment_count ?? c.reply_comment_count ?? 0)
      return {
        id: String(c.id || ''),
        author: c.author?.member?.name || c.author?.name || '',
        likeCount: Number(c.like_count ?? c.vote_count ?? 0),
        replyCount,
        ...(replyCount > 0 ? { hasMoreReplies: true } : {}),
        content: parsed.text,
        ...buildImageFields(parsed.images, 6),
      }
    })
  } catch {
    return []
  }
}

async function fetchChildCommentsRaw({ commentId, sortOrder = 'ts', limit = CHILD_COMMENT_PAGE_SIZE, offset = '', account }) {
  const rawOffset = String(offset ?? '').trim()
  const v5Offset = !rawOffset || rawOffset === '0' ? '' : encodeURIComponent(rawOffset)
  const orderBy = sortOrder === 'normal' || sortOrder === 'score' ? 'score' : 'ts'
  const v5Url = `${ORIGIN}/api/v4/comment_v5/comment/${commentId}/child_comment?order_by=${orderBy}&limit=${limit}&offset=${v5Offset}`
  try {
    const data = await zhihuFetchJson(v5Url, { account })
    return { data, source: 'v5', orderBy }
  } catch (err) {
    if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED'].includes(err.code)) {
      throw err
    }
    if (orderBy !== 'ts') {
      const fallbackUrl = `${ORIGIN}/api/v4/comment_v5/comment/${commentId}/child_comment?order_by=ts&limit=${limit}&offset=${v5Offset}`
      const data = await zhihuFetchJson(fallbackUrl, { account })
      return { data, source: 'v5', orderBy: 'ts' }
    }
    throw err
  }
}

export async function fetchComments(input, { type = '', order = '', offset = '' } = {}) {
  const acc = requireActiveAccount()
  const includeImages = resolveImageMode(undefined, readSettings()) !== 'off'
  const target = parseZhihuTarget(input, type)

  if (target.type === 'comment') {
    const rawOrd = String(order || '').trim().toLowerCase()
    const sortOrder = (rawOrd === 'normal' || rawOrd === 'score') ? 'normal' : 'ts'
    const { data, orderBy } = await fetchChildCommentsRaw({
      commentId: target.id,
      sortOrder,
      limit: CHILD_COMMENT_PAGE_SIZE,
      offset,
      account: acc,
    })

    const rootRaw = data?.root
    let rootComment = null
    if (rootRaw) {
      const rootParsed = extractHtmlWithImages(rootRaw.content || '', { maxLen: 1500, includeImages, maxImages: 10 })
      rootComment = {
        id: String(rootRaw.id || target.id),
        author: rootRaw.author?.member?.name || rootRaw.author?.name || '匿名用户',
        likeCount: Number(rootRaw.like_count ?? rootRaw.vote_count ?? 0),
        replyCount: Number(rootRaw.child_comment_count ?? rootRaw.reply_comment_count ?? data?.counts?.total_counts ?? 0),
        createdTime: rootRaw.created_time ? new Date(rootRaw.created_time * 1000).toISOString() : '',
        ipInfo: extractCommentIp(rootRaw),
        content: rootParsed.text,
        ...buildImageFields(rootParsed.images, 6),
      }
    }

    const rows = Array.isArray(data?.data) ? data.data : []
    const comments = rows.map((c) => formatChildComment(c, { includeImages, maxLen: 1500, maxImages: 6 }))

    const rawNextOffset = !data?.paging?.is_end ? extractNextOffsetFromUrl(data?.paging?.next) : null
    const isEnd = Boolean(data?.paging?.is_end || rows.length === 0 || !rawNextOffset)
    return {
      targetType: 'comment',
      targetId: target.id,
      order: orderBy === 'score' ? 'normal' : 'ts',
      ...(rootComment ? { rootComment } : {}),
      totalCount: Number(data?.counts?.total_counts ?? data?.paging?.totals ?? comments.length),
      count: comments.length,
      isEnd,
      nextOffset: isEnd ? null : rawNextOffset,
      comments,
    }
  }

  const sortOrder = order === 'ts' || order === 'latest' ? 'ts' : 'normal'
  const { data, source } = await fetchRootCommentsRaw({
    plural: target.plural,
    id: target.id,
    sortOrder,
    limit: ROOT_COMMENT_PAGE_SIZE,
    offset,
    account: acc,
  })

  const rows = Array.isArray(data?.data) ? data.data : []
  let hasTruncatedThreads = false
  const comments = rows.map((c) => {
    const parsed = extractHtmlWithImages(c.content || '', { maxLen: 1500, includeImages, maxImages: 10 })
    const replyCount = Number(c.child_comment_count ?? c.reply_comment_count ?? 0)
    const childList = (c.child_comments || []).slice(0, 5).map((sub) => formatChildComment(sub, { includeImages, maxLen: 800, maxImages: 4 }))
    const hasMoreReplies = replyCount > childList.length
    if (hasMoreReplies) hasTruncatedThreads = true
    return {
      id: String(c.id || ''),
      author: c.author?.member?.name || c.author?.name || '匿名用户',
      authorHeadline: c.author?.member?.headline || c.author?.headline || '',
      likeCount: Number(c.like_count ?? c.vote_count ?? 0),
      replyCount,
      ...(hasMoreReplies ? { hasMoreReplies: true } : {}),
      createdTime: c.created_time ? new Date(c.created_time * 1000).toISOString() : '',
      ipInfo: extractCommentIp(c),
      content: parsed.text,
      ...buildImageFields(parsed.images, 6),
      childComments: childList,
    }
  })

  const rawNextOffset = !data?.paging?.is_end
    ? (source === 'v5'
        ? extractNextOffsetFromUrl(data?.paging?.next)
        : String((/^\d+$/.test(String(offset ?? '').trim()) ? Math.max(0, Math.trunc(Number(offset))) : 0) + comments.length))
    : null
  const isEnd = Boolean(data?.paging?.is_end || rows.length === 0 || !rawNextOffset)

  return {
    targetType: target.type,
    targetId: target.id,
    order: sortOrder,
    totalCount: Number(data?.counts?.total_counts ?? data?.paging?.totals ?? data?.common_counts ?? comments.length),
    count: comments.length,
    isEnd,
    nextOffset: isEnd ? null : rawNextOffset,
    ...(hasTruncatedThreads ? { childHint: '部分评论存在更多楼中楼（hasMoreReplies: true）。如需展开某层争论或全部回复，可调用 zhihu_comments 传入 { target: 评论id, type: "comment" }。' } : {}),
    comments,
  }
}

// ─── Feature 6: 读取用户收藏夹列表 & 指定收藏夹内的条目 ───
export async function fetchUserCollections({ urlToken = '', collectionId = '', offset = 0, limit = 20, maxChars = 4000 } = {}) {
  const acc = requireActiveAccount()
  const token = String(urlToken || acc.urlToken || '').trim()
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 20)))
  const itemMaxChars = Math.max(200, Math.min(60000, Math.trunc(Number(maxChars) || 4000)))

  let cid = String(collectionId || '').trim()
  const colUrlMatch = cid.match(/collection\/(\d+)/i)
  if (colUrlMatch) cid = colUrlMatch[1]

  // 如果未传 collectionId，或者传的是收藏夹名字（非纯数字），先拉取用户的收藏夹列表
  if (!cid || !/^\d+$/.test(cid)) {
    if (!token) throw new ZhihuError('NO_URL_TOKEN', '当前账号缺少 urlToken，请先运行连通性检测或传入收藏夹 ID')
    const listUrl = `${ORIGIN}/api/v4/people/${encodeURIComponent(token)}/collections?offset=${ cid ? 0 : safeOffset }&limit=50`
    const listData = await zhihuFetchJson(listUrl, { account: acc })
    const collections = (listData?.data || []).map((c) => ({
      id: String(c.id || ''),
      title: cleanHtml(c.title || '', 120),
      description: cleanHtml(c.description || '', 300),
      itemCount: Number(c.item_count || 0),
      followerCount: Number(c.follower_count || 0),
      isPublic: Boolean(c.is_public),
      updatedTime: c.updated_time ? new Date(c.updated_time * 1000).toISOString() : '',
      url: `${ORIGIN}/collection/${c.id}`,
    }))

    if (!cid) {
      return {
        mode: 'list_collections',
        account: acc.name,
        urlToken: token,
        count: collections.length,
        collections,
      }
    }
    const matched = collections.find((c) => c.title === cid) || collections.find((c) => c.title.includes(cid))
    if (!matched) {
      throw new ZhihuError('NOT_FOUND', `在账号「${acc.name}」下找不到名为「${cid}」的收藏夹。可用收藏夹：${collections.map((c) => `${c.title}(${c.id})`).join('、')}`)
    }
    cid = matched.id
    await jitterDelay(600, 1100)
  }

  const itemsUrl = `${ORIGIN}/api/v4/collections/${cid}/items?offset=${safeOffset}&limit=${safeLimit}`
  const itemsData = await zhihuFetchJson(itemsUrl, { account: acc })
  const rows = Array.isArray(itemsData?.data) ? itemsData.data : []
  const includeImages = resolveImageMode(undefined, readSettings()) !== 'off'
  const items = rows.map((row, i) => {
    const c = row?.content || row?.target || row || {}
    const isAnswer = c.type === 'answer'
    const qid = isAnswer ? String(c.question?.id || '') : ''
    const id = String(c.id || '')
    const parsed = extractHtmlWithImages(c.content || c.excerpt || '', { maxLen: itemMaxChars, includeImages })
    const fullText = parsed.text
    const isPaid = isPaidTarget(c, row) || /使用 App 查看完整内容|该付费内容的完整版|盐选专栏/.test(fullText)
    return {
      index: safeOffset + i + 1,
      id,
      type: c.type || 'answer',
      title: cleanHtml(c.question?.title || c.title || '(无标题)', 200),
      author: c.author?.name || '匿名用户',
      voteupCount: Number(c.voteup_count ?? c.like_count ?? 0),
      commentCount: Number(c.comment_count ?? 0),
      isPaid,
      url: isAnswer && qid ? `${ORIGIN}/question/${qid}/answer/${id}` : (c.type === 'article' ? `${ZHUANLAN}/p/${id}` : (c.url || '')),
      content: fullText,
      ...buildImageFields(parsed.images, 6),
    }
  })

  return {
    mode: 'collection_items',
    collectionId: cid,
    url: `${ORIGIN}/collection/${cid}`,
    offset: safeOffset,
    limit: safeLimit,
    count: items.length,
    isEnd: Boolean(itemsData?.paging?.is_end || items.length === 0),
    nextOffset: (itemsData?.paging?.is_end || items.length === 0) ? null : safeOffset + items.length,
    items,
  }
}

// ─── Feature 7: 收藏夹条目管理（批量/单条取消收藏或添加收藏，内置防风控随机间隔） ───
export async function manageCollectionItems({ collectionId, action = 'remove', items = [], intervalMinMs = 2400, intervalMaxMs = 3800 } = {}) {
  const acc = requireActiveAccount()
  let cid = String(collectionId || '').trim()
  const colUrlMatch = cid.match(/collection\/(\d+)/i)
  if (colUrlMatch) cid = colUrlMatch[1]
  if (!cid) throw new ZhihuError('BAD_INPUT', '请提供收藏夹 ID 或收藏夹名称（如 "待看"）')

  if (!/^\d+$/.test(cid)) {
    const colList = await fetchUserCollections({ urlToken: acc.urlToken })
    const matched = (colList.collections || []).find((c) => c.title === cid) || (colList.collections || []).find((c) => c.title.includes(cid))
    if (!matched) throw new ZhihuError('NOT_FOUND', `找不到名为「${cid}」的收藏夹`)
    cid = matched.id
    await jitterDelay(700, 1200)
  }

  const normalized = (Array.isArray(items) ? items : [items])
    .filter(Boolean)
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        const parsed = parseZhihuTarget(String(item))
        return { id: parsed.id, type: parsed.type }
      }
      const parsed = parseZhihuTarget(String(item.url || item.id || ''), item.type || '')
      return { id: parsed.id, type: parsed.type }
    })

  if (!normalized.length) throw new ZhihuError('BAD_INPUT', '请提供至少一个要操作的回答/文章 ID 或链接')

  const minDelay = Math.max(800, Math.min(15000, Number(intervalMinMs) || 2400))
  const maxDelay = Math.max(minDelay + 200, Math.min(20000, Number(intervalMaxMs) || 3800))
  const results = []
  let succeeded = 0

  for (let i = 0; i < normalized.length; i++) {
    if (i > 0) await jitterDelay(minDelay, maxDelay)
    const t = normalized[i]
    const isRemove = action !== 'add'
    const url = isRemove
      ? `${ORIGIN}/api/v4/collections/${cid}/contents/${t.id}?content_type=${encodeURIComponent(t.type)}`
      : `${ORIGIN}/api/v4/collections/${cid}/contents?content_id=${encodeURIComponent(t.id)}&content_type=${encodeURIComponent(t.type)}`
    const res = await zhihuFetchJson(url, {
      account: acc,
      method: isRemove ? 'DELETE' : 'POST',
      extraHeaders: { Referer: `${ORIGIN}/collection/${cid}` },
    })
    succeeded++
    results.push({ id: t.id, type: t.type, ok: true, response: res })
  }

  return {
    collectionId: cid,
    action: action !== 'add' ? 'remove' : 'add',
    total: normalized.length,
    succeeded,
    intervalRangeMs: [minDelay, maxDelay],
    results,
  }
}

// ─── Feature 8: 知乎综合搜索（纯签名 v4 search_v3 接口） ───
export async function searchZhihu(query, { limit = 10, offset = 0 } = {}) {
  const acc = requireActiveAccount()
  const q = String(query || '').trim()
  if (!q) throw new ZhihuError('BAD_INPUT', '请输入搜索关键词')
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 10)))
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const url = `${ORIGIN}/api/v4/search_v3?t=general&q=${encodeURIComponent(q)}&offset=${safeOffset}&limit=${safeLimit}`
  const data = await zhihuFetchJson(url, { account: acc })
  const items = []
  for (const row of data?.data || []) {
    const obj = row?.object
    if (!obj || !['answer', 'article', 'question'].includes(obj.type)) continue
    const id = String(obj.id || '')
    const qid = String(obj.question?.id || '')
    const title = cleanHtml(obj.question?.name || obj.question?.title || obj.title || '', 200)
    const content = cleanHtml(obj.content || obj.excerpt || '', 2500)
    if (!title && !content) continue
    items.push({
      type: obj.type,
      id,
      title,
      author: obj.author?.name || '',
      voteupCount: Number(obj.voteup_count || 0),
      commentCount: Number(obj.comment_count || 0),
      isPaid: isPaidTarget(obj, row),
      url: obj.type === 'answer' && qid ? `${ORIGIN}/question/${qid}/answer/${id}` : (obj.type === 'article' ? `${ZHUANLAN}/p/${id}` : `${ORIGIN}/question/${id}`),
      excerpt: content,
    })
  }
  return {
    query: q,
    offset: safeOffset,
    count: items.length,
    isEnd: Boolean(data?.paging?.is_end),
    items,
  }
}

// ─── Feature 9: 读取用户主页信息与高赞/最新回答 ───
export async function fetchMemberProfile(input, { sortBy = 'voteups', limit = 10, offset = 0, maxChars = 4000 } = {}) {
  const acc = requireActiveAccount()
  const raw = String(input || '').trim()
  if (!raw) throw new ZhihuError('BAD_INPUT', '请提供知乎用户主页链接或 urlToken')
  const m = raw.match(/zhihu\.com\/(?:people|org)\/([A-Za-z0-9_-]+)/i)
  const token = m ? m[1] : raw.replace(/^@/, '').replace(/\/.*$/, '')
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new ZhihuError('BAD_INPUT', `无法识别知乎用户标识：${raw}`)
  }

  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 10)))
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0))
  const itemMaxChars = Math.max(200, Math.min(30000, Math.trunc(Number(maxChars) || 4000)))
  const sort = sortBy === 'created' || sortBy === 'latest' ? 'created' : 'voteups'

  const profileUrl = `${ORIGIN}/api/v4/members/${encodeURIComponent(token)}?include=allow_message,is_followed,is_following,is_org,employments,answer_count,follower_count,following_count,articles_count,voteup_count,thanked_count,favorited_count,description,headline`
  const p = await zhihuFetchJson(profileUrl, { account: acc })

  const member = {
    id: String(p.id || ''),
    urlToken: p.url_token || token,
    name: p.name || token,
    headline: cleanHtml(p.headline || '', 300),
    description: cleanHtml(p.description || '', 1000),
    isOrg: Boolean(p.is_org),
    followerCount: Number(p.follower_count || 0),
    followingCount: Number(p.following_count || 0),
    answerCount: Number(p.answer_count || 0),
    articlesCount: Number(p.articles_count || 0),
    voteupCount: Number(p.voteup_count || 0),
    favoritedCount: Number(p.favorited_count || 0),
    url: `${ORIGIN}/people/${p.url_token || token}`,
  }

  const includeImages = resolveImageMode(undefined, readSettings()) !== 'off'
  const profileReferer = { Referer: `${ORIGIN}/people/${encodeURIComponent(token)}` }

  // 1. 拉取主页真实动态流（/api/v3/moments/{token}/activities 稳过 200，原 v4/members/*/activities 已返回空壳）
  const activities = []
  let activitiesNextCursor = null
  try {
    await jitterDelay(500, 950)
    const actUrl = `${ORIGIN}/api/v3/moments/${encodeURIComponent(token)}/activities?limit=${safeLimit}&desktop=true`
    const actRes = await zhihuFetchJson(actUrl, { account: acc, extraHeaders: profileReferer })
    if (!actRes?.paging?.is_end && actRes?.paging?.next) {
      activitiesNextCursor = actRes.paging.next
    }
    for (const row of actRes?.data || []) {
      const t = row?.target
      if (!t) continue
      const tid = String(t.id || '')
      const qid = String(t.question?.id || '')
      let rawHtml = ''
      if (t.type === 'pin') {
        rawHtml = t.content_html || (Array.isArray(t.content) ? t.content.map((x) => x.content || (x.url ? `[链接:${x.url}]` : '')).join('\n') : (t.content || t.excerpt_title || ''))
      } else {
        rawHtml = t.content || t.excerpt || ''
      }
      const parsed = extractHtmlWithImages(rawHtml, { maxLen: itemMaxChars, includeImages })
      const imgs = includeImages ? (parsed.images.length ? parsed.images : (t.type === 'pin' ? extractPinImages(t) : [])) : []
      activities.push({
        verb: row.verb || '',
        actionText: row.action_text || '',
        type: t.type || '',
        id: tid,
        title: cleanHtml(t.question?.title || t.title || t.excerpt_title || '', 200),
        author: t.author?.name || '',
        voteupCount: Number(t.voteup_count ?? t.like_count ?? 0),
        commentCount: Number(t.comment_count || 0),
        createdTime: row.created_time ? new Date(row.created_time * 1000).toISOString() : '',
        url: t.type === 'answer' && qid ? `${ORIGIN}/question/${qid}/answer/${tid}` : (t.type === 'article' ? `${ZHUANLAN}/p/${tid}` : (t.type === 'pin' ? `${ORIGIN}/pin/${tid}` : (t.url || ''))),
        content: parsed.text,
        ...buildImageFields(imgs, 6),
      })
    }
  } catch { /* optional */ }

  // 2. 汇集该答主的原创作品：本人账号直读创作者中心，他人账号优先复用动态里的原创内容并用 search_v3 补齐历史高赞作品
  const works = []
  const seenWorkIds = new Set()
  const isSelf = Boolean(acc.urlToken && acc.urlToken.toLowerCase() === member.urlToken.toLowerCase())

  if (isSelf) {
    try {
      await jitterDelay(500, 950)
      const creatorUrl = `${ORIGIN}/api/v4/creators/creations/v2/answer?limit=${safeLimit}&offset=${safeOffset}`
      const cRes = await zhihuFetchJson(creatorUrl, { account: acc, extraHeaders: { Referer: `${ORIGIN}/creator/manage/creation/answer` } })
      for (const row of cRes?.data || []) {
        const d = row?.data || row
        const oid = String(d?.id || '')
        const qid = String(d?.question_id || d?.question?.id || '')
        if (!oid || seenWorkIds.has(oid)) continue
        seenWorkIds.add(oid)
        works.push({
          type: 'answer',
          id: oid,
          title: cleanHtml(d?.title || d?.question?.title || '', 200),
          voteupCount: Number(d?.reaction?.vote_up_count ?? d?.voteup_count ?? 0),
          commentCount: Number(d?.reaction?.comment_count ?? d?.comment_count ?? 0),
          isPaid: false,
          url: qid ? `${ORIGIN}/question/${qid}/answer/${oid}` : `${ORIGIN}/answer/${oid}`,
          content: cleanHtml(d?.excerpt || d?.content || '', itemMaxChars),
        })
      }
    } catch { /* fallback below */ }
  } else {
    for (const act of activities) {
      if (!['MEMBER_ANSWER_QUESTION', 'MEMBER_CREATE_ARTICLE'].includes(act.verb)) continue
      if (!act.id || seenWorkIds.has(act.id)) continue
      seenWorkIds.add(act.id)
      works.push({
        type: act.type,
        id: act.id,
        title: act.title,
        voteupCount: act.voteupCount,
        commentCount: act.commentCount,
        isPaid: false,
        url: act.url,
        content: act.content,
        ...(act.images ? { imageCount: act.imageCount, images: act.images } : {}),
      })
    }
  }

  if (works.length < safeLimit && member.name && (member.answerCount > 0 || member.articlesCount > 0)) {
    try {
      await jitterDelay(600, 1100)
      const q = encodeURIComponent(member.name)
      const searchRes = await zhihuFetchJson(`${ORIGIN}/api/v4/search_v3?t=general&q=${q}&offset=${safeOffset}&limit=20`, { account: acc })
      for (const row of searchRes?.data || []) {
        const obj = row?.object
        if (!obj || !['answer', 'article'].includes(obj.type)) continue
        const authorToken = obj.author?.url_token || ''
        const authorName = obj.author?.name || ''
        if (authorToken !== member.urlToken && authorName !== member.name) continue
        const oid = String(obj.id || '')
        if (!oid || seenWorkIds.has(oid)) continue
        seenWorkIds.add(oid)
        const qid = String(obj.question?.id || '')
        const parsedObj = extractHtmlWithImages(obj.content || obj.excerpt || '', { maxLen: itemMaxChars, includeImages })
        works.push({
          type: obj.type,
          id: oid,
          title: cleanHtml(obj.question?.name || obj.question?.title || obj.title || '', 200),
          voteupCount: Number(obj.voteup_count || 0),
          commentCount: Number(obj.comment_count || 0),
          isPaid: isPaidTarget(obj, row),
          url: obj.type === 'answer' && qid ? `${ORIGIN}/question/${qid}/answer/${oid}` : `${ZHUANLAN}/p/${oid}`,
          content: parsedObj.text,
          ...buildImageFields(parsedObj.images, 6),
        })
        if (works.length >= safeLimit) break
      }
    } catch { /* optional */ }
  }

  return {
    member,
    sortBy: sort,
    activitiesCount: activities.length,
    ...(activitiesNextCursor ? { activitiesNextCursor } : {}),
    activities,
    worksCount: works.length,
    works,
    note: isSelf
      ? '主页动态走 /api/v3/moments/{token}/activities，本人原创回答直读创作者中心接口。'
      : '主页动态走 /api/v3/moments/{token}/activities（已替代返回空壳的旧 v4/activities），原创代表作由近期动态 + search_v3 补齐（规避 /members/*/answers 的 10003 限制）。',
  }
}

// ─── Feature 10 (A5): 问题下回答列表（支持默认热度/最新排序与 cursor 翻页） ───
export async function fetchQuestionAnswers(input, { order = 'default', limit = 10, maxChars, cursor = '', includePaid = false } = {}) {
  const cfg = readSettings()
  const acc = requireActiveAccount()
  const rawInput = String(input || '').trim()
  if (!rawInput) throw new ZhihuError('BAD_INPUT', '请提供知乎问题链接或问题 ID')

  let qid = ''
  if (/^\d+$/.test(rawInput)) {
    qid = rawInput
  } else {
    const resolved = await resolveFinalUrl(rawInput, acc)
    const m = resolved.url.match(/\/question\/(\d+)/i)
    if (m) qid = m[1]
  }
  if (!qid) throw new ZhihuError('BAD_INPUT', `无法从输入中识别知乎问题 ID：${rawInput}`)

  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 10)))
  const itemMaxChars = Math.max(500, Math.min(100000, Number(maxChars) || cfg.hotMaxChars || 10000))
  const sortOrder = order === 'updated' || order === 'latest' ? 'updated' : 'default'

  let questionMeta = null
  const rawCursor = String(cursor || '').trim()
  let feedUrl = ''
  if (rawCursor && rawCursor.startsWith(`${ORIGIN}/api/v4/questions/${qid}/feeds`)) {
    feedUrl = rawCursor
  } else {
    const q = await zhihuFetchJson(`${ORIGIN}/api/v4/questions/${qid}?include=detail,answer_count,follower_count`, { account: acc })
    questionMeta = {
      title: cleanHtml(q.title || '', 200),
      detail: cleanHtml(q.detail || '', 2000),
      answerCount: Number(q.answer_count || 0),
      followerCount: Number(q.follower_count || 0),
    }
    await jitterDelay(600, 1100)
    const orderParam = sortOrder === 'updated' ? '&order=updated' : ''
    const cursorParam = rawCursor ? `&cursor=${encodeURIComponent(rawCursor)}` : ''
    feedUrl = `${ORIGIN}/api/v4/questions/${qid}/feeds?include=data[*].target.content,excerpt,voteup_count,comment_count,author,created_time&limit=${safeLimit}&offset=0${orderParam}${cursorParam}`
  }

  const f = await zhihuFetchJson(feedUrl, { account: acc, extraHeaders: { Referer: `${ORIGIN}/question/${qid}` } })
  const answers = []
  let skippedPaid = 0
  for (const row of f?.data || []) {
    const a = row?.target || row
    if (!a || a.type !== 'answer') continue
    const paid = isPaidTarget(a, row)
    if (paid && !includePaid) {
      skippedPaid++
      continue
    }
    if (!questionMeta && a.question?.title) {
      questionMeta = { title: cleanHtml(a.question.title, 200) }
    }
    const aid = String(a.id || '')
    const parsedAns = extractHtmlWithImages(a.content || a.excerpt || '', {
      maxLen: itemMaxChars,
      includeImages: resolveImageMode(undefined, cfg) !== 'off',
    })
    answers.push({
      answerId: aid,
      author: a.author?.name || '匿名用户',
      authorHeadline: a.author?.headline || '',
      voteupCount: Number(a.voteup_count || 0),
      commentCount: Number(a.comment_count || 0),
      createdTime: a.created_time ? new Date(a.created_time * 1000).toISOString() : '',
      isPaid: paid,
      url: `${ORIGIN}/question/${qid}/answer/${aid}`,
      content: parsedAns.text,
      ...buildImageFields(parsedAns.images, 6),
    })
  }

  const isEnd = Boolean(f?.paging?.is_end || !f?.paging?.next || answers.length === 0 && (f?.data || []).length === 0)
  return {
    questionId: qid,
    url: `${ORIGIN}/question/${qid}`,
    ...(questionMeta || {}),
    order: sortOrder,
    count: answers.length,
    skippedPaid,
    isEnd,
    nextCursor: isEnd ? null : (f?.paging?.next || null),
    answers,
  }
}

// ─── Feature 11 (A6): 读取当前账号关注动态流（/api/v3/moments） ───
export async function fetchFollowMoments({ limit = 10, cursor = '', fetchFull = true, maxChars } = {}) {
  const cfg = readSettings()
  const acc = requireActiveAccount()
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 10)))
  const itemMaxChars = Math.max(500, Math.min(100000, Number(maxChars) || cfg.homeMaxChars || 15000))
  const rawCursor = String(cursor || '').trim()
  const url = (rawCursor && rawCursor.startsWith(`${ORIGIN}/api/v3/moments`)) ? rawCursor : `${ORIGIN}/api/v3/moments?limit=${safeLimit}&desktop=true`

  const data = await zhihuFetchJson(url, { account: acc, extraHeaders: { Referer: `${ORIGIN}/follow` } })
  const items = []
  let skippedPaidOrAd = 0

  for (const row of data?.data || []) {
    if (row?.type !== 'feed') {
      skippedPaidOrAd++
      continue
    }
    const t = row?.target
    if (!t || !['answer', 'article', 'pin', 'question'].includes(t.type) || isPaidTarget(t, row)) {
      skippedPaidOrAd++
      continue
    }
    const id = String(t.id || '')
    const qid = String(t.question?.id || '')
    let rawHtml = ''
    if (t.type === 'pin') {
      rawHtml = t.content_html || (Array.isArray(t.content) ? t.content.map((x) => x.content || (x.url ? `[链接:${x.url}]` : '')).join('\n') : (t.content || t.excerpt_title || ''))
    } else {
      rawHtml = t.content || t.excerpt || ''
    }
    const includeImages = resolveImageMode(undefined, cfg) !== 'off'
    let finalHtml = rawHtml
    const needsFull = fetchFull && (t.type === 'answer' || t.type === 'article') && (!t.content || String(t.content).length < 120) && items.length < safeLimit
    if (needsFull && id) {
      try {
        await jitterDelay(650, 1250)
        if (t.type === 'answer') {
          const full = await zhihuFetchJson(`${ORIGIN}/api/v4/answers/${id}?include=content,voteup_count,comment_count,author`, { account: acc })
          if (full?.content) finalHtml = full.content
        } else {
          const full = await fetchArticleJson(id, acc)
          if (full?.content) finalHtml = full.content
        }
      } catch (err) {
        if (err instanceof ZhihuError && ['RISK_CONTROL', 'LOGIN_REQUIRED', 'RATE_LIMITED'].includes(err.code)) throw err
      }
    }
    const parsedItem = extractHtmlWithImages(finalHtml, { maxLen: itemMaxChars, includeImages })
    const itemImages = includeImages
      ? (parsedItem.images.length ? parsedItem.images : (t.type === 'pin' ? extractPinImages(t) : []))
      : []

    const webUrl = t.type === 'answer' && qid
      ? `${ORIGIN}/question/${qid}/answer/${id}`
      : (t.type === 'article' ? `${ZHUANLAN}/p/${id}` : (t.type === 'pin' ? `${ORIGIN}/pin/${id}` : `${ORIGIN}/question/${id}`))

    items.push({
      index: items.length + 1,
      actionText: row.action_text || '',
      verb: row.verb || '',
      actors: (row.actors || []).map((a) => a.name).filter(Boolean),
      type: t.type,
      id,
      title: cleanHtml(t.question?.title || t.title || t.excerpt_title || '', 200),
      author: t.author?.name || '匿名用户',
      voteupCount: Number(t.voteup_count ?? t.like_count ?? 0),
      commentCount: Number(t.comment_count || 0),
      createdTime: row.created_time ? new Date(row.created_time * 1000).toISOString() : '',
      url: webUrl,
      content: parsedItem.text,
      ...buildImageFields(itemImages, 8),
    })
    if (items.length >= safeLimit) break
  }

  const isEnd = Boolean(data?.paging?.is_end || !data?.paging?.next)
  return {
    account: acc.name,
    count: items.length,
    skippedPaidOrAd,
    isEnd,
    nextCursor: isEnd ? null : (data?.paging?.next || null),
    items,
  }
}

// ─── Feature 12: 通知与评论收件箱（评论回复、回答邀请、赞同感谢、新关注） ───
function extractNextOffsetFromUrl(nextUrl) {
  if (!nextUrl) return null
  try {
    const u = new URL(String(nextUrl).replace(/^http:/i, 'https:'))
    const off = u.searchParams.get('offset')
    return off ? String(off) : null
  } catch {
    return null
  }
}

function formatV2Notification(row) {
  const t = row?.target || {}
  const actors = (row?.content?.actors || []).map((a) => ({
    name: a.name || '',
    urlToken: a.url_token || '',
  })).filter((a) => a.name)
  const base = {
    id: String(row?.id || ''),
    isRead: Boolean(row?.is_read),
    createdTime: row?.create_time ? new Date(row.create_time * 1000).toISOString() : '',
    verb: String(row?.content?.verb || '').trim(),
    mergeCount: Number(row?.merge_count || 1),
    actors,
    targetType: t.type || '',
  }

  if (t.type === 'comment') {
    const parent = t.target || {}
    const qid = String(parent.question?.id || '')
    const pid = String(parent.id || '')
    const parentUrl = parent.type === 'answer' && qid && pid
      ? `${ORIGIN}/question/${qid}/answer/${pid}`
      : (row?.content?.target?.link || (parent.type === 'article' && pid ? `${ZHUANLAN}/p/${pid}` : ''))
    return {
      ...base,
      category: 'comment',
      commentId: String(t.id || ''),
      replyRootId: t.reply_root_id ? String(t.reply_root_id) : '',
      allowReply: Boolean(t.allow_reply),
      author: t.author?.member?.name || actors[0]?.name || '匿名用户',
      authorUrlToken: t.author?.member?.url_token || actors[0]?.urlToken || '',
      commentContent: cleanHtml(t.content || row?.content?.extend?.text || '', 1500),
      resourceType: t.resource_type || parent.type || '',
      parentId: pid,
      parentTitle: cleanHtml(parent.question?.title || parent.title || row?.content?.target?.text || '', 200),
      parentAuthor: parent.author?.name || '',
      parentExcerpt: cleanHtml(parent.excerpt || '', 400),
      parentUrl,
    }
  }

  if (t.type === 'question') {
    const qid = String(t.id || '')
    return {
      ...base,
      category: 'invite',
      questionId: qid,
      title: cleanHtml(t.title || row?.content?.target?.text || '', 200),
      url: qid ? `${ORIGIN}/question/${qid}` : (row?.content?.target?.link || ''),
    }
  }

  return {
    ...base,
    category: 'other',
    title: cleanHtml(row?.content?.target?.text || t.title || t.question?.title || '', 200),
    excerpt: cleanHtml(row?.content?.extend?.text || t.content || t.excerpt || '', 500),
    url: row?.content?.target?.link || '',
  }
}

export async function fetchNotifications({ category = 'comments', limit = 15, offset = '', unreadOnly = false } = {}) {
  const acc = requireActiveAccount()
  const cat = ['all', 'comments', 'invites', 'likes', 'follows', 'summary'].includes(category) ? category : 'comments'
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(Number(limit) || 15)))
  const offParam = offset ? `&offset=${encodeURIComponent(String(offset))}` : ''
  const refererHeaders = { Referer: `${ORIGIN}/notifications` }

  if (cat === 'summary') {
    const tl = await zhihuFetchJson(`${ORIGIN}/api/v4/notifications/v3/timeline?limit=10`, { account: acc, extraHeaders: refererHeaders })
    const entries = (tl?.data || []).map((e) => ({
      subtype: e.noti_subtype || '',
      title: cleanHtml(e.content?.title || e.detail_title || '', 80),
      latestText: cleanHtml(e.content?.text || '', 300),
      unreadCount: Number(e.unread_count || 0),
      isRead: Boolean(e.is_read),
      createdTime: e.created ? new Date(e.created * 1000).toISOString() : '',
    }))
    return { account: acc.name, category: 'summary', count: entries.length, entries }
  }

  if (cat === 'likes') {
    const data = await zhihuFetchJson(`${ORIGIN}/api/v4/notifications/v2/vote_thank?limit=${safeLimit}${offParam}`, { account: acc, extraHeaders: refererHeaders })
    let items = (data?.data || []).map(formatV2Notification)
    if (unreadOnly) items = items.filter((x) => !x.isRead)
    const isEnd = Boolean(data?.paging?.is_end || !data?.paging?.next)
    return {
      account: acc.name,
      category: 'likes',
      count: items.length,
      isEnd,
      nextOffset: isEnd ? null : extractNextOffsetFromUrl(data?.paging?.next),
      items,
    }
  }

  if (cat === 'follows') {
    const data = await zhihuFetchJson(`${ORIGIN}/api/v4/notifications/v3/timeline/entry/follow?limit=${safeLimit}${offParam}`, { account: acc, extraHeaders: refererHeaders })
    let items = (data?.data || []).map((row) => ({
      id: String(row.id || ''),
      isRead: Boolean(row.is_read),
      createdTime: row.created ? new Date(row.created * 1000).toISOString() : '',
      title: cleanHtml(row.content?.title || row.detail_title || '', 120),
      text: cleanHtml(row.content?.text || row.content?.sub_text || '', 300),
      targetLink: row.head?.target_link || row.content?.target_link || '',
    }))
    if (unreadOnly) items = items.filter((x) => !x.isRead)
    const isEnd = Boolean(data?.paging?.is_end || !data?.paging?.next)
    return {
      account: acc.name,
      category: 'follows',
      count: items.length,
      isEnd,
      nextOffset: isEnd ? null : extractNextOffsetFromUrl(data?.paging?.next),
      items,
    }
  }

  // comments / invites / all: 走已验证的 v2/default；comments 模式最多自动翻 3 页，防止被回答邀请淹没
  const maxPages = cat === 'comments' ? 3 : 1
  const collected = []
  let curUrl = `${ORIGIN}/api/v4/notifications/v2/default?limit=20${offParam}`
  let lastPaging = null
  let pagesScanned = 0

  for (let p = 0; p < maxPages && collected.length < safeLimit && curUrl; p++) {
    if (p > 0) await jitterDelay(650, 1100)
    const data = await zhihuFetchJson(curUrl, { account: acc, extraHeaders: refererHeaders })
    pagesScanned++
    lastPaging = data?.paging || null
    for (const row of data?.data || []) {
      const formatted = formatV2Notification(row)
      if (unreadOnly && formatted.isRead) continue
      if (cat === 'comments' && formatted.category !== 'comment') continue
      if (cat === 'invites' && formatted.category !== 'invite') continue
      collected.push(formatted)
      if (collected.length >= safeLimit) break
    }
    if (lastPaging?.is_end || !lastPaging?.next) {
      curUrl = ''
      break
    }
    curUrl = String(lastPaging.next).replace(/^http:/i, 'https:')
  }

  const isEnd = Boolean(!curUrl || lastPaging?.is_end)
  return {
    account: acc.name,
    category: cat,
    pagesScanned,
    count: collected.length,
    isEnd,
    nextOffset: isEnd ? null : extractNextOffsetFromUrl(lastPaging?.next),
    items: collected,
  }
}

// ─── Feature 13: 代答存草稿（Markdown → 知乎富文本 HTML + 防覆盖保护） ───
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatInlineMarkdown(raw) {
  const codeTokens = []
  let s = String(raw || '').replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = codeTokens.length
    codeTokens.push(`<code>${escapeHtml(code)}</code>`)
    return `\u0000CODE${idx}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`)
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__([^\n_]+?)__/g, '<b>$1</b>')
  s = s.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, '$1<i>$2</i>')
  s = s.replace(/~~([^\n~]+?)~~/g, '<s>$1</s>')
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeTokens[Number(idx)] || '')
  return s
}

export function markdownToZhihuHtml(input, format = 'auto') {
  const text = String(input || '').replace(/\r\n?/g, '\n').trim()
  if (!text) return ''
  if (format === 'html' || (format === 'auto' && /^<(p|h[1-6]|blockquote|ul|ol|pre|div)\b/i.test(text))) {
    return text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').trim()
  }

  const lines = text.split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // Fenced code block
    const fence = line.match(/^```([A-Za-z0-9_+-]*)/)
    if (fence) {
      const lang = fence[1] || 'text'
      const codeLines = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      out.push(`<pre lang="${escapeHtml(lang)}"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      out.push('<hr/>')
      i++
      continue
    }

    // Headings (知乎回答编辑器支持 h2 / h3)
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (hMatch) {
      const tag = hMatch[1].length <= 2 ? 'h2' : 'h3'
      out.push(`<${tag}>${formatInlineMarkdown(hMatch[2].trim())}</${tag}>`)
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(formatInlineMarkdown(lines[i].replace(/^>\s?/, '')))
        i++
      }
      out.push(`<blockquote>${quoteLines.join('<br/>')}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineMarkdown(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Paragraph
    const paraLines = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())
    ) {
      paraLines.push(formatInlineMarkdown(lines[i]))
      i++
    }
    if (paraLines.length) out.push(`<p>${paraLines.join('<br/>')}</p>`)
  }

  return out.join('')
}

async function resolveQuestionId(input, acc) {
  const rawInput = String(input || '').trim()
  if (!rawInput) throw new ZhihuError('BAD_INPUT', '请提供知乎问题链接或问题 ID')
  if (/^\d+$/.test(rawInput)) return rawInput
  const resolved = await resolveFinalUrl(rawInput, acc)
  const m = resolved.url.match(/\/question\/(\d+)/i)
  if (m) return m[1]
  throw new ZhihuError('BAD_INPUT', `无法从输入中识别知乎问题 ID：${rawInput}`)
}

export async function manageAnswerDraft({ question, action = 'get', content = '', format = 'auto', mode = 'create_only' } = {}) {
  const acc = requireActiveAccount()
  const qid = await resolveQuestionId(question, acc)
  const draftUrl = `${ORIGIN}/api/v4/questions/${qid}/draft`
  const questionUrl = `${ORIGIN}/question/${qid}`
  const refererHeaders = { Referer: questionUrl }
  const act = ['get', 'save', 'delete'].includes(action) ? action : 'get'

  const readCurrentDraft = async () => {
    const raw = await zhihuFetchJson(draftUrl, { account: acc, extraHeaders: refererHeaders })
    const html = String(raw?.editable_content || raw?.content || '').trim()
    const plain = cleanHtml(html, 0)
    const hasDraft = plain.length > 0 || html.length > 0
    return {
      hasDraft,
      contentHtml: html,
      contentText: cleanHtml(html, 8000),
      charLength: plain.length,
      updatedTime: raw?.updated_time ? new Date(raw.updated_time * 1000).toISOString() : '',
      createdTime: raw?.created_time ? new Date(raw.created_time * 1000).toISOString() : '',
    }
  }

  if (act === 'get') {
    const cur = await readCurrentDraft()
    return {
      action: 'get',
      questionId: qid,
      questionUrl,
      ...cur,
    }
  }

  if (act === 'delete') {
    const res = await zhihuFetchJson(draftUrl, { account: acc, method: 'DELETE', extraHeaders: refererHeaders })
    return {
      action: 'delete',
      deleted: true,
      questionId: qid,
      questionUrl,
      response: res,
    }
  }

  // action === 'save'
  const newHtml = markdownToZhihuHtml(content, format)
  if (!newHtml) throw new ZhihuError('BAD_INPUT', '草稿正文不能为空')

  const saveMode = ['create_only', 'append', 'overwrite'].includes(mode) ? mode : 'create_only'
  const existing = await readCurrentDraft()

  if (existing.hasDraft && saveMode === 'create_only') {
    return {
      action: 'save',
      saved: false,
      conflict: true,
      questionId: qid,
      questionUrl,
      existingDraft: existing,
      hint: '该问题下已有未发布草稿，为防止覆盖你手写的内容已中止保存。请向用户确认后传入 mode: "overwrite"（覆盖）或 mode: "append"（追加到末尾）。',
    }
  }

  const finalHtml = existing.hasDraft && saveMode === 'append'
    ? `${existing.contentHtml}<hr/>${newHtml}`
    : newHtml

  await jitterDelay(650, 1150)
  const savedRes = await zhihuFetchJson(draftUrl, {
    account: acc,
    method: 'POST',
    body: { content: finalHtml, delta_time: 0 },
    extraHeaders: refererHeaders,
  })

  const savedPlain = cleanHtml(savedRes?.content || finalHtml, 0)
  return {
    action: 'save',
    saved: true,
    mode: saveMode,
    hadExistingDraft: existing.hasDraft,
    questionId: qid,
    questionUrl,
    draftCharLength: savedPlain.length,
    excerpt: cleanHtml(savedRes?.excerpt || savedPlain, 240),
    updatedTime: savedRes?.updated_time ? new Date(savedRes.updated_time * 1000).toISOString() : new Date().toISOString(),
    note: '草稿已安全保存到知乎（不会自动公开发布）。请打开 questionUrl 点击「写回答」审核并手动发布。',
  }
}

function resolveArticleDraftId(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  if (/^\d+$/.test(raw)) return raw
  const m = raw.match(/\/p\/(\d+)/i)
  if (m) return m[1]
  throw new ZhihuError('BAD_INPUT', `无法从输入中识别专栏文章/草稿 ID：${raw}`)
}

function formatArticleDraftSnapshot(raw, idFallback = '') {
  const id = String(raw?.id || idFallback || '')
  const html = String(raw?.content || '').trim()
  const plain = cleanHtml(html, 0)
  const title = String(raw?.title || '').trim()
  const ts = Number(raw?.updated || raw?.updated_time || 0)
  const createdTs = Number(raw?.created || raw?.created_time || 0)
  return {
    articleId: id,
    editUrl: `${ZHUANLAN}/p/${id}/edit`,
    articleUrl: `${ZHUANLAN}/p/${id}`,
    state: String(raw?.state || 'draft'),
    title,
    hasContent: plain.length > 0 || html.length > 0,
    contentHtml: html,
    contentText: cleanHtml(html, 8000),
    charLength: plain.length,
    summary: String(raw?.summary || cleanHtml(html, 200) || '').trim(),
    updatedTime: ts ? new Date(ts * 1000).toISOString() : '',
    createdTime: createdTs ? new Date(createdTs * 1000).toISOString() : '',
  }
}

export async function manageArticleDraft({ action = 'list', articleId = '', title = '', content = '', format = 'auto', mode = 'create_only', limit = 20 } = {}) {
  const acc = requireActiveAccount()
  const act = ['list', 'get', 'save', 'delete'].includes(action) ? action : 'list'
  const zlWriteHeaders = { Referer: `${ZHUANLAN}/write`, Origin: ZHUANLAN }
  const draftEditHeaders = (id) => ({ Referer: `${ZHUANLAN}/p/${id}/edit`, Origin: ZHUANLAN })

  const readDraftById = async (id) => {
    const raw = await zhihuFetchJson(`${ZHUANLAN}/api/articles/${id}/draft`, {
      account: acc,
      extraHeaders: draftEditHeaders(id),
    })
    return formatArticleDraftSnapshot(raw, id)
  }

  if (act === 'list') {
    const maxItems = Math.max(1, Math.min(30, Number(limit) || 20))
    const merged = new Map()

    try {
      const remote = await zhihuFetchJson(
        `${ORIGIN}/api/v4/creators/creations/v2/article?limit=${maxItems}&offset=0&status=draft`,
        { account: acc, extraHeaders: { Referer: `${ORIGIN}/creator/manage/creation/article`, Origin: ORIGIN } }
      )
      for (const item of remote?.data || []) {
        const d = item?.data || item
        const id = String(d?.id || '')
        if (!id) continue
        merged.set(id, {
          articleId: id,
          title: String(d?.title || '').trim(),
          summary: cleanHtml(d?.excerpt || d?.summary || '', 200),
          editUrl: `${ZHUANLAN}/p/${id}/edit`,
          updatedTime: d?.updated_time ? new Date(Number(d.updated_time) * 1000).toISOString() : '',
          source: 'zhihu_creator',
        })
      }
    } catch { /* ignore remote list failure and rely on local index */ }

    const tracked = readArticleDraftIndex(acc.id).slice(0, maxItems)
    for (let i = 0; i < tracked.length; i++) {
      const item = tracked[i]
      const id = String(item?.id || '')
      if (!id) continue
      if (i > 0) await jitterDelay(250, 450)
      try {
        const live = await readDraftById(id)
        if (live.state && live.state !== 'draft') {
          removeArticleDraftIndex(acc.id, id)
          continue
        }
        upsertArticleDraftIndex(acc.id, {
          id,
          title: live.title,
          summary: live.summary,
          editUrl: live.editUrl,
          updatedTime: live.updatedTime,
        })
        merged.set(id, {
          articleId: id,
          title: live.title,
          summary: live.summary,
          charLength: live.charLength,
          editUrl: live.editUrl,
          updatedTime: live.updatedTime,
          source: merged.has(id) ? 'both' : 'plugin_tracked',
        })
      } catch (err) {
        if (err?.detail?.httpStatus === 404 || err?.detail?.httpStatus === 410) {
          removeArticleDraftIndex(acc.id, id)
        } else if (!merged.has(id)) {
          merged.set(id, {
            articleId: id,
            title: item.title || '',
            summary: item.summary || '',
            editUrl: item.editUrl || `${ZHUANLAN}/p/${id}/edit`,
            updatedTime: item.updatedTime || '',
            source: 'plugin_cached',
          })
        }
      }
    }

    const drafts = Array.from(merged.values()).slice(0, maxItems)
    return {
      action: 'list',
      count: drafts.length,
      drafts,
      note: '知乎创作者后台接口不总是实时返回网页端新建的文章草稿；此列表已同步验证本插件创建/打开过的草稿，若需操作网页端早先草稿可直接传入其 /p/<id>/edit 链接或 ID。',
    }
  }

  if (act === 'get') {
    const id = resolveArticleDraftId(articleId)
    if (!id) throw new ZhihuError('BAD_INPUT', '查看文章草稿需要传入 articleId 或 /p/<id>/edit 链接')
    const cur = await readDraftById(id)
    if (cur.state === 'draft') {
      upsertArticleDraftIndex(acc.id, {
        id,
        title: cur.title,
        summary: cur.summary,
        editUrl: cur.editUrl,
        updatedTime: cur.updatedTime,
      })
    }
    return { action: 'get', ...cur }
  }

  if (act === 'delete') {
    const id = resolveArticleDraftId(articleId)
    if (!id) throw new ZhihuError('BAD_INPUT', '删除文章草稿需要传入 articleId 或 /p/<id>/edit 链接')
    await zhihuFetchJson(`${ZHUANLAN}/api/articles/${id}/draft`, {
      account: acc,
      method: 'DELETE',
      extraHeaders: draftEditHeaders(id),
      allowEmpty: true,
    })
    removeArticleDraftIndex(acc.id, id)
    return {
      action: 'delete',
      deleted: true,
      articleId: id,
      editUrl: `${ZHUANLAN}/p/${id}/edit`,
    }
  }

  // action === 'save'
  const saveMode = ['create_only', 'append', 'overwrite', 'new'].includes(mode) ? mode : 'create_only'
  const titleTrimmed = String(title || '').trim()
  const hasNewContent = String(content || '').trim().length > 0
  const newHtml = hasNewContent ? markdownToZhihuHtml(content, format) : ''
  if (hasNewContent && !newHtml) throw new ZhihuError('BAD_INPUT', '草稿正文解析后为空')

  let targetId = articleId ? resolveArticleDraftId(articleId) : ''

  if (!targetId) {
    if (!titleTrimmed) throw new ZhihuError('BAD_INPUT', '新建专栏文章草稿请提供标题 title')
    if (!newHtml) throw new ZhihuError('BAD_INPUT', '新建专栏文章草稿请提供正文 content')
    if (saveMode !== 'new') {
      const normTitle = titleTrimmed.toLowerCase()
      const dup = readArticleDraftIndex(acc.id).find((item) => String(item?.title || '').trim().toLowerCase() === normTitle)
      if (dup?.id) {
        try {
          const liveDup = await readDraftById(dup.id)
          if (liveDup.state === 'draft') {
            if (saveMode === 'create_only') {
              return {
                action: 'save',
                saved: false,
                conflict: true,
                articleId: dup.id,
                editUrl: liveDup.editUrl,
                existingDraft: liveDup,
                hint: '草稿箱里已存在同名文章草稿，为避免重复创建或误覆盖已中止。请向用户确认：传入该 articleId 并指定 mode: \"overwrite\"（覆盖）或 mode: \"append\"（追加），或传入 mode: \"new\" 另建一篇新草稿。',
              }
            }
            targetId = dup.id
          }
        } catch (err) {
          if (err?.detail?.httpStatus === 404 || err?.detail?.httpStatus === 410) {
            removeArticleDraftIndex(acc.id, dup.id)
          }
        }
      }
    }
  }

  if (targetId) {
    const existing = await readDraftById(targetId)
    if ((existing.hasContent || existing.title) && saveMode === 'create_only') {
      return {
        action: 'save',
        saved: false,
        conflict: true,
        articleId: targetId,
        editUrl: existing.editUrl,
        existingDraft: existing,
        hint: '该文章草稿已有内容，为防止覆盖你手写的内容已中止保存。请向用户确认后传入 mode: \"overwrite\"（覆盖）或 mode: \"append\"（追加到末尾）。',
      }
    }
    const finalTitle = titleTrimmed || existing.title || '无标题草稿'
    const finalHtml = saveMode === 'append' && existing.contentHtml
      ? (newHtml ? `${existing.contentHtml}<hr/>${newHtml}` : existing.contentHtml)
      : (newHtml || existing.contentHtml)
    if (!finalHtml) throw new ZhihuError('BAD_INPUT', '文章草稿正文不能为空')

    await jitterDelay(650, 1150)
    await zhihuFetchJson(`${ZHUANLAN}/api/articles/${targetId}/draft`, {
      account: acc,
      method: 'PATCH',
      body: { title: finalTitle, content: finalHtml, delta_time: 1 },
      extraHeaders: draftEditHeaders(targetId),
      allowEmpty: true,
    })
    await jitterDelay(300, 500)
    const refreshed = await readDraftById(targetId)
    upsertArticleDraftIndex(acc.id, {
      id: targetId,
      title: refreshed.title || finalTitle,
      summary: refreshed.summary,
      editUrl: refreshed.editUrl,
      updatedTime: refreshed.updatedTime,
    })
    return {
      action: 'save',
      saved: true,
      created: false,
      mode: saveMode,
      articleId: targetId,
      editUrl: refreshed.editUrl,
      title: refreshed.title || finalTitle,
      draftCharLength: refreshed.charLength,
      summary: refreshed.summary,
      updatedTime: refreshed.updatedTime || new Date().toISOString(),
      note: '文章草稿已更新并保存到知乎（不会自动公开发布）。请打开 editUrl 审核并手动发布。',
    }
  }

  await jitterDelay(650, 1150)
  const createdRaw = await zhihuFetchJson(`${ZHUANLAN}/api/articles/drafts`, {
    account: acc,
    method: 'POST',
    body: { title: titleTrimmed, content: newHtml },
    extraHeaders: zlWriteHeaders,
  })
  const snap = formatArticleDraftSnapshot(createdRaw)
  if (!snap.articleId) throw new ZhihuError('HTTP_ERROR', '知乎未返回新创建的文章草稿 ID')
  upsertArticleDraftIndex(acc.id, {
    id: snap.articleId,
    title: snap.title || titleTrimmed,
    summary: snap.summary,
    editUrl: snap.editUrl,
    updatedTime: snap.updatedTime,
  })
  return {
    action: 'save',
    saved: true,
    created: true,
    mode: saveMode,
    articleId: snap.articleId,
    editUrl: snap.editUrl,
    title: snap.title || titleTrimmed,
    draftCharLength: snap.charLength,
    summary: snap.summary,
    updatedTime: snap.updatedTime || new Date().toISOString(),
    note: '新文章草稿已安全保存到知乎（不会自动公开发布）。请打开 editUrl 审核并手动发布。',
  }
}

// ─── QR Login & Risk-Control Session Manager ───
const qrAttempts = new Map()
let latestAttemptId = ''

function pruneExpiredAttempts(maxAgeAfterExpireMs = 30 * 60 * 1000) {
  const now = Date.now()
  for (const [key, item] of qrAttempts.entries()) {
    const exp = Number(item?.expiresAt || 0)
    if (exp > 0 && now - exp > maxAgeAfterExpireMs && key !== latestAttemptId) {
      qrAttempts.delete(key)
    }
  }
}

export function getLatestQrAttempt() {
  if (!latestAttemptId) return null
  return qrAttempts.get(latestAttemptId) || null
}

export function getQrAttempt(id) {
  return qrAttempts.get(id) || null
}

function sanitizeAttempt(a) {
  if (!a) return null
  return {
    id: a.id,
    kind: a.kind || 'qr',
    accountId: a.accountId || '',
    status: a.status,
    message: a.message,
    link: a.link || '',
    qrDataUrl: a.qrDataUrl || '',
    riskUrl: a.riskUrl || '',
    expiresAt: a.expiresAt || 0,
    accountName: a.accountName || '',
    updatedAt: a.updatedAt || 0,
  }
}

export const DEFAULT_RISK_URL = `${ORIGIN}/account/unhuman?type=S6E3V1&need_login=true`

function normalizeRiskUrl(candidate, html = '') {
  const raw = String(candidate || '').trim()
  if (/^https?:\/\/[^/]*zhihu\.com\/account\/unhuman/i.test(raw)) return raw
  if (html) {
    const m = String(html).match(/https?:\/\/[^"'\\\s<>]*zhihu\.com\/account\/unhuman[^"'\\\s<>]*/i)
    if (m?.[0]) return m[0]
  }
  return DEFAULT_RISK_URL
}

export function getRiskVerificationUrl(accountId = '') {
  const store = readStore()
  const targetId = String(accountId || store.activeId || '')
  const acc = targetId ? store.accounts[targetId] : null
  const fromAcc = String(acc?.blocked?.redirect || '').trim()
  if (/^https?:\/\/[^/]*zhihu\.com\/account\/unhuman/i.test(fromAcc)) return fromAcc
  const latest = getLatestQrAttempt()
  const fromAttempt = String(latest?.riskUrl || '').trim()
  if (/^https?:\/\/[^/]*zhihu\.com\/account\/unhuman/i.test(fromAttempt)) return fromAttempt
  return DEFAULT_RISK_URL
}

export function startAccountRiskSession(accountId = '') {
  pruneExpiredAttempts()
  const store = readStore()
  const targetId = String(accountId || store.activeId || '')
  const acc = targetId ? store.accounts[targetId] : null
  if (!acc) throw new Error('找不到要验证的知乎账号')
  const id = randomUUID()
  const session = {
    id,
    kind: 'account',
    accountId: acc.id,
    accountName: acc.name || acc.id,
    cookies: { ...(acc.cookies || {}) },
    status: 'risk_control',
    message: `请在下方完成账号「${acc.name || acc.id}」的知乎安全验证`,
    token: '',
    link: '',
    qrDataUrl: '',
    riskUrl: normalizeRiskUrl(acc.blocked?.redirect),
    expiresAt: Date.now() + 10 * 60 * 1000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  qrAttempts.set(id, session)
  latestAttemptId = id
  return sanitizeAttempt(session)
}

export function syncRiskSessionCookies(id, patchCookies) {
  const session = qrAttempts.get(id)
  if (!session || !patchCookies || typeof patchCookies !== 'object') return false
  const clean = {}
  for (const [k, v] of Object.entries(patchCookies)) {
    if (k && v !== undefined && v !== null && v !== '') clean[k] = String(v)
  }
  if (!Object.keys(clean).length) return false
  Object.assign(session.cookies, clean)
  session.updatedAt = Date.now()
  if (session.kind === 'account' && session.accountId) {
    updateAccountCookies(session.accountId, clean)
  }
  return true
}

export function completeAccountRiskSession(id) {
  const session = qrAttempts.get(id)
  if (!session) return { ok: false, error: '验证会话已失效' }
  if (session.kind === 'account' && session.accountId) {
    updateAccountCookies(session.accountId, session.cookies)
    setAccountBlocked(session.accountId, null)
    session.status = 'verified'
    session.updatedAt = Date.now()
    return { ok: true, accountId: session.accountId, accountName: session.accountName }
  }
  return { ok: true }
}

async function simpleRequest(url, { method = 'GET', headers = {}, body, cookies = {} } = {}) {
  const cookieStr = cookieHeader(cookies)
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(cookieStr ? { Cookie: cookieStr } : {}),
      ...headers,
    },
    body,
    redirect: 'manual',
  })
  const sc = parseSetCookies(res)
  Object.assign(cookies, sc)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, text, json }
}

export async function prewarmCookiesWithChromium() {
  const chromePath = findChromiumExecutable()
  if (!chromePath) return { ok: false, error: '未找到本机 Chrome / Edge / Chromium 可执行文件' }
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-zhihu-chrome-'))
  const proc = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=430,820', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  let wsUrl = ''
  proc.stderr.on('data', (d) => {
    const m = d.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/)
    if (m && !wsUrl) wsUrl = m[1]
  })
  try {
    const deadline = Date.now() + 10000
    while (!wsUrl && Date.now() < deadline) await sleep(100)
    if (!wsUrl) throw new Error('Chromium 启动超时')
    const baseHttp = wsUrl.replace('ws://', 'http://').split('/devtools/')[0]
    const targets = await (await fetch(`${baseHttp}/json/list`)).json()
    const page = targets.find((t) => t.type === 'page') || targets[0]
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    let seq = 1
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++seq
      const onMsg = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg)
          msg.error ? rej(new Error(msg.error.message || 'CDP error')) : res(msg.result)
        }
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Page.enable')
    await send('Network.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });',
    })
    await send('Emulation.setUserAgentOverride', { userAgent: DEFAULT_UA })
    await send('Page.navigate', { url: `${ORIGIN}/signin` })
    await sleep(3500)
    const ckRes = await send('Network.getAllCookies')
    const titleRes = await send('Runtime.evaluate', { expression: 'document.title' })
    ws.close()
    const cookies = {}
    for (const c of ckRes.cookies || []) {
      if (c.domain?.includes('zhihu.com')) cookies[c.name] = c.value
    }
    return { ok: true, cookies, title: titleRes?.result?.value || '' }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  } finally {
    try { proc.kill() } catch { /* ignore */ }
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

export async function startQrLogin({ inheritAttemptId = '', useChromiumPrewarm = false } = {}) {
  pruneExpiredAttempts()
  const id = randomUUID()
  const base = inheritAttemptId ? qrAttempts.get(inheritAttemptId) : getLatestQrAttempt()
  const cookies = base?.cookies ? { ...base.cookies } : {}
  const attempt = {
    id,
    kind: 'qr',
    accountId: '',
    cookies,
    status: 'starting',
    message: '正在初始化知乎扫码登录…',
    token: '',
    link: '',
    qrDataUrl: '',
    riskUrl: '',
    expiresAt: Date.now() + 180000,
    accountName: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  qrAttempts.set(id, attempt)
  latestAttemptId = id

  try {
    if (useChromiumPrewarm) {
      const pre = await prewarmCookiesWithChromium()
      if (pre.ok && pre.cookies) Object.assign(cookies, pre.cookies)
    }
    await simpleRequest(`${ORIGIN}/signin`, { cookies }).catch(() => null)
    await simpleRequest(`${ORIGIN}/udid`, {
      method: 'POST',
      cookies,
      headers: { Referer: `${ORIGIN}/signin`, Origin: ORIGIN },
      body: '',
    }).catch(() => null)

    const qrRes = await simpleRequest(`${ORIGIN}/api/v3/account/api/login/qrcode`, {
      method: 'POST',
      cookies,
      headers: {
        Referer: `${ORIGIN}/signin`,
        Origin: ORIGIN,
        ...(cookies._xsrf ? { 'x-xsrftoken': cookies._xsrf } : {}),
      },
      body: '{}',
    })
    const data = qrRes.json?.data || qrRes.json || {}
    const token = data.token || data.qrcode_token
    const link = data.link
    if (qrRes.status >= 400 || !token || !link) {
      attempt.status = 'failed'
      attempt.message = data?.error?.message || `获取知乎二维码失败（HTTP ${qrRes.status}）`
      attempt.updatedAt = Date.now()
      return sanitizeAttempt(attempt)
    }
    attempt.token = token
    attempt.link = link
    attempt.expiresAt = data.expires_at ? (Number(data.expires_at) < 1e10 ? Number(data.expires_at) * 1000 : Number(data.expires_at)) : (Date.now() + 180000)
    attempt.qrDataUrl = await QRCode.toDataURL(link, { width: 220, margin: 1 })
    attempt.status = 'waiting'
    attempt.message = '请用手机知乎 App 扫一扫二维码登录'
    attempt.updatedAt = Date.now()
    return sanitizeAttempt(attempt)
  } catch (err) {
    attempt.status = 'failed'
    attempt.message = err?.message || String(err)
    attempt.updatedAt = Date.now()
    return sanitizeAttempt(attempt)
  }
}

export async function pollQrLogin(id = '') {
  const attempt = id ? qrAttempts.get(id) : getLatestQrAttempt()
  if (!attempt) {
    return { ok: false, status: 'none', message: '还没有生成二维码，请先点击生成。' }
  }
  if (attempt.status === 'succeeded') return { ok: true, ...sanitizeAttempt(attempt) }
  if (Date.now() > attempt.expiresAt) {
    attempt.status = 'expired'
    attempt.message = '二维码已过期，请重新生成。'
    attempt.updatedAt = Date.now()
    return { ok: true, ...sanitizeAttempt(attempt) }
  }

  const scanUrl = `${ORIGIN}/api/v3/account/api/login/qrcode/${attempt.token}/scan_info`
  const signed = signHeaders(scanUrl, attempt.cookies.d_c0 || '')
  const res = await simpleRequest(scanUrl, {
    cookies: attempt.cookies,
    headers: {
      Referer: `${ORIGIN}/signin`,
      Origin: ORIGIN,
      ...(attempt.cookies._xsrf ? { 'x-xsrftoken': attempt.cookies._xsrf } : {}),
      ...signed,
    },
  })
  const info = res.json?.data || res.json || {}
  if (info.z_c0) attempt.cookies.z_c0 = info.z_c0

  if (res.status === 403 || info?.error?.code === 40352 || info?.error?.need_login) {
    attempt.status = 'risk_control'
    attempt.riskUrl = normalizeRiskUrl(info?.error?.redirect)
    attempt.message = info?.error?.message || '触发知乎安全验证，请先在同源控制台完成人机验证后再刷新或重试扫码。'
    attempt.updatedAt = Date.now()
    return { ok: true, ...sanitizeAttempt(attempt) }
  }
  if (info.status === 2) {
    attempt.status = 'expired'
    attempt.message = '二维码已过期，请重新生成。'
    attempt.updatedAt = Date.now()
    return { ok: true, ...sanitizeAttempt(attempt) }
  }
  if (info.user_id || info.access_token || attempt.cookies.z_c0) {
    await simpleRequest(`${ORIGIN}/`, { cookies: attempt.cookies }).catch(() => null)
    const meRes = await simpleRequest(`${ORIGIN}/api/v4/me`, {
      cookies: attempt.cookies,
      headers: {
        Referer: `${ORIGIN}/`,
        ...signHeaders(`${ORIGIN}/api/v4/me`, attempt.cookies.d_c0 || ''),
      },
    }).catch(() => null)
    if (attempt.cookies.z_c0) {
      const me = meRes?.json || {}
      const uid = String(me.uid || me.id || info.user_id || randomUUID())
      const saved = upsertAccount({
        id: uid,
        name: me.name || `知乎用户_${uid.slice(-4)}`,
        urlToken: me.url_token || '',
        isVip: Boolean(me.vip_info?.is_vip),
        cookies: { ...attempt.cookies },
        userAgent: DEFAULT_UA,
      })
      attempt.status = 'succeeded'
      attempt.accountName = saved.name
      attempt.message = `扫码登录成功！已保存账号「${saved.name}」。`
      attempt.updatedAt = Date.now()
      return { ok: true, ...sanitizeAttempt(attempt) }
    }
  }
  if (info.status === 1) {
    attempt.status = 'scanned'
    attempt.message = '已扫码，请在知乎 App 上点击确认登录。'
  } else {
    attempt.status = 'waiting'
    attempt.message = '等待扫码确认中…'
  }
  attempt.updatedAt = Date.now()
  return { ok: true, ...sanitizeAttempt(attempt) }
}
