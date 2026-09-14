import { chromium } from './lib/cdp-browser.mjs'

const PORT = 21000 + Math.floor(Math.random() * 20000)
process.env.PORT = String(PORT)
process.env.WORLD = 'tod-witness-tmp'
if (!process.env._NEGCTRL) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(new URL('../apps/world/tod-witness-tmp.js', import.meta.url),
    '// throwaway tod-rebuild-witness.mjs world -- safe to delete\nexport default ' +
    JSON.stringify({ port: PORT, tickRate: 60, gravity: [0, -9.81, 0], spawnPoint: [0, 5, 8],
      terrain: { timeOfDay: { serverAuthoritative: true, dayLengthSec: 600, startFraction: 0.05 } },
      entities: [{ id: 'witness-box', app: 'box-static', position: [0, 1, 0] }] }, null, 2) + '\n')
}
process.env.SPOINT_SKIP_PREWARM = '1'
process.env.SPOINT_NO_WATCH = '1'
const { boot } = await import('../src/sdk/server.js')
const stop = await boot()
console.log(`[witness] server booted on :${PORT} (world=tod-witness-tmp, startFraction 0.05)`)

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
await page.goto(`http://localhost:${PORT}/?singleplayer&world=tod-witness-tmp`, { waitUntil: 'load' })
await page.waitForTimeout(9000)

const read = () => page.evaluate(() => ({
  t: window.__timeOfDay?.t ?? null,
  elev: window.__timeOfDay?.elevationDeg ?? null,
  sun: window.__app?.sun?.intensity ?? null,
  tick: window.__client?.currentTick ?? null,
  cls: window.__client?.constructor?.name ?? null,
}))
const before = await read()
console.log('[witness] before rebuild:', JSON.stringify(before))
if (before.cls !== 'BrowserServer') { console.log('[witness] FAIL: not singleplayer BrowserServer'); process.exit(1) }

await page.evaluate(() => {
  const c = window.__client
  let frozen = c.currentTick
  Object.defineProperty(c, 'currentTick', { get: () => frozen, configurable: true })
})
await page._send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { get: () => window.__forceHidden === true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { get: () => window.__forceHidden === true ? 'hidden' : 'visible', configurable: true })
})
await page.evaluate(() => { window.__forceHidden = true; document.dispatchEvent(new Event('visibilitychange')) })
await page.waitForTimeout(5600)
await page.evaluate(() => { window.__forceHidden = false; document.dispatchEvent(new Event('visibilitychange')) })
await page.waitForTimeout(12000)

const after = await read()
console.log('[witness] after rebuild:', JSON.stringify(after))
const rebuilt = after.cls === 'BrowserServer' && after.tick !== before.tick
const MIN_ELEV_ADVANCE_DEG = 3.0
const advanced = after.elev != null && before.elev != null && after.elev > before.elev + MIN_ELEV_ADVANCE_DEG
const sunTracks = after.elev != null && after.sun != null ? (after.elev < -6 ? after.sun === 0 : after.sun > 0.05) : false
const ok = rebuilt && advanced && sunTracks && !errors.length
console.log(`[witness] rebuilt=${rebuilt} advanced=${advanced} sunTracks=${sunTracks} (elev ${before.elev} -> ${after.elev}) pageErrors=${errors.length}`)
console.log('[witness] pageErrors:', errors.slice(0, 5))
console.log('[witness] RESULT:', ok ? 'PASS' : 'FAIL')
try { await stop() } catch (_) {}
try { await browser.close() } catch (_) {}
process.exit(ok ? 0 : 1)
