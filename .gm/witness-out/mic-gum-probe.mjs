import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3101
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.enableDomain('Runtime')
  await page.goto('http://127.0.0.1:' + PORT + '/?room=diagroom&fresh=1')
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => !!(window.__app && window.__app.wireweave)).catch(() => false)) break }
  result.gum = await page.evaluate(() => new Promise(resolve => {
    const t = setTimeout(() => resolve({ settled: false, afterMs: 8000 }), 8000)
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      s => { clearTimeout(t); resolve({ settled: true, ok: true, tracks: s.getAudioTracks().length }) },
      e => { clearTimeout(t); resolve({ settled: true, ok: false, name: e.name, message: e.message }) })
  }))
} catch (e) {
  result.error = String(e && e.message || e)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  try { if (browser) await browser.close() } catch {}
  try { server.kill() } catch {}
  console.log(JSON.stringify(result))
  process.exit(0)
}
