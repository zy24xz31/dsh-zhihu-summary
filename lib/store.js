import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export function stateDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-zhihu-summary')
}

export function accountsFile() {
  return join(stateDir(), 'accounts.json')
}

function emptyStore() {
  return { version: 1, activeId: '', accounts: {} }
}

const COOKIE_ATTR_RE = /^(domain|path|expires|max-age|samesite|priority|secure|httponly|partitioned|version|comment)$/i
const NOISE_COOKIE_RE = /^Hm_ck_\d+$/i

export function isNoiseOrAttrCookie(name) {
  const k = String(name || '').trim()
  if (!k || /[\r\n\s;=]/.test(k)) return true
  return COOKIE_ATTR_RE.test(k) || NOISE_COOKIE_RE.test(k)
}

export function sanitizeCookies(cookieMap) {
  const clean = {}
  for (const [rawK, rawV] of Object.entries(cookieMap || {})) {
    const k = String(rawK || '').trim()
    const v = rawV === undefined || rawV === null ? '' : String(rawV).trim()
    if (!v || isNoiseOrAttrCookie(k) || /[\r\n]/.test(v)) continue
    clean[k] = v
  }
  return clean
}

export function parseSingleSetCookie(line) {
  const kv = String(line || '').split(';')[0]
  const idx = kv.indexOf('=')
  if (idx <= 0) return {}
  const k = kv.slice(0, idx).trim()
  const v = kv.slice(idx + 1).trim()
  if (!v || isNoiseOrAttrCookie(k) || /[\r\n]/.test(v)) return {}
  return { [k]: v }
}

export function readStore() {
  try {
    const raw = JSON.parse(readFileSync(accountsFile(), 'utf8'))
    if (raw && raw.version === 1 && raw.accounts && typeof raw.accounts === 'object') {
      const accounts = {}
      for (const [id, acc] of Object.entries(raw.accounts)) {
        if (!acc || typeof acc !== 'object') continue
        accounts[id] = { ...acc, cookies: sanitizeCookies(acc.cookies) }
      }
      return { version: 1, activeId: String(raw.activeId || ''), accounts }
    }
  } catch { /* ignore */ }
  return emptyStore()
}

function atomicWriteFile(file, content, fileMode = 0o600) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, { mode: fileMode })
    try {
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, content, { mode: fileMode })
    }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

export function writeStore(store) {
  const file = accountsFile()
  const sanitizedAccounts = {}
  for (const [id, acc] of Object.entries(store?.accounts || {})) {
    if (!acc || typeof acc !== 'object') continue
    sanitizedAccounts[id] = { ...acc, cookies: sanitizeCookies(acc.cookies) }
  }
  const payload = { version: 1, activeId: String(store?.activeId || ''), accounts: sanitizedAccounts }
  atomicWriteFile(file, JSON.stringify(payload, null, 2), 0o600)
  return payload
}

export function parseCookieString(raw) {
  const map = {}
  for (const part of String(raw || '').split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (v && !isNoiseOrAttrCookie(k) && !/[\r\n]/.test(v)) map[k] = v
  }
  return map
}

export function cookieHeader(cookieMap) {
  return Object.entries(sanitizeCookies(cookieMap))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

export function getActiveAccount(store = readStore()) {
  if (!store.activeId) return null
  return store.accounts[store.activeId] || null
}

export function listPublicAccounts(store = readStore()) {
  return Object.values(store.accounts).map((a) => ({
    id: a.id,
    name: a.name || a.id,
    urlToken: a.urlToken || '',
    isVip: Boolean(a.isVip),
    active: a.id === store.activeId,
    hasZc0: Boolean(a.cookies?.z_c0),
    hasDc0: Boolean(a.cookies?.d_c0),
    updatedAt: a.updatedAt || 0,
    blocked: a.blocked ? { code: a.blocked.code || null, message: a.blocked.message || '', redirect: a.blocked.redirect || '', at: a.blocked.at || 0 } : null,
  }))
}

export function upsertAccount({ id, name, urlToken, isVip, cookies, userAgent }) {
  const store = readStore()
  const prev = store.accounts[id] || {}
  store.accounts[id] = {
    id,
    name: name || prev.name || id,
    urlToken: urlToken || prev.urlToken || '',
    isVip: isVip ?? prev.isVip ?? false,
    userAgent: userAgent || prev.userAgent || DEFAULT_UA,
    cookies: sanitizeCookies({ ...(prev.cookies || {}), ...(cookies || {}) }),
    updatedAt: Date.now(),
    blocked: null,
  }
  store.activeId = id
  writeStore(store)
  return store.accounts[id]
}

export function switchAccount(id) {
  const store = readStore()
  if (!store.accounts[id]) throw new Error(`找不到账号：${id}`)
  store.activeId = id
  writeStore(store)
  return store.accounts[id]
}

export function removeAccount(id) {
  const store = readStore()
  if (!store.accounts[id]) return false
  delete store.accounts[id]
  if (store.activeId === id) {
    store.activeId = Object.keys(store.accounts)[0] || ''
  }
  writeStore(store)
  return true
}

export function updateAccountCookies(id, patchCookies) {
  if (!id || !patchCookies || !Object.keys(patchCookies).length) return
  const store = readStore()
  const acc = store.accounts[id]
  if (!acc) return
  acc.cookies = sanitizeCookies({ ...(acc.cookies || {}), ...patchCookies })
  acc.updatedAt = Date.now()
  writeStore(store)
}

export function setAccountBlocked(id, blocked) {
  if (!id) return
  const store = readStore()
  const acc = store.accounts[id]
  if (!acc) return
  acc.blocked = blocked ? { ...blocked, at: Date.now() } : null
  writeStore(store)
}

export const IMAGE_READ_MODES = ['off', 'index', 'auto']

export const DEFAULT_SETTINGS = {
  homeLimit: 10,
  homeMaxChars: 15000,
  hotQuestions: 5,
  hotAnswersPerQuestion: 3,
  hotMaxChars: 10000,
  yanxuanTrialMaxChars: 15000,
  readUrlMaxChars: 60000,
  imageReadMode: 'index',
  maxImagesPerItem: 4,
}

export function settingsFile() {
  return join(stateDir(), 'config.json')
}

export function imageCacheDir() {
  return join(stateDir(), 'img-cache')
}

function clampInt(val, fallback, min, max) {
  const unwrapped = (val && typeof val === "object" && typeof val.get === "function") ? val.get() : val
  const n = Number(unwrapped)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function clampImageMode(val, fallback) {
  const unwrapped = (val && typeof val === 'object' && typeof val.get === 'function') ? val.get() : val
  const s = String(unwrapped ?? '').trim().toLowerCase()
  if (IMAGE_READ_MODES.includes(s)) return s
  return IMAGE_READ_MODES.includes(fallback) ? fallback : DEFAULT_SETTINGS.imageReadMode
}

export function clampSettings(raw = {}, base = DEFAULT_SETTINGS) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const fb = base && typeof base === 'object' ? base : DEFAULT_SETTINGS
  return {
    homeLimit: clampInt(src.homeLimit, fb.homeLimit ?? DEFAULT_SETTINGS.homeLimit, 1, 20),
    homeMaxChars: clampInt(src.homeMaxChars, fb.homeMaxChars ?? DEFAULT_SETTINGS.homeMaxChars, 1000, 100000),
    hotQuestions: clampInt(src.hotQuestions, fb.hotQuestions ?? DEFAULT_SETTINGS.hotQuestions, 1, 20),
    hotAnswersPerQuestion: clampInt(src.hotAnswersPerQuestion, fb.hotAnswersPerQuestion ?? DEFAULT_SETTINGS.hotAnswersPerQuestion, 1, 10),
    hotMaxChars: clampInt(src.hotMaxChars, fb.hotMaxChars ?? DEFAULT_SETTINGS.hotMaxChars, 1000, 100000),
    yanxuanTrialMaxChars: clampInt(src.yanxuanTrialMaxChars, fb.yanxuanTrialMaxChars ?? DEFAULT_SETTINGS.yanxuanTrialMaxChars, 3000, 100000),
    readUrlMaxChars: clampInt(src.readUrlMaxChars, fb.readUrlMaxChars ?? DEFAULT_SETTINGS.readUrlMaxChars, 5000, 200000),
    imageReadMode: clampImageMode(src.imageReadMode, fb.imageReadMode ?? DEFAULT_SETTINGS.imageReadMode),
    maxImagesPerItem: clampInt(src.maxImagesPerItem, fb.maxImagesPerItem ?? DEFAULT_SETTINGS.maxImagesPerItem, 1, 15),
  }
}

export function hasSettingsFile() {
  return existsSync(settingsFile())
}

export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return clampSettings(raw, DEFAULT_SETTINGS)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function writeSettings(patch = {}, { reset = false } = {}) {
  const base = reset ? DEFAULT_SETTINGS : readSettings()
  const next = clampSettings(reset ? patch : { ...base, ...(patch || {}) }, DEFAULT_SETTINGS)
  atomicWriteFile(settingsFile(), JSON.stringify(next, null, 2), 0o600)
  return next
}

export function articleDraftsFile() {
  return join(stateDir(), 'article-drafts.json')
}

function readAllArticleDraftIndexes() {
  try {
    const raw = JSON.parse(readFileSync(articleDraftsFile(), 'utf8'))
    if (raw && raw.version === 1 && raw.byAccount && typeof raw.byAccount === 'object') {
      return raw
    }
  } catch { /* ignore */ }
  return { version: 1, byAccount: {} }
}

function writeAllArticleDraftIndexes(payload) {
  atomicWriteFile(articleDraftsFile(), JSON.stringify(payload, null, 2), 0o600)
}

export function readArticleDraftIndex(accountId) {
  if (!accountId) return []
  const all = readAllArticleDraftIndexes()
  const list = all.byAccount?.[String(accountId)]
  return Array.isArray(list) ? list : []
}

export function upsertArticleDraftIndex(accountId, entry) {
  const aid = String(accountId || '')
  const id = String(entry?.id || '').trim()
  if (!aid || !id) return []
  const all = readAllArticleDraftIndexes()
  const prev = Array.isArray(all.byAccount[aid]) ? all.byAccount[aid] : []
  const filtered = prev.filter((item) => String(item?.id || '') !== id)
  const nextEntry = {
    id,
    title: String(entry?.title || '').trim(),
    summary: String(entry?.summary || '').trim(),
    editUrl: String(entry?.editUrl || `https://zhuanlan.zhihu.com/p/${id}/edit`),
    updatedTime: String(entry?.updatedTime || ''),
    savedAt: Number(entry?.savedAt) || Date.now(),
  }
  const nextList = [nextEntry, ...filtered].slice(0, 60)
  all.byAccount[aid] = nextList
  writeAllArticleDraftIndexes(all)
  return nextList
}

export function removeArticleDraftIndex(accountId, articleId) {
  const aid = String(accountId || '')
  const id = String(articleId || '').trim()
  if (!aid || !id) return []
  const all = readAllArticleDraftIndexes()
  const prev = Array.isArray(all.byAccount[aid]) ? all.byAccount[aid] : []
  const nextList = prev.filter((item) => String(item?.id || '') !== id)
  if (nextList.length !== prev.length) {
    all.byAccount[aid] = nextList
    writeAllArticleDraftIndexes(all)
  }
  return nextList
}
