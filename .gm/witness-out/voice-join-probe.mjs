import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3106
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {}); server.stderr.on('data', () => {})
const hook = () => {
  window.__media = []
  const md = navigator.mediaDevices
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = (c) => {
      window.__media.push('gUM start ' + JSON.stringify(c).slice(0, 80))
      return orig(c).then((s) => { window.__media.push('gUM resolve'); return s }, (e) => { window.__media.push('gUM reject ' + (e && e.name)); throw e })
    }
  }
  window.__media.push('hook-installed gUM=' + !!(md && md.getUserMedia))
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
  let bridgeUp = false
  for (let i = 0; i < 40 && !bridgeUp; i++) { await page.waitForTimeout(1000); bridgeUp = await page.evaluate(() => !!(window.__app && window.__app.wireweave)) }
  result.bridgeUp = bridgeUp
  if (bridgeUp) {
    result.clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /join voice/i.test(x.textContent))
      if (!b) return 'no Join Voice button'
      b.click(); return 'clicked'
    })
    await page.waitForTimeout(6000)
    result.afterSixSeconds = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /join voice|leave voice|mute|unmute/i.test(x.textContent))
      return { label: b ? b.textContent.trim() : null, media: window.__media }
    })
  }
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 400)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
}
console.log(JSON.stringify(result, null, 1))
