import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3102
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const errors = []
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  page.on('Runtime.exceptionThrown', (p) => errors.push('EXC ' + String(p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || JSON.stringify(p)).slice(0, 220)))
  page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') errors.push('CONSOLE ' + p.type + ' ' + (p.args || []).map(a => String(a.value ?? a.description ?? '')).join(' ').slice(0, 220)) })
  await page.enableDomain('Runtime'); await page.addInitScript(`(() => { const W = window.WebSocket; window.WebSocket = function (u, p) { const s = p === undefined ? new W(u) : new W(u, p); s.addEventListener('error', () => console.error('WS-ERROR ' + String(u))); s.addEventListener('close', (e) => { if (!e.wasClean) console.error('WS-UNCLEAN-CLOSE ' + String(u) + ' code ' + e.code) }); return s }; window.WebSocket.prototype = W.prototype; window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3 })()`)
  await page.goto('http://127.0.0.1:' + PORT + '/?room=diagroom&fresh=1')
  let bridgeUp = false
  for (let i = 0; i < 40 && !bridgeUp; i++) { await page.waitForTimeout(1000); bridgeUp = await page.evaluate(() => !!(window.__app && window.__app.wireweave)) }
  result.bridgeUp = bridgeUp
  result.hostLogLines = await page.evaluate(() => (window.__app ? Object.keys(window.__app) : []))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  result.errors = errors.slice(0, 15)
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
