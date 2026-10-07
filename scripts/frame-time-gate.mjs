#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'
import { assertGpu, gpuArgs, vendorGpuArgs } from './lib/gpu-probe.mjs'
import { baselineRefusals } from './lib/frame-time-baseline.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const baselineArg = (process.argv.find(a => a.startsWith('--baseline=')) || '').slice('--baseline='.length)
const VENDOR = (process.argv.find(a => a.startsWith('--expect-vendor=')) || '').slice('--expect-vendor='.length) || process.env.SPOINT_GPU || ''
const BASELINE_PATH = baselineArg || join(ROOT, VENDOR ? `.frame-time-baseline.${VENDOR}.json` : '.frame-time-baseline.json')
const THRESHOLD = 1.10
const UPDATE = process.argv.includes('--update-baseline')
const ACCELERATED = process.argv.includes('--accelerated')
const REQUIRE_ACCELERATED = process.argv.includes('--require-accelerated')
const EXPECT_VENDOR = VENDOR || null
const PORT = process.env.PORT || '3099'
const AT = (process.argv.find(a => a.startsWith('--at=')) || '').slice('--at='.length) || '-15,-12.5'
const UNLOCK_RAF = process.env.SPOINT_UNLOCK_RAF !== '0'
const UNLOCKED_RAF_ARGS = UNLOCK_RAF ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []
const LOAD_TIMEOUT_MS = 480_000
const READY_PROBE_STALL_LIMIT = 3
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

function evaluateOrThrow(page, fn, ms) {
  return Promise.race([
    Promise.resolve(page.evaluate(fn)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`page.evaluate did not answer within ${ms}ms -- the page main thread is blocked`)), ms)),
  ])
}

async function waitForRendererFrames(page, { minFrames = 5, timeoutMs = 180000 } = {}) {
  const t0 = Date.now()
  let prev = null
  let lastSeen = null
  while (Date.now() - t0 < timeoutMs) {
    const now = await evaluateOrThrow(page, () => {
      const r = window.__app && window.__app.renderer
      const i = r && r.info
      return i ? { calls: i.render.calls, frameCalls: i.render.frameCalls, triangles: i.render.triangles, warmup: !!window.__warmupInFlight } : null
    }, 15000).catch((e) => { console.log(`[frame-time-gate] liveness probe stalled: ${e.message}`); return null })
    if (now) {
      lastSeen = now
      if (prev !== null && Number.isFinite(now.calls) && now.calls - prev >= minFrames) {
        console.log(`[frame-time-gate] renderer is drawing: info.render.calls advanced ${now.calls - prev} in 500ms (warmupInFlight=${now.warmup} triangles=${now.triangles})`)
        return now
      }
      prev = now.calls
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`renderer.info.render.calls never advanced by ${minFrames} within ${timeoutMs}ms -- last sample ${JSON.stringify(lastSeen)} (app.js animate() returns early while window.__warmupInFlight is set, so a stalled warmup measures an empty frame)`)
}

async function capturePose(page) {
  const eye = await page.evaluate(() => {
    const s = window.__spoint && window.__spoint.where ? window.__spoint.where() : null
    const p = (s && s.position) || (window.__app && window.__app.client && window.__app.client.getLocalState ? window.__app.client.getLocalState().position : null) || [0, 0, 0]
    return [p[0], p[1], p[2]]
  })
  await page.evaluate((p) => {
    const cam = window.__app?.cam
    if (!cam || !cam.setEditCameraPosition) throw new Error('window.__app.cam.setEditCameraPosition not available -- not in editor mode')
    cam.setEditCameraPosition(p[0] + 50, 10, p[2] + 50)
    cam.editLook(600, -200)
  }, eye)

  const result = await page.evaluate((captureMs) => new Promise((resolve) => {
    const frameDeltas = []
    const counters = []
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
        counters.push({
          calls: info.render.calls,
          triangles: info.render.triangles,
          isWebGPU: !!(window.__app.renderer.isWebGPURenderer || (window.__app.renderer.backend && window.__app.renderer.backend.isWebGPUBackend)),
        })
      }
      if (now - t0 < captureMs) requestAnimationFrame(tick)
      else resolve({ frameDeltas, counters })
    }
    requestAnimationFrame(tick)
  }), CAPTURE_MS)

  return result
}

async function measureRealFrameTimes() {
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = PORT
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[frame-time-gate] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[frame-time-gate] server up.')

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: [...gpuArgs({ accelerated: ACCELERATED }), ...(VENDOR ? vendorGpuArgs(VENDOR) : []), ...UNLOCKED_RAF_ARGS] })
    if (!UNLOCK_RAF) console.log('[frame-time-gate] rAF is vsync-locked (SPOINT_UNLOCK_RAF=0), so frame times here carry the refresh divisor')
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))

    const url = `http://localhost:${PORT}/?singleplayer&world=${process.env.WORLD}&at=${encodeURIComponent(AT)}`
    console.log(`[frame-time-gate] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const start = Date.now()
    let ready = false
    let stalledProbes = 0
    let lastProgressLog = 0
    while (Date.now() - start < LOAD_TIMEOUT_MS) {
      const waited = Date.now() - start
      const probe = await evaluateOrThrow(page, () => {
        const app = window.__app
        return {
          ready: !!(app && app.loadingMachine && app.loadingMachine.isReady),
          state: app && app.loadingMachine ? String(app.loadingMachine.state) : null,
        }
      }, 20000).catch((e) => ({ stalled: e.message }))
      if (probe.stalled) {
        stalledProbes++
        console.log(`[frame-time-gate] isReady probe stalled ${stalledProbes} of ${READY_PROBE_STALL_LIMIT} after ${(waited / 1000).toFixed(0)}s: ${probe.stalled}`)
        if (stalledProbes >= READY_PROBE_STALL_LIMIT) throw new Error(`loadingMachine.isReady probe stalled ${stalledProbes} times running -- the page main thread is blocked, so this run cannot measure frame times`)
        continue
      }
      stalledProbes = 0
      if (waited - lastProgressLog > 30000) {
        lastProgressLog = waited
        console.log(`[frame-time-gate] still loading after ${(waited / 1000).toFixed(0)}s (loadingMachine state=${probe.state})`)
      }
      ready = probe.ready
      if (ready) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!ready) throw new Error(`loadingMachine never reached isReady within ${LOAD_TIMEOUT_MS}ms`)

    let gpu = null
    let gpuError = null
    for (let attempt = 1; attempt <= 3 && gpu === null; attempt++) {
      try {
        gpu = await Promise.race([
          assertGpu(page, { requireAccelerated: REQUIRE_ACCELERATED, expectVendor: EXPECT_VENDOR }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('gpu probe did not answer within 30s -- the page main thread or GPU process is wedged')), 30000)),
        ])
      } catch (e) {
        gpuError = e
        console.log(`[frame-time-gate] gpu probe attempt ${attempt} of 3 failed: ${e.message}`)
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    if (gpu === null) throw gpuError
    console.log(`[frame-time-gate] rasterizer=${gpu.rasterizer} renderer=${gpu.renderer || 'none'} webgpu=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor || 'yes') : 'none'}`)

    console.log('[frame-time-gate] client ready, entering editor ...')
    await page.evaluate(() => { window.__app?.clientMachine?.send?.('TOGGLE_EDITOR') }).catch(() => {})
    const camWaitStart = Date.now()
    let camReady = false
    while (Date.now() - camWaitStart < 10000) {
      camReady = await evaluateOrThrow(page, () => !!(window.__app?.cam?.setEditCameraPosition), 15000).catch(() => false)
      if (camReady) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!camReady) throw new Error('window.__app.cam.setEditCameraPosition never became available within 10s of TOGGLE_EDITOR')

    console.log('[frame-time-gate] waiting for the renderer to actually draw before measuring ...')
    await waitForRendererFrames(page)

    console.log('[frame-time-gate] capturing static pose (8s) ...')
    const staticResult = await capturePose(page)

    console.log('[frame-time-gate] capturing orbit pose (8s, r=8) ...')
    const orbitResult = await page.evaluate((captureMs) => new Promise((resolve) => {
      const frameDeltas = []
      const counters = []
      let last = performance.now()
      let first = true
      const t0 = performance.now()
      const MOUSE_SENSITIVITY = 0.002
      const SWEEP_RAD = 0.25
      const SWEEPS = 2
      let appliedYaw = 0
      function tick(now) {
        const dt = now - last
        last = now
        const wantYaw = SWEEP_RAD * Math.sin((2 * Math.PI * SWEEPS * (now - t0)) / captureMs)
        const deltaYaw = wantYaw - appliedYaw
        appliedYaw = wantYaw
        window.__app?.cam?.editLook?.(deltaYaw / MOUSE_SENSITIVITY, 0)
        if (!first) frameDeltas.push(dt)
        first = false
        const info = window.__app?.renderer?.info
        if (info) {
          counters.push({
            calls: info.render.calls,
            triangles: info.render.triangles,
            isWebGPU: !!(window.__app.renderer.isWebGPURenderer || (window.__app.renderer.backend && window.__app.renderer.backend.isWebGPUBackend)),
          })
        }
        if (now - t0 < captureMs) requestAnimationFrame(tick)
        else resolve({ frameDeltas, counters })
      }
      requestAnimationFrame(tick)
    }), CAPTURE_MS)

    const vegInstances = await evaluateOrThrow(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => 0)
    console.log(`[frame-time-gate] vegetation instances resident during the capture: ${vegInstances}`)

    if (pageErrors.length > 0) throw new Error(`page threw ${pageErrors.length} uncaught error(s): ${pageErrors[0]}`)

    return { staticResult, orbitResult, gpu, vegInstances }
  } finally {
    if (browser) await browser.close()
    server.stop()
  }
}

function seriesRate(values) {
  const nums = values.filter((v) => Number.isFinite(v))
  if (nums.length === 0) return 0
  let resets = false
  for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) resets = true
  if (!resets && nums[nums.length - 1] > nums[0]) return (nums[nums.length - 1] - nums[0]) / (nums.length - 1)
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function counterRates(counters) {
  if (!Array.isArray(counters) || counters.length < 2) return { drawCalls: 0, triangles: 0 }
  return {
    drawCalls: seriesRate(counters.map((c) => c && c.calls)),
    triangles: seriesRate(counters.map((c) => c && c.triangles)),
  }
}

function backendIsWebGPU(counters) {
  return Array.isArray(counters) && counters.some((c) => c && c.isWebGPU)
}

async function main() {
  const baseline = UPDATE ? null : readBaseline()
  if (!UPDATE) {
    if (!baseline) {
      console.error(`[frame-time-gate] no baseline found at ${BASELINE_PATH}. Run with --update-baseline to create one.`)
      process.exit(1)
    }
    const refusals = baselineRefusals(baseline)
    if (refusals.length) {
      console.error(`[frame-time-gate] BASELINE NOT ADMISSIBLE: ${refusals.join('; ')}`)
      console.error('[frame-time-gate] frame times compare only between runs of the same rasterizer class with enough samples to support the percentiles -- capture a fresh baseline with --update-baseline.')
      process.exit(1)
    }
  }

  let raw
  try {
    raw = await measureRealFrameTimes()
  } catch (e) {
    console.error('[frame-time-gate] real-browser measurement FAILED:\n', e.stack || e.message)
    process.exit(1)
  }

  const staticStats = summarize(raw.staticResult.frameDeltas)
  const orbitStats = summarize(raw.orbitResult.frameDeltas)
  const staticRates = counterRates(raw.staticResult.counters)
  const orbitRates = counterRates(raw.orbitResult.counters)
  console.log(`[frame-time-gate] counter probe: first=${JSON.stringify(raw.orbitResult.counters[0])} last=${JSON.stringify(raw.orbitResult.counters[raw.orbitResult.counters.length - 1])} samples=${raw.orbitResult.counters.length}`)
  const metrics = {
    rasterizer: raw.gpu.rasterizer,
    vendor: (raw.gpu.adapter && raw.gpu.adapter.vendor) || VENDOR || null,
    gpu: raw.gpu.haystack || null,
    vegInstances: raw.vegInstances,
    static: { ...staticStats, avgDrawCalls: staticRates.drawCalls, avgTriangles: staticRates.triangles },
    orbit: { ...orbitStats, avgDrawCalls: orbitRates.drawCalls, avgTriangles: orbitRates.triangles },
  }

  console.log(`[frame-time-gate] static  p50=${metrics.static.p50Ms.toFixed(2)}ms p95=${metrics.static.p95Ms.toFixed(2)}ms 1%low=${metrics.static.onePercentLowMs.toFixed(2)}ms fps=${metrics.static.fps.toFixed(1)} draws=${metrics.static.avgDrawCalls.toFixed(0)} tris=${metrics.static.avgTriangles.toFixed(0)}`)
  console.log(`[frame-time-gate] orbit   p50=${metrics.orbit.p50Ms.toFixed(2)}ms p95=${metrics.orbit.p95Ms.toFixed(2)}ms 1%low=${metrics.orbit.onePercentLowMs.toFixed(2)}ms fps=${metrics.orbit.fps.toFixed(1)} draws=${metrics.orbit.avgDrawCalls.toFixed(0)} tris=${metrics.orbit.avgTriangles.toFixed(0)}`)

  const orbitWebGPU = backendIsWebGPU(raw.orbitResult.counters)
  const requiredCounts = ['drawCalls', 'frames', 'vegInstances']
  if (!orbitWebGPU) requiredCounts.push('triangles')
  if (orbitWebGPU && !(metrics.orbit.avgTriangles > 0)) {
    console.log('[frame-time-gate] renderer.info.render.triangles reads 0 on the WebGPU backend, so draw calls carry the reachability proof for this run')
  }
  const unreached = unreachedReasons({
    counts: { drawCalls: metrics.orbit.avgDrawCalls, triangles: metrics.orbit.avgTriangles, frames: raw.orbitResult.frameDeltas.length, vegInstances: raw.vegInstances },
    requiredCounts,
  })
  if (!(raw.vegInstances >= 1000)) {
    unreached.push(`only ${raw.vegInstances} vegetation instance(s) were resident, so the capture measured a world without vegetation`)
  }
  const orbitCoverage = metrics.static.avgTriangles > 0 ? metrics.orbit.avgTriangles / metrics.static.avgTriangles : 0
  if (orbitCoverage < 0.5) {
    unreached.push(`the orbit arm rendered ${(orbitCoverage * 100).toFixed(1)}% of the static arm's triangles, so its frame times come from an empty view rather than the world`)
  }
  console.log(`[frame-time-gate] reachability: ${unreached.length === 0 ? 'REACHED' : 'UNREACHED'} ${JSON.stringify({ orbitDrawCalls: metrics.orbit.avgDrawCalls, orbitTriangles: metrics.orbit.avgTriangles, orbitFrames: raw.orbitResult.frameDeltas.length, unreached })}`)

  if (unreached.length) {
    console.error(`[frame-time-gate] RESULT: FAIL -- witness never reached the state it measured: ${unreached.join('; ')}`)
    process.exit(1)
  }

  if (UPDATE) {
    writeBaseline(metrics)
    console.log('[frame-time-gate] baseline updated. PASS')
    process.exit(0)
  }

  const refusals = baselineRefusals(baseline, metrics)
  if (refusals.length) {
    console.error(`[frame-time-gate] BASELINE NOT ADMISSIBLE: ${refusals.join('; ')}`)
    process.exit(1)
  }

  const baseMs = baseline.orbit.p50Ms
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
