import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3113
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const hook = () => {
  window.__errs = []
  const oe = console.error.bind(console)
  console.error = (...a) => { window.__errs.push(a.map(x => (x && x.stack) ? x.stack.slice(0, 400) : (x && x.message) ? x.message : String(x)).join(' ').slice(0, 500)); oe(...a) }
  window.addEventListener('unhandledrejection', (ev) => { const r = ev.reason; window.__errs.push('REJ ' + ((r && r.stack) || (r && r.message) || String(r)).slice(0, 500)) })
}
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.addInitScript(hook)
  await page.enableDomain('Runtime')
  await page.goto('http://127.0.0.1:' + PORT + '/?room=diagroom&fresh=1')
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => !!(window.__app && window.__app.wireweave))) break }
  await page.waitForTimeout(4000)
  result.client = await page.evaluate(() => { const c = window.debug && window.debug.client; return { ctor: c && c.constructor && c.constructor.name, hasAttach: !!(c && c.attachWireweavePeer), peerSession: !!(c && c._peerSession), bridgeRoom: window.__app.wireweave && window.__app.wireweave.roomId } })
  result.errs = await page.evaluate(() => (window.__errs || []).slice(0, 8))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
