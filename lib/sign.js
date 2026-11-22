import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('./zse96-core.cjs')

export const ZSE_93 = '101_3_3.0'

export function signHeaders(rawUrl, dc0, body = '', xZst81 = '') {
  const u = new URL(rawUrl, 'https://www.zhihu.com')
  const pathAndQuery = `${u.pathname}${u.search}`
  const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '')
  const src = [ZSE_93, pathAndQuery, dc0 || '', bodyStr && bodyStr.length <= 4096 ? bodyStr : '', xZst81 || '']
    .filter(Boolean)
    .join('+')
  const md5Hex = createHash('md5').update(src).digest('hex')
  const sig = `2.0_${core.encryptMd5(md5Hex)}`
  const headers = {
    'x-zse-93': ZSE_93,
    'x-zse-96': sig,
  }
  if (xZst81) headers['x-zst-81'] = xZst81
  return headers
}
