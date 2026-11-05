import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3100
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
  await page.goto('http://127.0.0.1:' + PORT + '/?multiplayer=1&fresh=1')
  let bridgeUp = false
  for (let i = 0; i < 30 && !bridgeUp; i++) { await page.waitForTimeout(1000); bridgeUp = await page.evaluate(() => !!(window.__app && window.__app.wireweave)) }
  result.bridgeUp = bridgeUp
  if (bridgeUp) {
    result.chat = await page.evaluate(async () => {
      const { createChatHUD } = await import('/hud/Chat.js')
      const root = document.createElement('div'); document.body.appendChild(root)
      const hud = createChatHUD(root, () => window.__app.wireweave)
      let loadErr = null
      for (let i = 0; i < 20 && !hud.joined; i++) {
        const btn = [...root.querySelectorAll('button')].find(b => /join chat/i.test(b.textContent))
        if (btn) btn.click()
        await new Promise(r => setTimeout(r, 1000))
      }
      const before = hud.joined
      hud.destroy()
      return { joinedBeforeDestroy: before, joinedAfterDestroy: hud.joined }
    })
  }
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 500)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result))
