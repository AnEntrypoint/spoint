#!/usr/bin/env node
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
    cam.setEditCameraPosition(50, 10, 50)
    cam.editLook(600, -200)
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
    const orbitResult = await page.evaluate((captureMs) => new Promise((resolve) => {
      const frameDeltas = []
      const drawCalls = []
      const triangles = []
      let last = performance.now()
      let first = true
      const t0 = performance.now()
      const MOUSE_SENSITIVITY = 0.002
      const RADIANS_PER_MS = (Math.PI * 2) / captureMs
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
