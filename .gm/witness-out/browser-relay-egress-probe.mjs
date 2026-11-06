import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3104
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
let browser = null
const pages = []
const result = {}
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.goto('http://127.0.0.1:' + PORT + '/')
  result.relays = await page.evaluate(() => new Promise((resolve) => {
    const hosts = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.snort.social']
    const out = {}
    let left = hosts.length
    for (const u of hosts) {
      let ws
      const t = setTimeout(() => { out[u] = 'timeout'; try { ws && ws.close() } catch {} ; if (--left === 0) resolve(out) }, 9000)
      try { ws = new WebSocket(u) } catch (e) { out[u] = 'throw ' + e.message; clearTimeout(t); if (--left === 0) resolve(out); continue }
      ws.onopen = () => { out[u] = 'open'; clearTimeout(t); ws.close(); if (--left === 0) resolve(out) }
      ws.onerror = () => { out[u] = 'error'; clearTimeout(t); if (--left === 0) resolve(out) }
    }
  }))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 300)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result))
