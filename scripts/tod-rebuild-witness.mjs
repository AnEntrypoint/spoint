// One-off live witness for the time-of-day clock-seed fix (uncommitted working-tree state).
// Boots the real server on the serverAuthoritative construct world, loads the client in real
// headless Chrome, records elevationDeg + sun.intensity, forces the app.js stall-recovery
// rebuild path (hidden >5s with ticks stalled), then asserts the day/night clock did NOT
// jump backward and sun.intensity is lit after the rebuild. Manual verification harness,
// not a test file.
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

// Freeze the tick counter so the visibilitychange stall detector sees ticks not advancing,
// then flip the page hidden for >5s and active again -- the exact app.js rebuild trigger.
await page.evaluate(() => {
  const c = window.__client
  let frozen = c.currentTick
  Object.defineProperty(c, 'currentTick', { get: () => frozen, configurable: true })
})
await page._send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
// Headless pages never become document.hidden on their own; drive the handler's gate directly
// by dispatching the visibilitychange event with visibilityState overridden via CDP-free trick:
// the handler reads document.hidden, so emulate with Page.setWebLifecycleState frozen (throttles
// timers AND reports hidden in headless-new).
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
// startFraction 0.05 is deep night (boot elev ~-64deg; sun 0 is CORRECT there). The witness is
// the clock continuing forward across the rebuild (elev strictly advanced, never snapping back
// toward the boot-time value a startFraction reset would produce) and sun tracking the keyframe
// value for the live elevation (0 at night, >0 past the dawn keyframe).
// The unfixed behavior (live-witnessed negative control 2026-08-21) is NOT a backward jump but a
// RESET-AND-CATCH-UP: the rebuilt server restarts the day at startFraction and only the
// post-reconnect seconds re-elapse (1.63deg of advance in this window vs 4.48deg with the fix).
// So the gate is full-window advance: ~17.6s of a 600s day at this elevation's rate ~0.25deg/s.
const advanced = after.elev != null && before.elev != null && after.elev > before.elev + 3.0
const sunTracks = after.elev != null && after.sun != null ? (after.elev < -6 ? after.sun === 0 : after.sun > 0.05) : false
const ok = rebuilt && advanced && sunTracks && !errors.length
console.log(`[witness] rebuilt=${rebuilt} advanced=${advanced} sunTracks=${sunTracks} (elev ${before.elev} -> ${after.elev}) pageErrors=${errors.length}`)
console.log('[witness] pageErrors:', errors.slice(0, 5))
console.log('[witness] RESULT:', ok ? 'PASS' : 'FAIL')
try { await stop() } catch (_) {}
try { await browser.close() } catch (_) {}
process.exit(ok ? 0 : 1)
