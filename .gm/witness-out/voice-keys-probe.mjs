import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3111
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 90; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.enableDomain('Runtime')
  await page.goto('http://127.0.0.1:' + PORT + '/?room=diagroom&fresh=1')
  let bridgeUp = false
  for (let i = 0; i < 40 && !bridgeUp; i++) { await page.waitForTimeout(1000); bridgeUp = await page.evaluate(() => !!(window.__app && window.__app.wireweave)) }
  await page.waitForTimeout(4000)
  result.bridgeUp = bridgeUp
  result.appKeys = await page.evaluate(() => Object.keys(window.__app || {}))
  result.voiceIndicatorObj = await page.evaluate(() => !!(window.__app && window.__app.voiceIndicator))
  result.buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 30)))
  result.joinish = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => /join/i.test(e.textContent || '') && e.children.length < 3).slice(0, 8).map(e => e.tagName + ':' + e.textContent.trim().slice(0, 40)))
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
