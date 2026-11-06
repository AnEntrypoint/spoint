import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3103
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const result = {}
let browser = null
const pages = []
const hook = () => {
  window.__wsErrors = []
  const rec = (kind, detail) => { window.__wsErrors.push(kind + ' ' + String(detail).slice(0, 200)) }
  const W = window.WebSocket
  window.WebSocket = function (u, p) {
    const s = p === undefined ? new W(u) : new W(u, p)
    s.addEventListener('error', () => rec('WS-ERROR', u))
    s.addEventListener('close', (e) => { if (!e.wasClean) rec('WS-UNCLEAN-CLOSE', u + ' code ' + e.code) })
    return s
  }
  window.WebSocket.prototype = W.prototype
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = W[k]
  const PC = window.RTCPeerConnection
  if (PC) {
    window.RTCPeerConnection = function (...a) {
      const pc = new PC(...a)
      pc.addEventListener('iceconnectionstatechange', () => rec('ICE', pc.iceConnectionState))
      pc.addEventListener('connectionstatechange', () => rec('PC', pc.connectionState))
      return pc
    }
    window.RTCPeerConnection.prototype = PC.prototype
  }
}
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.addInitScript(hook)
  await page.enableDomain('Runtime')
  await page.goto('http://127.0.0.1:' + PORT + '/?room=diagroom&fresh=1')
  let bridgeUp = false
  for (let i = 0; i < 40 && !bridgeUp; i++) { await page.waitForTimeout(1000); bridgeUp = await page.evaluate(() => !!(window.__app && window.__app.wireweave)) }
  result.bridgeUp = bridgeUp
  result.wsErrors = await page.evaluate(() => (window.__wsErrors || []).slice(0, 30))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
