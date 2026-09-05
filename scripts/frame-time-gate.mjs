#!/usr/bin/env node
// frame-time-gate.mjs -- client-side real rendered-frame-time regression gate (zero deps).
//
// Boots the REAL server (src/sdk/server.js boot()) against tps-game, drives ONE real headless
// Chromium client via scripts/lib/cdp-browser.mjs, waits for the real loadingMachine.isReady
// signal (same terminal condition cold-load-gate.mjs uses), enters the editor via TOGGLE_EDITOR,
// places the edit camera at a fixed pose, and samples real rAF frame deltas from the live
// running renderer for two poses: static (camera held still) and orbit (camera yaws over the
// capture window). Emits p50/p95/1%-low/avg draw-calls/avg triangles as JSON, matching the
// documented recovery protocol (mutable prose): TOGGLE_EDITOR, setEditCameraPosition(50,
// ground+10, 50), yaw 0.6, pitch -0.2, 8s rAF capture.
//
// Follows the committed-JSON-baseline + threshold + --update-baseline pattern already used by
// scripts/perf-gate.mjs / scripts/cold-load-gate.mjs / scripts/bundle-size-gate.mjs.
//
// Usage: node scripts/frame-time-gate.mjs [--update-baseline]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BASELINE_PATH = join(ROOT, '.frame-time-baseline.json')
const THRESHOLD = 1.10
const UPDATE = process.argv.includes('--update-baseline')
const PORT = process.env.PORT || '3099'
const LOAD_TIMEOUT_MS = 480_000
const CAPTURE_MS = 8000

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function writeBaseline(data) {
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n')
  console.log(`[frame-time-gate] baseline written: ${BASELINE_PATH}`)
  console.log(JSON.stringify(data, null, 2))
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b)
  const p50Ms = percentile(sorted, 0.5)
  const p95Ms = percentile(sorted, 0.95)
  // "1% low" = the average of the slowest 1% of frames (highest frame times), the standard
  // stutter-sensitive metric -- a plain p99 hides sustained-stutter cost that a single spike does
  // not, since it averages the whole tail rather than reading one point in it.
  const tailCount = Math.max(1, Math.floor(sorted.length * 0.01))
  const tail = sorted.slice(sorted.length - tailCount)
  const onePercentLowMs = tail.reduce((a, b) => a + b, 0) / tail.length
  const fps = 1000 / p50Ms
  return { p50Ms, p95Ms, onePercentLowMs, fps, sampleCount: samples.length }
}

async function capturePose(page) {
  await page.evaluate(() => {
    const cam = window.__app?.cam
    if (!cam || !cam.setEditCameraPosition) throw new Error('window.__app.cam.setEditCameraPosition not available -- not in editor mode')
    // Fixed pose matching the documented protocol (TOGGLE_EDITOR,
    // setEditCameraPosition(50, ground+10, 50)); ground height is approximated as 0 (tps-game's
    // arena spawn plane) since no public ground-raycast API is exposed on window.__app.
    cam.setEditCameraPosition(50, 10, 50)
    cam.editLook(600, -200) // deltas accumulate into yaw/pitch on the next update() tick
  })

  const result = await page.evaluate((captureMs) => new Promise((resolve) => {
    const frameDeltas = []
    const drawCalls = []
    const triangles = []
    let last = performance.now()
    let first = true
    const t0 = performance.now()
    function tick(now) {
      const dt = now - last
      last = now
      if (!first) frameDeltas.push(dt) // skip the first sample (includes setup jank, not a real frame delta)
      first = false
      const info = window.__app?.renderer?.info
      if (info) {
        drawCalls.push(info.render.calls)
        triangles.push(info.render.triangles)
      }
      if (now - t0 < captureMs) requestAnimationFrame(tick)
      else resolve({ frameDeltas, drawCalls, triangles })
    }
    requestAnimationFrame(tick)
  }), CAPTURE_MS)

  return result
}

async function measureRealFrameTimes() {
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = PORT
  process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[frame-time-gate] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[frame-time-gate] server up.')

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))

    const url = `http://localhost:${PORT}/?singleplayer&world=${process.env.WORLD}`
    console.log(`[frame-time-gate] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const start = Date.now()
    let ready = false
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      ready = await page.evaluate(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady)).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`loadingMachine never reached isReady within ${LOAD_TIMEOUT_MS}ms`)

    console.log('[frame-time-gate] client ready, entering editor ...')
    await page.evaluate(() => { window.__app?.clientMachine?.send?.('TOGGLE_EDITOR') }).catch(() => {})
    const camWaitStart = Date.now()
    let camReady = false
    while (Date.now() - camWaitStart < 10000) {
      camReady = await page.evaluate(() => !!(window.__app?.cam?.setEditCameraPosition)).catch(() => false)
      if (camReady) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!camReady) throw new Error('window.__app.cam.setEditCameraPosition never became available within 10s of TOGGLE_EDITOR')

    console.log('[frame-time-gate] capturing static pose (8s) ...')
    const staticResult = await capturePose(page)

    console.log('[frame-time-gate] capturing orbit pose (8s, r=8) ...')
    // Orbit pose: yaw continuously advances during the capture window itself, not before it --
    // driven inside the same page.evaluate as the sampling loop so the yaw sweep and the frame
    // sampling share one rAF loop and cannot drift apart. editLook accumulates deltas into the
    // camera's internal yaw/pitch state on the next update() tick (there is no direct yaw setter).
    const orbitResult = await page.evaluate((captureMs) => new Promise((resolve) => {
      const frameDeltas = []
      const drawCalls = []
      const triangles = []
      let last = performance.now()
      let first = true
      const t0 = performance.now()
      const MOUSE_SENSITIVITY = 0.002 // camera.js's own default, editLook(dx,dy): yaw += dx*sensitivity
      const RADIANS_PER_MS = (Math.PI * 2) / captureMs // one full revolution over the capture window
      function tick(now) {
        const dt = now - last
        last = now
        window.__app?.cam?.editLook?.(RADIANS_PER_MS * dt / MOUSE_SENSITIVITY, 0)
        if (!first) frameDeltas.push(dt)
        first = false
        const info = window.__app?.renderer?.info
        if (info) {
          drawCalls.push(info.render.calls)
          triangles.push(info.render.triangles)
        }
        if (now - t0 < captureMs) requestAnimationFrame(tick)
        else resolve({ frameDeltas, drawCalls, triangles })
      }
      requestAnimationFrame(tick)
    }), CAPTURE_MS)

    if (pageErrors.length > 0) throw new Error(`page threw ${pageErrors.length} uncaught error(s): ${pageErrors[0]}`)

    return { staticResult, orbitResult }
  } finally {
    if (browser) await browser.close()
    server.stop()
  }
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }

async function main() {
  let raw
  try {
    raw = await measureRealFrameTimes()
  } catch (e) {
    console.error('[frame-time-gate] real-browser measurement FAILED:\n', e.stack || e.message)
    process.exit(1)
  }

  const staticStats = summarize(raw.staticResult.frameDeltas)
  const orbitStats = summarize(raw.orbitResult.frameDeltas)
  const metrics = {
    static: { ...staticStats, avgDrawCalls: avg(raw.staticResult.drawCalls), avgTriangles: avg(raw.staticResult.triangles) },
    orbit: { ...orbitStats, avgDrawCalls: avg(raw.orbitResult.drawCalls), avgTriangles: avg(raw.orbitResult.triangles) },
  }

  console.log(`[frame-time-gate] static  p50=${metrics.static.p50Ms.toFixed(2)}ms p95=${metrics.static.p95Ms.toFixed(2)}ms 1%low=${metrics.static.onePercentLowMs.toFixed(2)}ms fps=${metrics.static.fps.toFixed(1)} draws=${metrics.static.avgDrawCalls.toFixed(0)} tris=${metrics.static.avgTriangles.toFixed(0)}`)
  console.log(`[frame-time-gate] orbit   p50=${metrics.orbit.p50Ms.toFixed(2)}ms p95=${metrics.orbit.p95Ms.toFixed(2)}ms 1%low=${metrics.orbit.onePercentLowMs.toFixed(2)}ms fps=${metrics.orbit.fps.toFixed(1)} draws=${metrics.orbit.avgDrawCalls.toFixed(0)} tris=${metrics.orbit.avgTriangles.toFixed(0)}`)

  if (UPDATE) {
    writeBaseline(metrics)
    console.log('[frame-time-gate] baseline updated. PASS')
    process.exit(0)
  }

  const baseline = readBaseline()
  if (!baseline) {
    console.error('[frame-time-gate] no baseline found. Run with --update-baseline to create one.')
    process.exit(1)
  }

  // Regression check keyed on the moving (orbit) p50 -- the doc names it as the number that
  // actually matters for the 144Hz goal, and it is the more representative "real gameplay"
  // sample versus a held-still static pose.
  const baseMs = baseline.orbit?.p50Ms
  if (baseMs == null) {
    console.error('[frame-time-gate] baseline missing orbit.p50Ms. Run with --update-baseline to refresh.')
    process.exit(1)
  }
  const limit = baseMs * THRESHOLD
  console.log(`[frame-time-gate] baseline orbit p50=${baseMs.toFixed(2)}ms limit=${limit.toFixed(2)}ms (+10%) measured=${metrics.orbit.p50Ms.toFixed(2)}ms`)

  if (metrics.orbit.p50Ms > limit) {
    console.error(`[frame-time-gate] REGRESSION: ${metrics.orbit.p50Ms.toFixed(2)}ms > ${limit.toFixed(2)}ms (${((metrics.orbit.p50Ms / baseMs - 1) * 100).toFixed(1)}% over baseline)`)
    process.exit(1)
  }

  console.log('[frame-time-gate] PASS')
  process.exit(0)
}

main()
