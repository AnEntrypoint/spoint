import { spawn } from 'node:child_process'
import { launch } from '/workspace/spoint/scripts/lib/cdp-browser.mjs'
const PORT = 3100
const server = spawn('node', ['server.js'], { cwd: '/workspace/spoint', env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })
const result = {}
let browser = null
const pages = []
try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/'); if (r.status) break } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  browser = await launch({})
  const ctx = await browser.newContext()
  const page = await ctx.newPage(); pages.push(page)
  await page.enableDomain('Runtime')
  await page.goto('http://127.0.0.1:' + PORT + '/?singleplayer')
  await page.waitForTimeout(3000)
  const chat = await page.evaluate(async () => {
    const { createChatHUD } = await import('/hud/Chat.js')
    const root = document.createElement('div'); document.body.appendChild(root)
    const hud = createChatHUD(root, () => null)
    const before = hud.joined
    hud.destroy()
    return { joinedBeforeDestroy: before, joinedAfterDestroy: hud.joined, cardRemoved: root.childElementCount === 0 }
  })
  result.chat = chat
  const voice = await page.evaluate(async () => {
    const { createVoiceIndicator } = await import('/hud/VoiceIndicator.js')
    const root = document.createElement('div'); document.body.appendChild(root)
    const vi = createVoiceIndicator(root, () => null, { playerId: 1 }, null)
    const labels = [...root.querySelectorAll('button')].map(b => b.textContent.trim())
    vi.destroy && vi.destroy()
    return { buttons: labels }
  })
  result.voice = voice
} catch (e) {
  result.error = String(e && e.stack || e).slice(0, 500)
} finally {
  for (const p of pages) { try { await p.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
  server.kill('SIGTERM')
  result.serverExited = await new Promise(r => { server.once('exit', () => r(true)); setTimeout(() => r(server.killed), 3000) })
}
console.log(JSON.stringify(result))
