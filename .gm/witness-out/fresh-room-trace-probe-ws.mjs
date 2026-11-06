import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3116
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const hook = () => {
  window.__logs = []
  const push = (k, a) => { try { window.__logs.push(k + ' ' + a.map(x => typeof x === 'string' ? x : (x && x.message) ? x.message : JSON.stringify(x)).join(' ').slice(0, 220)) } catch (e) {} }
  for (const k of ['log', 'warn', 'error', 'info']) { const o = console[k].bind(console); console[k] = (...a) => { push(k, a); o(...a) } }
  const W = window.WebSocket
  window.WebSocket = function (u, p) { const sk = p === undefined ? new W(u) : new W(u, p); sk.addEventListener('error', () => push('WS-ERROR', [String(u)])); sk.addEventListener('close', (e) => { if (!e.wasClean) push('WS-UNCLEAN', [String(u) + ' ' + e.code]) }); return sk }
  window.WebSocket.prototype = W.prototype
  for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) window.WebSocket[k] = W[k]
  window.addEventListener('unhandledrejection', (ev) => push('REJ', [String((ev.reason && ev.reason.stack) || ev.reason).slice(0, 300)]))
}
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.addInitScript(hook)
  await page.enableDomain('Runtime')
  const room = 'trace' + Date.now().toString(36)
  await page.goto('http://127.0.0.1:' + PORT + '/?room=' + room + '&fresh=1')
  await page.waitForTimeout(40000)
  result.room = room
  result.bridge = await page.evaluate(() => !!(window.__app && window.__app.wireweave))
  result.logs = await page.evaluate(() => (window.__logs || []).filter(l => /wire|host|room|bridge|claim|peer|join|voice|election|error|REJ/i.test(l)).slice(0, 40))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
