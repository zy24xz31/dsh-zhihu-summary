import {
  checkActiveAccountHealth,
  completeAccountRiskSession,
  getLatestQrAttempt,
  getQrAttempt,
  pollQrLogin,
  startAccountRiskSession,
  startQrLogin,
  syncRiskSessionCookies,
  verifyAndSaveCookieString,
} from './zhihu-api.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_UA,
  readSettings,
  writeSettings,
  cookieHeader,
  getActiveAccount,
  listPublicAccounts,
  parseCookieString,
  parseSingleSetCookie,
  removeAccount,
  setAccountBlocked,
  switchAccount,
} from './store.js'

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', body.length)
  res.end(body)
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', body.length)
  res.end(body)
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('JSON 格式不正确')
  }
}

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  const m172 = h.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true
  const m100 = h.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m100 && Number(m100[1]) >= 64 && Number(m100[1]) <= 127) return true
  return false
}

function sameOriginOk(req, hasHostAuth = false) {
  try {
    const host = String(req.headers.host || '')
    if (!host) return true
    if (!hasHostAuth) {
      const hObj = new URL('http://' + host)
      if (!isPrivateOrLoopbackHost(hObj.hostname)) return false
    }
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase()
    if (sfs === 'cross-site') return false
    const pick = String(req.headers.origin || req.headers.referer || '')
    if (!pick) return true
    if (pick === 'null') return false
    try {
      const u = new URL(pick)
      const h = new URL('http://' + host)
      const hp = (h.port || '80')
      const up = (u.port || (u.protocol === 'https:' ? '443' : '80'))
      return u.hostname.toLowerCase() === h.hostname.toLowerCase() && up === hp
    } catch {
      return false
    }
  } catch {
    return false
  }
}

const STATIC_ZHIHU_HOST_RE = /^(static|zhstatic|pic\d*|pica|picx)\./i

function isProxiedZhihuHost(hostname) {
  return /(^|\.)zhihu\.com$/i.test(hostname) && !STATIC_ZHIHU_HOST_RE.test(hostname)
}

function rewriteRiskHtml(html, sessionId, targetHost = 'www.zhihu.com', origPath = '/account/unhuman', sessionCookies = {}) {
  const prefix = '/zhihu/risk-proxy'
  const eid = encodeURIComponent(sessionId)
  const toProx = (host, p) => {
    const cleanP = p.startsWith('/') ? p : '/' + p
    return `${prefix}/__host/${host}${cleanP}${cleanP.includes('?') ? '&' : '?'}_aid=${eid}`
  }
  const rewritten = html
    .replace(/(href|src|action)=(["'])https:\/\/([a-z0-9-]+\.zhihu\.com)([^"']*)\2/gi, (m, a, q, h, p) => {
      if (!isProxiedZhihuHost(h)) return m
      return `${a}=${q}${toProx(h, p)}${q}`
    })
    .replace(/(href|src|action)=(["'])(\/(?!\/)[^"']*)\2/gi, (_m, a, q, p) => `${a}=${q}${toProx(targetHost, p)}${q}`)

  const seedCookies = Object.entries(sessionCookies || {})
    .filter(([k, v]) => ['d_c0', '_xsrf', '_zap', 'sec_token', 'captcha_session_v2', 'SESSIONID', 'JOID', 'osd', '__zse_ck', 'KLBRSID', 'tgw_l7_route'].includes(k) && v)
    .map(([k, v]) => `${k}=${v}; path=/`)

  const hook = '<script>(() => {' +
    'const aid = ' + JSON.stringify(sessionId) + ';' +
    'const curHost = ' + JSON.stringify(targetHost) + ';' +
    'const origPath = ' + JSON.stringify(origPath) + ';' +
    'const seedCookies = ' + JSON.stringify(seedCookies) + ';' +
    'const prefix = "/zhihu/risk-proxy";' +
    'try { history.replaceState(null, "", origPath); } catch (e) {}' +
    'const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");' +
    'if (desc && desc.set) { for (const c of seedCookies) { try { desc.set.call(document, c); } catch (e) {} } }' +
    'let passedSent = false;' +
    'const notifyPassed = () => {' +
      'if (passedSent) return; passedSent = true;' +
      'try { window.parent && window.parent !== window && window.parent.postMessage({ type: "zhihu-risk-passed", id: aid }, location.origin); } catch (e) {}' +
    '};' +
    'const isAppealUrl = (u) => {' +
      'const s = String(u || "").toLowerCase();' +
      'return s.includes("/anticrawl/new_captcha_appeal") || s.includes("/anticrawl/check_unblock") || s.includes("/antispam/captcha_appeal");' +
    '};' +
    'const checkPassPayload = (urlStr, txt) => {' +
      'if (!isAppealUrl(urlStr)) return;' +
      'try {' +
        'const d = JSON.parse(txt);' +
        'if (d && !d.error && (d.blockLevel === 0 || d.block_level === 0 || d.code === 0 || d.success === true)) notifyPassed();' +
      '} catch (e) {}' +
    '};' +
    'const prox = (u) => {' +
      'try {' +
        'const x = new URL(u, location.href);' +
        'if (x.origin === location.origin && x.pathname.startsWith("/zhihu/")) return x.href;' +
        'if (x.origin === location.origin) {' +
          'x.searchParams.set("_aid", aid);' +
          'return prefix + "/__host/" + curHost + x.pathname + x.search + x.hash;' +
        '}' +
        'const h = x.hostname.toLowerCase();' +
        'const isZh = h === "zhihu.com" || h.endsWith(".zhihu.com");' +
        'const isStatic = h.startsWith("static.") || h.startsWith("zhstatic.") || h.startsWith("pica.") || h.startsWith("picx.") || h.startsWith("pic1.") || h.startsWith("pic2.") || h.startsWith("pic3.") || h.startsWith("pic4.");' +
        'if (isZh && !isStatic) {' +
          'x.searchParams.set("_aid", aid);' +
          'return prefix + "/__host/" + h + x.pathname + x.search + x.hash;' +
        '}' +
        'return u;' +
      '} catch (e) { return u; }' +
    '};' +
    'const origFetch = window.fetch;' +
    'if (origFetch) {' +
      'window.fetch = function(u, o) {' +
        'const rawUrl = typeof u === "string" ? u : (u && u.url ? u.url : String(u));' +
        'const target = prox(rawUrl);' +
        'const input = (typeof u === "string" || u instanceof URL) ? target : new Request(target, u);' +
        'return origFetch.call(window, input, o).then((res) => {' +
          'try {' +
            'if (isAppealUrl(rawUrl)) {' +
              'res.clone().text().then((t) => checkPassPayload(rawUrl, t)).catch(() => {});' +
            '}' +
          '} catch (e) {}' +
          'return res;' +
        '});' +
      '};' +
    '}' +
    'const origOpen = XMLHttpRequest.prototype.open;' +
    'XMLHttpRequest.prototype.open = function(m, u, ...rest) {' +
      'this._zhRawUrl = String(u || "");' +
      'return origOpen.call(this, m, prox(u), ...rest);' +
    '};' +
    'const origSend = XMLHttpRequest.prototype.send;' +
    'XMLHttpRequest.prototype.send = function(...args) {' +
      'this.addEventListener("load", () => {' +
        'try { if (this._zhRawUrl) checkPassPayload(this._zhRawUrl, this.responseText); } catch (e) {}' +
      '});' +
      'return origSend.apply(this, args);' +
    '};' +
    'if (desc && desc.set && desc.get) {' +
      'Object.defineProperty(document, "cookie", {' +
        'get() { return desc.get.call(document); },' +
        'set(v) {' +
          'try { origFetch("/zhihu/api/risk-cookie", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: aid, cookie: String(v) }) }).catch(() => { try { navigator.sendBeacon && navigator.sendBeacon("/zhihu/api/risk-cookie", new Blob([JSON.stringify({ id: aid, cookie: String(v) })], { type: "application/json" })); } catch (e) {} }); } catch (e) {}' +
          'return desc.set.call(document, v);' +
        '}' +
      '});' +
    '}' +
  '})();</script>'

  return rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${hook}`)
}

const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>知乎总结 · 控制台</title>
<style>
  :root { color-scheme: light dark; --bg: #0f1115; --card: #181c24; --border: #2a3140; --text: #edf1f7; --muted: #9aa4b5; --accent: #1677ff; --ok: #22c55e; --warn: #f59e0b; --bad: #ef4444; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f5f7fa; --card: #ffffff; --border: #e2e8f0; --text: #0f172a; --muted: #64748b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .wrap { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .muted { color: var(--muted); font-size: 13px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
  button.sec { background: transparent; color: var(--text); border: 1px solid var(--border); }
  button.danger { background: var(--bad); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input, textarea { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; }
  textarea { min-height: 82px; resize: vertical; }
  .acc { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; margin-top: 8px; }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: rgba(22,119,255,0.18); color: var(--accent); }
  .badge.ok { background: rgba(34,197,94,0.18); color: var(--ok); }
  .badge.bad { background: rgba(239,68,68,0.18); color: var(--bad); }
  .qrbox { text-align: center; margin-top: 10px; }
  .qrbox img { width: 200px; height: 200px; border-radius: 8px; background: #fff; padding: 8px; }
  .msg { font-size: 13px; margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(148,163,184,0.12); }
  iframe { width: 100%; height: 420px; border: 1px solid var(--border); border-radius: 8px; background: #fff; margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>知乎账号与验证控制台</h1>
    <div class="muted">凭证只保存在本机 ~/.dsh/dsh-zhihu-summary/accounts.json（Windows 为 %USERPROFILE%\.dsh\dsh-zhihu-summary\accounts.json），不会回传给外部模型。若开了全局代理节点，建议把 zhihu.com 设为直连以大幅减少 403 验证。</div>
  </div>

  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">已保存账号</h2>
      <div class="row">
        <button class="sec" onclick="checkHealth()">检测连通性</button>
        <button class="sec" onclick="loadStatus()">刷新</button>
      </div>
    </div>
    <div id="accounts">加载中…</div>
    <div id="healthMsg" class="msg" style="display:none"></div>
  </div>

  <div class="card">
    <h2>方式一：知乎 App 扫码登录</h2>
    <div class="row">
      <button onclick="startQr(false)">生成二维码</button>
      <button class="sec" onclick="startQr(true)">用本机浏览器预热后生成</button>
      <button class="sec" onclick="pollQr()">手动查扫码状态</button>
    </div>
    <div id="qrArea"></div>
  </div>

  <div class="card" id="riskArea" style="display:none">
    <h2 id="riskTitle">知乎安全验证</h2>
    <div id="riskTip" class="msg">触发知乎安全验证：请在下方完成验证，通过后会自动继续。</div>
    <div class="row" style="margin-top:8px">
      <button id="riskDoneBtn" onclick="finishRiskManual()">验证完重新生成二维码</button>
      <button class="sec" onclick="copyRiskUrl()">复制验证链接（外置浏览器）</button>
      <button class="sec" onclick="closeRiskArea()">收起验证框</button>
    </div>
    <div id="riskUrlText" class="muted" style="margin-top:6px;word-break:break-all"></div>
    <iframe id="riskFrame" src="about:blank"></iframe>
  </div>

  <div class="card">
    <h2>方式二：粘贴 Cookie 导入（最稳）</h2>
    <div class="muted" style="margin-bottom:8px">从浏览器复制整段 Cookie（至少包含 z_c0=...；最好带上 d_c0）。</div>
    <input id="cookieLabel" placeholder="账号备注名（可选，留空自动读取昵称）" style="margin-bottom:8px">
    <textarea id="cookieInput" placeholder="粘贴 Cookie 字符串，例如：d_c0=...; z_c0=..."></textarea>
    <div class="row" style="margin-top:8px">
      <button onclick="importCookie()">验证并保存账号</button>
    </div>
    <div id="cookieMsg" class="msg" style="display:none"></div>
  </div>
</div>
<script>
let curAttemptId = '';
let curRiskId = '';
let curRiskMode = 'qr';
let curRiskUrl = '';
let pollTimer = null;

async function api(path, method = 'GET', body = null) {
  const res = await fetch('/zhihu/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  return await res.json();
}

function showMsg(id, text) {
  const el = document.getElementById(id);
  el.style.display = text ? 'block' : 'none';
  el.textContent = text || '';
}

async function loadStatus() {
  const d = await api('/status');
  const box = document.getElementById('accounts');
  if (!d.accounts || !d.accounts.length) {
    box.innerHTML = '<div class="muted" style="margin-top:8px">还没有已登录账号。</div>';
    return;
  }
  box.innerHTML = d.accounts.map(a => {
    const badges = [
      a.active ? '<span class="badge ok">当前使用</span>' : '',
      a.isVip ? '<span class="badge">盐选会员</span>' : '',
      a.blocked ? '<span class="badge bad">风控暂停</span>' : '',
    ].filter(Boolean).join(' ');
    return '<div class="acc">' +
      '<div><div><b>' + esc(a.name) + '</b> ' + badges + '</div>' +
      '<div class="muted">' + (a.blocked ? esc(a.blocked.message || '需要人机验证') : (a.urlToken ? '@' + esc(a.urlToken) : '已就绪')) + '</div></div>' +
      '<div class="row">' +
      (!a.active ? '<button class="sec" data-action="switch" data-id="' + esc(a.id) + '">切换</button>' : '') +
      '<button' + (a.blocked ? '' : ' class="sec"') + ' data-action="risk" data-id="' + esc(a.id) + '">去过验证</button>' +
      (a.blocked ? '<button class="sec" data-action="unblock" data-id="' + esc(a.id) + '">解除暂停</button>' : '') +
      '<button class="sec" data-action="delete" data-id="' + esc(a.id) + '">删除</button>' +
      '</div></div>';
  }).join('');
}

function esc(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

document.getElementById('accounts').addEventListener('click', (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-action]') : null;
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  const id = btn.getAttribute('data-id') || '';
  if (!id) return;
  if (action === 'switch') switchAcc(id);
  else if (action === 'risk') startAccountRisk(id);
  else if (action === 'unblock') unblockAcc(id);
  else if (action === 'delete') delAcc(id);
});

async function switchAcc(id) { await api('/account/switch', 'POST', { id }); loadStatus(); }
async function unblockAcc(id) { await api('/account/unblock', 'POST', { id }); loadStatus(); showMsg('healthMsg', '已解除暂停标记，可在对话或面板重试。'); }
async function delAcc(id) { await api('/account/delete', 'POST', { id }); loadStatus(); }

async function checkHealth() {
  showMsg('healthMsg', '正在检测当前账号连通性…');
  const r = await api('/account/check', 'POST', {});
  showMsg('healthMsg', r.ok ? '账号正常：' + r.account.name : ('检测失败：' + r.error));
  loadStatus();
}

async function startQr(prewarm, inheritId = '') {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById('riskArea').style.display = 'none';
  document.getElementById('qrArea').innerHTML = '<div class="msg">正在获取知乎二维码…</div>';
  const r = await api('/qr/start', 'POST', { useChromiumPrewarm: prewarm, inheritAttemptId: inheritId });
  curAttemptId = r.id || '';
  renderQrState(r);
  if (r.status === 'waiting') {
    pollTimer = setInterval(pollQr, 2200);
  }
}

function openRiskFrame(sessionId, riskUrl, mode, tipText) {
  curRiskId = sessionId;
  curRiskMode = mode;
  curRiskUrl = riskUrl || 'https://www.zhihu.com/account/unhuman';
  const ra = document.getElementById('riskArea');
  ra.style.display = 'block';
  document.getElementById('riskTitle').textContent = mode === 'account' ? '账号安全验证' : '扫码登录安全验证';
  document.getElementById('riskTip').textContent = tipText || '请在下方完成知乎安全验证，通过后会自动继续。';
  document.getElementById('riskDoneBtn').textContent = mode === 'account' ? '验证完恢复账号' : '验证完重新生成二维码';
  document.getElementById('riskUrlText').textContent = '验证原链接：' + curRiskUrl;
  let host = 'www.zhihu.com';
  let targetPath = '/account/unhuman';
  try {
    const u = new URL(riskUrl || 'https://www.zhihu.com/account/unhuman');
    host = u.hostname || 'www.zhihu.com';
    targetPath = u.pathname + u.search;
  } catch {}
  const sep = targetPath.includes('?') ? '&' : '?';
  document.getElementById('riskFrame').src = '/zhihu/risk-proxy/__host/' + host + targetPath + sep + '_aid=' + encodeURIComponent(sessionId);
  try { ra.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch {}
}

async function copyRiskUrl() {
  if (!curRiskUrl) return;
  try {
    await navigator.clipboard.writeText(curRiskUrl);
    document.getElementById('riskTip').textContent = '已复制知乎验证原链接，可直接粘贴到手机浏览器打开过验证，过完回来点「' + document.getElementById('riskDoneBtn').textContent + '」。';
  } catch {
    document.getElementById('riskTip').textContent = '请手动长按下方验证原链接复制，到手机浏览器打开过验证。';
  }
}

function closeRiskArea() {
  document.getElementById('riskArea').style.display = 'none';
  document.getElementById('riskFrame').src = 'about:blank';
}

async function startAccountRisk(accountId) {
  showMsg('healthMsg', '正在准备安全验证页面…');
  try {
    const r = await api('/account/risk-start', 'POST', { id: accountId });
    if (!r.ok) { showMsg('healthMsg', '启动验证失败：' + (r.error || '未知错误')); return; }
    showMsg('healthMsg', '');
    openRiskFrame(r.id, r.riskUrl, 'account', r.message || '请在下方完成验证，通过后会自动刷新 Cookie 并恢复账号。');
  } catch (err) {
    showMsg('healthMsg', '启动验证异常：' + (err && err.message ? err.message : String(err)));
  }
}

async function finishRiskManual() {
  if (curRiskMode === 'account') {
    const r = await api('/account/risk-complete', 'POST', { id: curRiskId });
    closeRiskArea();
    showMsg('healthMsg', r.ok ? '已保存验证 Cookie 并恢复账号，正在检测连通性…' : ('恢复失败：' + (r.error || '未知错误')));
    await loadStatus();
    if (r.ok) await checkHealth();
    return;
  }
  const inherit = curRiskId || curAttemptId;
  closeRiskArea();
  await startQr(false, inherit);
}

window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  if (!ev.data || ev.data.type !== 'zhihu-risk-passed') return;
  if (curRiskId && ev.data.id && ev.data.id !== curRiskId) return;
  finishRiskManual();
});

async function pollQr() {
  if (!curAttemptId) return;
  const r = await api('/qr/poll?id=' + encodeURIComponent(curAttemptId));
  renderQrState(r);
  if (['succeeded', 'expired', 'failed', 'risk_control'].includes(r.status)) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (r.status === 'succeeded') loadStatus();
  }
}

function renderQrState(r) {
  const box = document.getElementById('qrArea');
  let html = '';
  if (r.qrDataUrl) html += '<div class="qrbox"><img src="' + r.qrDataUrl + '" alt="知乎二维码"></div>';
  html += '<div class="msg">' + esc(r.message || r.status) + '</div>';
  box.innerHTML = html;
  if (r.status === 'risk_control') {
    openRiskFrame(curAttemptId, r.riskUrl, 'qr', '触发知乎安全验证：请在下方完成验证，通过后会自动重新生成二维码。');
  }
}

async function importCookie() {
  const cookie = document.getElementById('cookieInput').value.trim();
  const label = document.getElementById('cookieLabel').value.trim();
  if (!cookie) { showMsg('cookieMsg', '请先粘贴 Cookie 字符串'); return; }
  showMsg('cookieMsg', '正在验证 Cookie…');
  const r = await api('/cookie-login', 'POST', { cookie, label });
  if (r.ok) {
    showMsg('cookieMsg', '登录成功：' + r.account.name);
    document.getElementById('cookieInput').value = '';
    loadStatus();
  } else {
    showMsg('cookieMsg', '导入失败：' + (r.error || '未知错误'));
  }
}

loadStatus();
</script>
</body>
</html>`

export function registerWebConsole(ctx) {
  const getConnection = () => {
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const fn of tries) {
      try {
        const c = fn()
        if (c && typeof c.requestRejection === 'function') return c
      } catch { /* next */ }
    }
    return null
  }

  const fenceReject = (req, res) => {
    const conn = getConnection()
    if (conn) {
      try {
        const rej = conn.requestRejection({ headers: req.headers })
        if (rej !== undefined) {
          const status = typeof rej === 'number' ? rej : 403
          const reqPath = String(req.url || '').split('?')[0]
          if (status === 401 && (reqPath === '/zhihu' || reqPath === '/zhihu/' || reqPath === '/zhihu/console')) {
            sendHtml(res, 401, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:24px;line-height:1.6"><h3>需要先通过 DSH 网页鉴权</h3><p>请先从 DSH App 的「网页模式」进入，或先打开 <a href="/">DSH 主页</a> 登录后再访问 <code>/zhihu/console</code>。</p></body>')
            return true
          }
          res.statusCode = status
          res.end()
          return true
        }
      } catch {
        res.statusCode = 403
        res.end()
        return true
      }
    }
    if (!sameOriginOk(req, Boolean(conn))) {
      sendJson(res, 403, { ok: false, error: '仅允许本机或已鉴权同源访问' })
      return true
    }
    return false
  }

  const handleRiskProxy = async (req, res, u) => {
    const cookiesMap = parseCookieString(req.headers.cookie || '')
    const aid = u.searchParams.get('_aid') || cookiesMap.zhihu_risk_aid || getLatestQrAttempt()?.id || ''
    const attempt = getQrAttempt(aid)
    if (!attempt) return sendHtml(res, 404, '<h3>验证会话已失效，请返回重新发起验证。</h3>')

    let targetHost = 'www.zhihu.com'
    let subPath = u.pathname.slice('/zhihu/risk-proxy'.length) || '/'
    if (subPath.startsWith('/__host/')) {
      const rest = subPath.slice('/__host/'.length)
      const slash = rest.indexOf('/')
      targetHost = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
      subPath = slash === -1 ? '/' : rest.slice(slash)
    }
    if (!/(^|\.)zhihu\.com$/i.test(targetHost)) {
      return sendJson(res, 403, { ok: false, error: '不允许代理非知乎域名' })
    }

    const targetSearch = new URLSearchParams(u.search)
    targetSearch.delete('_aid')
    const qs = targetSearch.toString()
    const origPath = `${subPath}${qs ? '?' + qs : ''}`
    const targetUrl = `https://${targetHost}${origPath}`

    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
    const headers = {
      'User-Agent': DEFAULT_UA,
      'Accept': req.headers.accept || '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.zhihu.com/account/unhuman',
      'Origin': 'https://www.zhihu.com',
      ...(attempt.cookies ? { Cookie: cookieHeader(attempt.cookies) } : {}),
    }
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue
      if (k === 'content-type' || k.startsWith('x-')) headers[k] = v
    }
    if (!headers['x-xsrftoken'] && attempt.cookies._xsrf) headers['x-xsrftoken'] = attempt.cookies._xsrf

    const upstream = await fetch(targetUrl, { method: req.method, headers, body, redirect: 'manual' })
    const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
    const cookiePatch = {}
    for (const line of setCookies) {
      Object.assign(cookiePatch, parseSingleSetCookie(line))
    }
    if (Object.keys(cookiePatch).length) syncRiskSessionCookies(aid, cookiePatch)

    res.setHeader('Set-Cookie', `zhihu_risk_aid=${encodeURIComponent(aid)}; Path=/zhihu/risk-proxy; HttpOnly; SameSite=Lax`)
    res.setHeader('Cache-Control', 'no-store')

    const loc = upstream.headers.get('location')
    if (loc) {
      try {
        const lu = new URL(loc, targetUrl)
        if (/(^|\.)zhihu\.com$/i.test(lu.hostname)) {
          if (lu.pathname === '/' || lu.pathname === '/signin') {
            return sendHtml(res, 200, '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">验证已通过，正在自动继续…<script>try{window.parent&&window.parent!==window&&window.parent.postMessage({type:"zhihu-risk-passed",id:' + JSON.stringify(aid) + '},location.origin)}catch(e){}</script></body>')
          }
          lu.searchParams.set('_aid', aid)
          res.setHeader('Location', `/zhihu/risk-proxy/__host/${lu.hostname}${lu.pathname}${lu.search}`)
        }
      } catch { /* ignore */ }
    }

    const ct = upstream.headers.get('content-type') || 'application/octet-stream'
    res.statusCode = upstream.status
    res.setHeader('Content-Type', ct)
    if (ct.includes('text/html')) {
      const html = await upstream.text()
      res.end(rewriteRiskHtml(html, aid, targetHost, origPath, attempt.cookies))
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    }
  }

  const handler = async (req, res) => {
    if (fenceReject(req, res)) return
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const p = u.pathname

    try {
      if (p === '/zhihu' || p === '/zhihu/' || p === '/zhihu/console') {
        return sendHtml(res, 200, CONSOLE_HTML)
      }
      if (p.startsWith('/zhihu/risk-proxy')) {
        return await handleRiskProxy(req, res, u)
      }
      if (p === '/zhihu/api/risk-cookie' && req.method === 'POST') {
        const body = await readJsonBody(req)
        if (body.id && body.cookie) syncRiskSessionCookies(body.id, parseSingleSetCookie(body.cookie))
        return sendJson(res, 200, { ok: true })
      }
      if (p === '/zhihu/api/account/risk-start' && req.method === 'POST') {
        const { id } = await readJsonBody(req)
        const session = startAccountRiskSession(String(id || ''))
        return sendJson(res, 200, { ok: true, ...session })
      }
      if (p === '/zhihu/api/account/risk-complete' && req.method === 'POST') {
        const { id } = await readJsonBody(req)
        return sendJson(res, 200, completeAccountRiskSession(String(id || '')))
      }
      if (p === '/zhihu/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, settings: readSettings(), defaults: DEFAULT_SETTINGS })
      }
      if (p === '/zhihu/api/config' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const patch = body && typeof body.settings === 'object' ? body.settings : body
        const settings = writeSettings(patch, { reset: Boolean(body?.reset) })
        return sendJson(res, 200, { ok: true, settings, defaults: DEFAULT_SETTINGS })
      }
      if (p === '/zhihu/api/status' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, accounts: listPublicAccounts(), activeId: getActiveAccount()?.id || '', settings: readSettings(), defaults: DEFAULT_SETTINGS })
      }
      if (p === '/zhihu/api/account/switch' && req.method === 'POST') {
        const { id } = await readJsonBody(req)
        const acc = switchAccount(String(id || ''))
        return sendJson(res, 200, { ok: true, activeId: acc.id })
      }
      if (p === '/zhihu/api/account/delete' && req.method === 'POST') {
        const { id } = await readJsonBody(req)
        return sendJson(res, 200, { ok: removeAccount(String(id || '')) })
      }
      if (p === '/zhihu/api/account/unblock' && req.method === 'POST') {
        const { id } = await readJsonBody(req)
        const targetId = String(id || getActiveAccount()?.id || '')
        if (targetId) setAccountBlocked(targetId, null)
        return sendJson(res, 200, { ok: true })
      }
      if (p === '/zhihu/api/account/check' && req.method === 'POST') {
        const account = await checkActiveAccountHealth()
        return sendJson(res, 200, { ok: true, account })
      }
      if (p === '/zhihu/api/cookie-login' && req.method === 'POST') {
        const { cookie, label } = await readJsonBody(req)
        const account = await verifyAndSaveCookieString(cookie, label)
        return sendJson(res, 200, { ok: true, account })
      }
      if (p === '/zhihu/api/qr/start' && req.method === 'POST') {
        const { inheritAttemptId, useChromiumPrewarm } = await readJsonBody(req)
        const attempt = await startQrLogin({ inheritAttemptId, useChromiumPrewarm })
        return sendJson(res, 200, { ok: true, ...attempt })
      }
      if (p === '/zhihu/api/qr/poll' && req.method === 'GET') {
        const id = u.searchParams.get('id') || ''
        return sendJson(res, 200, await pollQrLogin(id))
      }
      return sendJson(res, 404, { ok: false, error: `未知路由 ${req.method} ${p}` })
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err?.message || String(err) })
    }
  }

  return ctx.webServer.register({
    name: 'dsh-zhihu-summary-console',
    kind: 'prefix',
    path: '/zhihu',
    handler,
  })
}
