import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function pushAncestors(entryPath, out) {
  if (!entryPath) return
  try {
    const resolved = existsSync(entryPath) ? realpathSync(entryPath) : entryPath
    let cur = dirname(resolved)
    for (let i = 0; i < 8; i++) {
      const candidate = join(cur, 'node_modules', '@deepseek-ai')
      if (!out.includes(candidate)) out.push(candidate)
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch { /* ignore */ }
}

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  pushAncestors(process.argv?.[1], out)
  pushAncestors(process.execPath, out)
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(appData, 'npm', 'node_modules', '@deepseek-ai'))
    push(join(localAppData, 'pnpm', 'global', '5', 'node_modules', '@deepseek-ai'))
    push(join(localAppData, 'Programs', 'dsh', 'resources', 'app', 'node_modules', '@deepseek-ai'))
  } else {
    push('/opt/dsh/node_modules/@deepseek-ai')
    push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
    push('/usr/local/lib/node_modules/@deepseek-ai')
    push('/usr/lib/node_modules/@deepseek-ai')
  }
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* ignore */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch {
    return null
  }
}

async function fromHostTree(name) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { return await import(url) } catch { /* try next */ }
  }
  return null
}

function localDefineTool(options) {
  return options
}

export async function loadHostDeps() {
  let dtMod = await fromHostTree('dsh-tools')
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools') } catch { dtMod = null }
  }
  let zMod = await fromHostTree('schemastery')
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery') } catch { zMod = null }
  }
  const defineTool = dtMod?.defineTool || localDefineTool
  const z = zMod?.default || zMod?.z || zMod || null
  return { defineTool, z: (z && typeof z.object === 'function') ? z : null }
}
