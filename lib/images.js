import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DEFAULT_UA, IMAGE_READ_MODES, imageCacheDir, readSettings } from './store.js'

const ORIGIN = 'https://www.zhihu.com'

export function decodeHtmlEntities(str) {
  if (!str) return ''
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''
    })
}

export function normalizeZhihuImgUrl(rawUrl) {
  let u = decodeHtmlEntities(String(rawUrl || '').trim())
  if (!u || /^data:/i.test(u)) return ''
  if (u.startsWith('//')) u = 'https:' + u
  if (!/^https?:\/\//i.test(u)) return ''
  return u
}

export function isAllowedZhimgUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase()
    return host === 'zhimg.com' || host.endsWith('.zhimg.com')
  } catch {
    return false
  }
}

function zhimgCacheKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim())
    if (u.hostname.toLowerCase().endsWith('.zhimg.com')) return u.pathname
    return `${u.hostname}${u.pathname}`
  } catch {
    return String(rawUrl || '').split('?')[0]
  }
}

function getHtmlAttr(tag, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = String(tag || '').match(re)
  return m ? decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : ''
}

function replaceMathImgs(html) {
  return String(html || '').replace(/<img\b[^>]*>/gi, (tag) => {
    const formula = getHtmlAttr(tag, 'data-formula')
    if (formula) return `$${formula}$`
    const src = getHtmlAttr(tag, 'src')
    const eqMatch = src.match(/zhihu\.com\/equation\?tex=([^&]+)/i)
    if (eqMatch) {
      try {
        return `$${decodeURIComponent(eqMatch[1].replace(/\+/g, ' '))}$`
      } catch {
        return `$${eqMatch[1]}$`
      }
    }
    return tag
  })
}

export function resolveImageMode(override, cfg = readSettings()) {
  if (override === true) return 'auto'
  if (override === false) return 'off'
  const s = String(override ?? '').trim().toLowerCase()
  if (IMAGE_READ_MODES.includes(s)) return s
  return IMAGE_READ_MODES.includes(cfg?.imageReadMode) ? cfg.imageReadMode : 'index'
}

export function extractHtmlWithImages(html, { maxLen = 2500, includeImages = true, maxImages = 30 } = {}) {
  if (!html) return { text: '', images: [] }
  const images = []
  const seenKeys = new Map()

  const registerImage = (preferredUrl, originalUrl, caption) => {
    const url = normalizeZhihuImgUrl(preferredUrl) || normalizeZhihuImgUrl(originalUrl)
    if (!url) return null
    const orig = normalizeZhihuImgUrl(originalUrl) || url
    const dedupeKey = zhimgCacheKey(url)
    const cleanCaption = String(caption || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (seenKeys.has(dedupeKey)) {
      const existing = seenKeys.get(dedupeKey)
      if (!existing.caption && cleanCaption) existing.caption = cleanCaption
      return existing
    }
    const item = {
      index: images.length + 1,
      url,
      ...(orig !== url ? { originalUrl: orig } : {}),
      ...(cleanCaption ? { caption: cleanCaption } : {}),
    }
    images.push(item)
    seenKeys.set(dedupeKey, item)
    return item
  }

  let text = replaceMathImgs(String(html))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')

  text = text.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_full, inner) => {
    const capMatch = inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)
    const rawCaption = capMatch
      ? decodeHtmlEntities(capMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      : ''
    const imgTags = inner.match(/<img\b[^>]*>/gi) || []
    let preferred = ''
    let original = ''
    let alt = ''
    for (const tag of imgTags) {
      const actual = normalizeZhihuImgUrl(getHtmlAttr(tag, 'data-actualsrc'))
      const orig = normalizeZhihuImgUrl(getHtmlAttr(tag, 'data-original'))
      const src = normalizeZhihuImgUrl(getHtmlAttr(tag, 'src'))
      if (!alt) alt = getHtmlAttr(tag, 'alt')
      if (!original && orig) original = orig
      if (!preferred && actual) preferred = actual
      if (!preferred && src) preferred = src
    }
    const caption = rawCaption || alt
    const item = registerImage(preferred, original, caption)
    if (!item || !includeImages) return rawCaption ? `\n${rawCaption}\n` : ''
    return `\n[图${item.index}${item.caption ? `: ${item.caption}` : ''}]\n`
  })

  text = text.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs, inner) => {
    const cls = getHtmlAttr(attrs, 'class')
    const href = normalizeZhihuImgUrl(getHtmlAttr(attrs, 'href'))
    const isCommentImg = /\b(comment_img|comment_sticker|comment_gif)\b/i.test(cls)
    const isZhimgLink = href && isAllowedZhimgUrl(href) && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(href)
    if (!isCommentImg && !isZhimgLink) return full
    const innerText = decodeHtmlEntities(String(inner || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    const isGenericLabel = !innerText || /^(查看图片|查看表情|查看动图|图片)$/i.test(innerText)
    const caption = isGenericLabel ? (/\bcomment_sticker\b/i.test(cls) ? '评论表情' : '') : innerText
    const item = registerImage(href, href, caption)
    if (!item || !includeImages) return isGenericLabel ? '[图片]' : `[图片:${innerText}]`
    return ` [图${item.index}${item.caption ? `: ${item.caption}` : ''}] `
  })
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const actual = normalizeZhihuImgUrl(getHtmlAttr(tag, 'data-actualsrc'))
    const orig = normalizeZhihuImgUrl(getHtmlAttr(tag, 'data-original'))
    const src = normalizeZhihuImgUrl(getHtmlAttr(tag, 'src'))
    const alt = getHtmlAttr(tag, 'alt')
    const item = registerImage(actual || src, orig, alt)
    if (!item || !includeImages) return alt ? `[图片:${alt}]` : ''
    return `\n[图${item.index}${item.caption ? `: ${item.caption}` : ''}]\n`
  })

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<blockquote[^>]*>/gi, '> ')
    .replace(/<[^>]+>/g, '')

  text = decodeHtmlEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (maxLen > 0 && text.length > maxLen) {
    text = text.slice(0, maxLen) + '…(已截断)'
  }
  return {
    text,
    images: includeImages ? images.slice(0, Math.max(0, maxImages)) : [],
  }
}

export function cleanHtml(html, maxLen = 2500) {
  return extractHtmlWithImages(html, { maxLen, includeImages: false }).text
}

function extFromContentType(contentType, url = '') {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  const m = String(url).split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i)
  return m ? ('.' + m[1].toLowerCase().replace('jpeg', 'jpg')) : '.jpg'
}

export function cleanupImageCache({ maxAgeMs = 24 * 3600 * 1000, maxFiles = 80 } = {}) {
  const dir = imageCacheDir()
  if (!existsSync(dir)) return { removed: 0 }
  const now = Date.now()
  let entries = []
  try {
    entries = readdirSync(dir)
      .map((name) => {
        const full = join(dir, name)
        try {
          const st = statSync(full)
          if (!st.isFile()) return null
          return { full, mtimeMs: st.mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return { removed: 0 }
  }

  let removed = 0
  const kept = []
  for (const e of entries) {
    if (now - e.mtimeMs > maxAgeMs) {
      try { rmSync(e.full, { force: true }); removed++ } catch { /* ignore */ }
    } else {
      kept.push(e)
    }
  }
  if (kept.length > maxFiles) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const excess = kept.length - maxFiles
    for (let i = 0; i < excess; i++) {
      try { rmSync(kept[i].full, { force: true }); removed++ } catch { /* ignore */ }
    }
  }
  return { removed }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function downloadZhihuImages(inputUrls, { maxCount } = {}) {
  const cfg = readSettings()
  const limit = Math.max(1, Math.min(15, Math.trunc(Number(maxCount) || cfg.maxImagesPerItem || 4)))
  const rawList = Array.isArray(inputUrls)
    ? inputUrls
    : String(inputUrls || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)

  const targets = []
  const seen = new Set()
  for (const entry of rawList) {
    const rawUrl = typeof entry === 'string' ? entry : (entry?.url || entry?.originalUrl || '')
    const url = normalizeZhihuImgUrl(rawUrl)
    if (!url) continue
    const key = zhimgCacheKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({
      url,
      caption: typeof entry === 'object' && entry?.caption ? String(entry.caption) : '',
      index: typeof entry === 'object' && Number.isFinite(Number(entry?.index)) ? Number(entry.index) : targets.length + 1,
    })
    if (targets.length >= limit) break
  }

  if (targets.length === 0) {
    throw new Error('请提供至少一个有效的知乎图片链接（*.zhimg.com）')
  }

  const dir = imageCacheDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  cleanupImageCache()

  const items = []
  const MAX_BYTES = 10 * 1024 * 1024
  const exts = ['.jpg', '.png', '.webp', '.gif']

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (!isAllowedZhimgUrl(t.url)) {
      items.push({ index: t.index, url: t.url, ok: false, error: '仅允许下载知乎图床（*.zhimg.com）图片' })
      continue
    }

    const hash = createHash('sha1').update(zhimgCacheKey(t.url)).digest('hex').slice(0, 16)
    let cachedPath = ''
    for (const ext of exts) {
      const candidate = join(dir, `zhimg-${hash}${ext}`)
      try {
        if (existsSync(candidate) && statSync(candidate).size > 0) {
          cachedPath = candidate
          break
        }
      } catch { /* ignore */ }
    }
    if (cachedPath) {
      const st = statSync(cachedPath)
      items.push({
        index: t.index,
        url: t.url,
        ...(t.caption ? { caption: t.caption } : {}),
        ok: true,
        cached: true,
        localPath: cachedPath,
        bytes: st.size,
      })
      continue
    }

    if (i > 0) await sleepMs(120 + Math.floor(Math.random() * 140))
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15000)
      let res
      try {
        res = await fetch(t.url, {
          method: 'GET',
          headers: {
            'User-Agent': DEFAULT_UA,
            'Referer': `${ORIGIN}/`,
            'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: ctrl.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        items.push({ index: t.index, url: t.url, ok: false, error: `HTTP ${res.status}` })
        continue
      }
      const contentType = String(res.headers.get('content-type') || '').toLowerCase()
      if (contentType && !contentType.startsWith('image/')) {
        items.push({ index: t.index, url: t.url, ok: false, error: `非图片响应：${contentType}` })
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) {
        items.push({ index: t.index, url: t.url, ok: false, error: '图片内容为空' })
        continue
      }
      if (buf.length > MAX_BYTES) {
        items.push({ index: t.index, url: t.url, ok: false, error: `图片超过 10MB 限制（${buf.length} 字节）` })
        continue
      }
      const ext = extFromContentType(contentType, t.url)
      const filePath = join(dir, `zhimg-${hash}${ext}`)
      writeFileSync(filePath, buf, { mode: 0o600 })
      items.push({
        index: t.index,
        url: t.url,
        ...(t.caption ? { caption: t.caption } : {}),
        ok: true,
        cached: false,
        localPath: filePath,
        contentType: contentType || 'image/jpeg',
        bytes: buf.length,
      })
    } catch (err) {
      items.push({
        index: t.index,
        url: t.url,
        ok: false,
        error: err?.name === 'AbortError' ? '下载超时（15s）' : (err?.message || '下载失败'),
      })
    }
  }

  return {
    cacheDir: dir,
    requestedCount: targets.length,
    downloadedCount: items.filter((x) => x.ok).length,
    items,
    hint: '已将图片下载到本机临时缓存（24小时自动清理），可直接用 read_image 工具查看各 localPath。',
  }
}
