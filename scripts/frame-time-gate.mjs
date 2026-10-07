#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'
import { assertGpu, gpuArgs, gpuModeOf } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  gpuControlArgs, gpuControlCalibrate, gpuControlProbe, gpuControlRate, gpuControlSpread,
  gpuControlSensitive, GPU_CONTROL_MIN_P50_MS, GPU_CONTROL_SPREAD_FACTOR,
} from './lib/perf-gpu-control.mjs'
import { baselineRefusals } from './lib/frame-time-baseline.mjs'
import { contentionWatch, contentionMark, contentionVerdict, formatContention } from './lib/host-contention.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const baselineArg = (process.argv.find(a => a.startsWith('--baseline=')) || '').slice('--baseline='.length)
const GPU_FLAG = (process.argv.find(a => a.startsWith('--gpu=')) || '').slice('--gpu='.length)
const GPU_MODE = gpuModeOf(GPU_FLAG || (process.argv.includes('--accelerated') ? 'accelerated' : 'software'))
const VENDOR = (process.argv.find(a => a.startsWith('--expect-vendor=')) || '').slice('--expect-vendor='.length) || GPU_MODE.vendor || process.env.SPOINT_GPU || ''
const BASELINE_PATH = baselineArg || join(ROOT, VENDOR ? `.frame-time-baseline.${VENDOR}.json` : '.frame-time-baseline.json')
const THRESHOLD = 1.10
const UPDATE = process.argv.includes('--update-baseline')
const ACCEPT_SLOWER = (process.argv.find(a => a.startsWith('--accept-slower=')) || '').slice('--accept-slower='.length)
const ACCELERATED = GPU_MODE.accelerated
const REQUIRE_ACCELERATED = process.argv.includes('--require-accelerated')
const EXPECT_VENDOR = VENDOR || null
const PORT = process.env.PORT || '3099'
const AT = (process.argv.find(a => a.startsWith('--at=')) || '').slice('--at='.length) || '-15,-12.5'
const UNLOCK_RAF = process.env.SPOINT_UNLOCK_RAF !== '0'
const UNLOCKED_RAF_ARGS = UNLOCK_RAF ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []
const VENDOR_ARGS = VENDOR ? vendorPinArgs(VENDOR) : []
const LOAD_TIMEOUT_MS = 480_000
const READY_PROBE_STALL_LIMIT = 3
const CAPTURE_MS = Number((process.argv.find(a => a.startsWith('--capture-ms=')) || '').slice('--capture-ms='.length)) || 8000
const CAPTURE_TIMEOUT_MS = CAPTURE_MS * 6 + 60_000
const VEGETATION_FLOOR = 1000
const VEGETATION_WAIT_MS = Number((process.argv.find(a => a.startsWith('--veg-wait-ms=')) || '').slice('--veg-wait-ms='.length)) || 420_000
const SETTLE_POLL_MS = 3000
const SETTLE_STABLE_POLLS = 3
const SETTLE_PROBE_MS = 2000
const SETTLE_WORST_FRAME_FACTOR = 4
const SETTLE_MIN_PROBE_SAMPLES = 40
const SETTLE_SLOW_PROBE_LIMIT = 3
const GPU_FINGERPRINT_TOLERANCE = 1.25
const GPU_CONTROL_INSTABILITY_FACTOR = 1.5
const GPU_CONTROL_ARGS = gpuControlArgs({ accelerated: ACCELERATED, vendorArgs: VENDOR_ARGS, unlockedRafArgs: UNLOCKED_RAF_ARGS })
const SETTLE_BUDGET_MS = Number((process.argv.find(a => a.startsWith('--settle-budget-ms=')) || '').slice('--settle-budget-ms='.length)) || 240_000

function chromeProcessCount() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    return out.split('\n').filter((line) => line.toLowerCase().includes('chrome.exe')).length
  } catch {
    return null
  }
}

function gitHeadSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    return null
  }
}

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

function withTimeout(promise, label, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms -- the page stopped presenting frames, so this run cannot measure it`)), ms)),
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

async function vegetationCount(page) {
  return evaluateOrThrow(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => null)
}

async function waitForVegetationFloor(page) {
  const t0 = Date.now()
  let count = await vegetationCount(page)
  let logged = -1
  while (Date.now() - t0 < VEGETATION_WAIT_MS) {
    if (count !== null && count >= VEGETATION_FLOOR) {
      console.log(`[frame-time-gate] vegetation floor met: ${count} instance(s) >= ${VEGETATION_FLOOR} after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      return count
    }
    const waited = Math.floor((Date.now() - t0) / 30000)
    if (count !== null && waited > logged) {
      logged = waited
      console.log(`[frame-time-gate] vegetation still filling: ${count} of ${VEGETATION_FLOOR} instance(s) after ${((Date.now() - t0) / 1000).toFixed(0)}s of a ${(VEGETATION_WAIT_MS / 1000).toFixed(0)}s budget`)
    }
    await new Promise(r => setTimeout(r, 2000))
    count = await vegetationCount(page)
  }
  console.log(`[frame-time-gate] vegetation floor NOT met: ${count} of ${VEGETATION_FLOOR} instance(s) after the full ${(VEGETATION_WAIT_MS / 1000).toFixed(0)}s budget`)
  return count === null ? 0 : count
}

async function frameProbe(page, ms) {
  const deltas = await page.evaluate((probeMs) => new Promise((resolve) => {
    const frameDeltas = []
    let last = performance.now()
    let first = true
    const t0 = performance.now()
    function tick(now) {
      const dt = now - last
      last = now
      if (!first) frameDeltas.push(dt)
      first = false
      if (now - t0 < probeMs) requestAnimationFrame(tick)
      else resolve(frameDeltas)
    }
    requestAnimationFrame(tick)
  }), ms)
  if (!Array.isArray(deltas) || deltas.length === 0) return null
  const sorted = deltas.slice().sort((a, b) => a - b)
  return { samples: sorted.length, p50Ms: percentile(sorted, 0.5), worstMs: sorted[sorted.length - 1] }
}

async function settleAtPose(page, label) {
  const started = Date.now()
  let previous = null
  let stablePolls = 0
  let slowProbes = 0
  while (Date.now() - started < SETTLE_BUDGET_MS) {
    await new Promise(r => setTimeout(r, SETTLE_POLL_MS))
    const count = await vegetationCount(page)
    if (count === null) { previous = null; stablePolls = 0; continue }
    stablePolls = count === previous ? stablePolls + 1 : 0
    previous = count
    if (stablePolls < SETTLE_STABLE_POLLS) continue
    const probe = await frameProbe(page, SETTLE_PROBE_MS).catch(() => null)
    if (probe && probe.samples >= SETTLE_MIN_PROBE_SAMPLES && probe.worstMs <= probe.p50Ms * SETTLE_WORST_FRAME_FACTOR) {
      console.log(`[frame-time-gate] ${label}: settled at ${count} vegetation instance(s) after ${((Date.now() - started) / 1000).toFixed(0)}s (probe p50=${probe.p50Ms.toFixed(2)}ms worst=${probe.worstMs.toFixed(2)}ms over ${probe.samples} frame(s))`)
      return count
    }
    if (probe && probe.samples < SETTLE_MIN_PROBE_SAMPLES) {
      slowProbes++
      console.log(`[frame-time-gate] ${label}: a ${SETTLE_PROBE_MS}ms probe presented only ${probe.samples} frame(s), under the ${SETTLE_MIN_PROBE_SAMPLES} a ${SETTLE_PROBE_MS}ms window needs to hold a frame budget this gate can compare, so this box is not presenting frames fast enough to measure (${slowProbes} of ${SETTLE_SLOW_PROBE_LIMIT} such probe(s))`)
      if (slowProbes >= SETTLE_SLOW_PROBE_LIMIT) {
        throw new Error(`${label} presented fewer than ${SETTLE_MIN_PROBE_SAMPLES} frames per ${SETTLE_PROBE_MS}ms on ${slowProbes} consecutive probes while vegetation held at ${count} instance(s) -- this box is not presenting frames fast enough to measure, so no arm is admitted`)
      }
    } else {
      slowProbes = 0
      if (probe) {
        console.log(`[frame-time-gate] ${label}: vegetation held at ${count} but a ${SETTLE_PROBE_MS}ms probe hit a ${probe.worstMs.toFixed(2)}ms frame against p50 ${probe.p50Ms.toFixed(2)}ms, so streaming is still stalling frames`)
      }
    }
  }
  throw new Error(`${label} never settled inside the ${(SETTLE_BUDGET_MS / 1000).toFixed(0)}s budget (last vegetation count ${previous}) -- the page never reached a frame rate this gate can measure, so no arm is admitted`)
}

async function measureGpuControl(label, iterations) {
  const probe = iterations
    ? await gpuControlProbe({ iterations, args: GPU_CONTROL_ARGS, tag: 'gate' }).catch((e) => {
      console.log(`[frame-time-gate] gpu control ${label} unavailable: ${e.message}`)
      return null
    })
    : await gpuControlCalibrate({ args: GPU_CONTROL_ARGS, tag: 'gate' })
  if (!probe) {
    console.log(`[frame-time-gate] gpu control ${label}: measured no adapter cadence, so this run carries no evidence the adapter was idle`)
    return null
  }
  console.log(`[frame-time-gate] gpu control ${label}: ${probe.p50Ms.toFixed(2)}ms per ${probe.iterations}-iteration quantum over ${probe.samples} sample(s), ${gpuControlRate(probe).toFixed(2)}ms per 1000 iteration(s), worst ${probe.worstMs.toFixed(2)}ms`)
  if (!gpuControlSensitive(probe)) {
    console.log(`[frame-time-gate] gpu control ${label}: ${probe.p50Ms.toFixed(2)}ms is under the ${GPU_CONTROL_MIN_P50_MS}ms a control page needs before its cadence can move with adapter load, so this probe cannot see contention`)
  }
  return probe
}

function formatGpuControl(gpuControl) {
  const parts = []
  for (const key of ['before', 'after']) {
    const probe = gpuControl && gpuControl[key]
    if (probe) parts.push(`${key} ${probe.p50Ms.toFixed(2)}ms`)
  }
  return parts.length ? parts.join(', ') : 'no cadence'
}

function gpuContentionRefusals(gpuControl) {
  const before = gpuControl && gpuControl.before
  const after = gpuControl && gpuControl.after
  const reasons = []
  if (!before || !after) {
    reasons.push('the GPU control probe produced no adapter cadence, so this run carries no evidence the adapter was idle while it measured')
    return reasons
  }
  if (!gpuControlSensitive(before) || !gpuControlSensitive(after)) {
    reasons.push(`the GPU control page never reached ${GPU_CONTROL_MIN_P50_MS}ms per quantum (${formatGpuControl(gpuControl)}), so a fixed overhead could dominate its cost and this run cannot tell a shared adapter from an idle one`)
  }
  for (const [key, probe] of [['before the app booted', before], ['after the app closed', after]]) {
    if (probe.worstMs > probe.p50Ms * GPU_CONTROL_INSTABILITY_FACTOR) {
      reasons.push(`the GPU control page hit a ${probe.worstMs.toFixed(2)}ms quantum against its own p50 of ${probe.p50Ms.toFixed(2)}ms ${key} (over x${GPU_CONTROL_INSTABILITY_FACTOR}), so another process was taking the adapter while this run measured`)
    }
  }
  const spread = gpuControlSpread(before, after)
  if (spread != null && spread > GPU_CONTROL_SPREAD_FACTOR) {
    reasons.push(`the adapter's own cost moved from ${gpuControlRate(before).toFixed(2)}ms to ${gpuControlRate(after).toFixed(2)}ms per 1000 control iterations across this run (x${spread.toFixed(2)}, over x${GPU_CONTROL_SPREAD_FACTOR}), so this run shared its adapter`)
  }
  return reasons
}

function fingerprintRefusals(base, run) {
  if (!base) return []
  const reasons = []
  if (base.cpuContested === false && run.cpuContested === true) {
    reasons.push(`the baseline was captured while the CPU-spin probe read clean, this run reads CPU contested (x${run.cpuSlowdown})`)
  }
  for (const [key, when] of [['gpuControlBeforeMsPerK', 'before the app booted'], ['gpuControlAfterMsPerK', 'after the app closed']]) {
    const baseRate = base[key]
    const runRate = run[key]
    if (baseRate == null || runRate == null) continue
    if (runRate > baseRate * GPU_FINGERPRINT_TOLERANCE) {
      reasons.push(`the GPU control page cost ${runRate.toFixed(2)}ms per 1000 iterations ${when} against the baseline's ${baseRate.toFixed(2)}ms (over x${GPU_FINGERPRINT_TOLERANCE}), so this run's adapter is busier than the box the baseline came from`)
    }
  }
  return reasons
}

async function moveToStaticPose(page) {
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
}

async function capturePose(page) {
  return page.evaluate((captureMs) => new Promise((resolve) => {
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
}

async function measureRealFrameTimes() {
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = PORT
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'

  console.log(`[frame-time-gate] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const controlBefore = await measureGpuControl('before the app boots')
  rebuildIfRequested('frame-time-gate')
  const { boot } = await import('../src/sdk/server.js')
  let server = null
  let browser
  try {
    server = await boot()
    console.log('[frame-time-gate] server up.')

    browser = await chromium.launch({ headless: true, args: [...gpuArgs({ accelerated: ACCELERATED }), ...VENDOR_ARGS, ...UNLOCKED_RAF_ARGS] })
    if (!UNLOCK_RAF) console.log('[frame-time-gate] rAF is vsync-locked (SPOINT_UNLOCK_RAF=0), so frame times here carry the refresh divisor')
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))

    const url = `http://localhost:${PORT}/?singleplayer&world=${process.env.WORLD}&at=${encodeURIComponent(AT)}`
    console.log(`[frame-time-gate] navigating to ${url} ...`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'frame-time-gate' })
    console.log(`[frame-time-gate] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

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
    console.log(`[frame-time-gate] rasterizer class=${GPU_MODE.mode} -- ${GPU_MODE.software ? 'software rasterizer, so these frame times are CPU raster cost on this machine and are not accelerated GPU frame cost' : 'accelerated rasterizer'}`)
    const floorCount = await waitForVegetationFloor(page)
    if (!(floorCount >= VEGETATION_FLOOR)) {
      throw new Error(`vegetation stands at ${floorCount} instance(s), under the ${VEGETATION_FLOOR} floor -- an empty-vegetation scene is a different workload than the baseline records, so no arm is admitted`)
    }

    await moveToStaticPose(page)
    await settleAtPose(page, 'static pose')
    const watch = contentionWatch()
    console.log(`[frame-time-gate] capturing static pose (${CAPTURE_MS}ms) ...`)
    const staticResult = await withTimeout(capturePose(page), `the ${CAPTURE_MS}ms static capture`, CAPTURE_TIMEOUT_MS)
    contentionMark(watch)

    await settleAtPose(page, 'orbit pose')
    contentionMark(watch)
    console.log(`[frame-time-gate] capturing orbit pose (${CAPTURE_MS}ms, r=8) ...`)
    const orbitResult = await withTimeout(page.evaluate((captureMs) => new Promise((resolve) => {
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
    }), CAPTURE_MS), `the ${CAPTURE_MS}ms orbit capture`, CAPTURE_TIMEOUT_MS)

    const vegInstances = await evaluateOrThrow(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => 0)
    console.log(`[frame-time-gate] vegetation instances resident during the capture: ${vegInstances}`)

    if (pageErrors.length > 0) throw new Error(`page threw ${pageErrors.length} uncaught error(s): ${pageErrors[0]}`)

    await browser.close()
    browser = null
    const controlAfter = await measureGpuControl('after the app browser closed')

    return { staticResult, orbitResult, gpu, vegInstances, watch, gpuControl: { before: controlBefore, after: controlAfter } }
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) server.stop()
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

  const contention = contentionVerdict(raw.watch)
  console.log(`[frame-time-gate] ${formatContention(contention)}`)

  const staticStats = summarize(raw.staticResult.frameDeltas)
  const orbitStats = summarize(raw.orbitResult.frameDeltas)
  const staticRates = counterRates(raw.staticResult.counters)
  const orbitRates = counterRates(raw.orbitResult.counters)
  console.log(`[frame-time-gate] counter probe: first=${JSON.stringify(raw.orbitResult.counters[0])} last=${JSON.stringify(raw.orbitResult.counters[raw.orbitResult.counters.length - 1])} samples=${raw.orbitResult.counters.length}`)
  const gpuRefusals = gpuContentionRefusals(raw.gpuControl)
  const metrics = {
    rasterizer: raw.gpu.rasterizer,
    headSha: gitHeadSha(),
    vendor: (raw.gpu.adapter && raw.gpu.adapter.vendor) || VENDOR || null,
    gpu: raw.gpu.haystack || null,
    vegInstances: raw.vegInstances,
    fingerprint: {
      gpuControlIterations: (raw.gpuControl && raw.gpuControl.before && raw.gpuControl.before.iterations) || null,
      gpuControlBeforeP50Ms: (raw.gpuControl && raw.gpuControl.before && raw.gpuControl.before.p50Ms) || null,
      gpuControlAfterP50Ms: (raw.gpuControl && raw.gpuControl.after && raw.gpuControl.after.p50Ms) || null,
      gpuControlBeforeMsPerK: gpuControlRate(raw.gpuControl && raw.gpuControl.before),
      gpuControlAfterMsPerK: gpuControlRate(raw.gpuControl && raw.gpuControl.after),
      gpuControlSpread: gpuControlSpread(raw.gpuControl && raw.gpuControl.before, raw.gpuControl && raw.gpuControl.after),
      cpuContested: contention.contested,
      cpuSlowdown: contention.slowdown == null ? null : contention.slowdown,
      chromeProcessCount: chromeProcessCount(),
    },
    static: { ...staticStats, avgDrawCalls: staticRates.drawCalls, avgTriangles: staticRates.triangles },
    orbit: { ...orbitStats, avgDrawCalls: orbitRates.drawCalls, avgTriangles: orbitRates.triangles },
  }

  const previousBaseline = UPDATE ? readBaseline() : null
  const gpuSpread = metrics.fingerprint.gpuControlSpread
  console.log(`[frame-time-gate] adapter fingerprint: control ${(metrics.fingerprint.gpuControlBeforeMsPerK || 0).toFixed(2)}ms per 1000 iteration(s) before the app booted, ${(metrics.fingerprint.gpuControlAfterMsPerK || 0).toFixed(2)}ms after it closed (spread x${gpuSpread == null ? 0 : gpuSpread.toFixed(2)}, bar x${GPU_CONTROL_SPREAD_FACTOR}), ${metrics.fingerprint.chromeProcessCount == null ? 'chrome process count unknown' : `${metrics.fingerprint.chromeProcessCount} chrome.exe process(es)`}, cpu contested ${contention.contested}`)

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
    const refusals = baselineRefusals(metrics)
    if (contention.contested) {
      refusals.push(`host contention ${contention.peakMs} ms is x${contention.slowdown} of this run's cleanest ${contention.bestMs} ms, so these frame times measure a shared box`)
    }
    refusals.push(...gpuRefusals)
    const previousOrbitP50Ms = previousBaseline && previousBaseline.orbit ? previousBaseline.orbit.p50Ms : null
    if (previousOrbitP50Ms != null && metrics.orbit.p50Ms > previousOrbitP50Ms * THRESHOLD && !ACCEPT_SLOWER) {
      refusals.push(`this capture's orbit p50 ${metrics.orbit.p50Ms.toFixed(2)}ms is over the x${THRESHOLD} band above the ${previousOrbitP50Ms.toFixed(2)}ms baseline it would replace (limit ${(previousOrbitP50Ms * THRESHOLD).toFixed(2)}ms) -- a baseline may not be captured slower than the one it replaces, so re-run on a quiet box, or name the landed change that made the world slower with --accept-slower=<reason>`)
    }
    if (refusals.length) {
      console.error(`[frame-time-gate] REFUSING to capture an inadmissible baseline: ${refusals.join('; ')}`)
      process.exit(1)
    }
    if (ACCEPT_SLOWER) metrics.acceptedSlower = { reason: ACCEPT_SLOWER, previousOrbitP50Ms }
    writeBaseline(metrics)
    console.log('[frame-time-gate] baseline updated. PASS')
    process.exit(0)
  }

  const refusals = baselineRefusals(baseline, metrics)
  if (refusals.length) {
    console.error(`[frame-time-gate] BASELINE NOT ADMISSIBLE: ${refusals.join('; ')}`)
    process.exit(1)
  }

  refusals.push(...gpuRefusals)
  refusals.push(...fingerprintRefusals(baseline.fingerprint, metrics.fingerprint))
  if (refusals.length) {
    console.error(`[frame-time-gate] RESULT: FAIL -- this run's box does not match the box the baseline was captured on: ${refusals.join('; ')}`)
    process.exit(1)
  }

  if (contention.contested) {
    console.error(`[frame-time-gate] RESULT: FAIL -- ${formatContention(contention)}, so this run's orbit p50 ${metrics.orbit.p50Ms.toFixed(2)}ms measures a shared box and cannot be compared against the baseline -- re-run it alone`)
    process.exit(1)
  }

  console.log(`[frame-time-gate] baseline captured at ${baseline.headSha || 'an unrecorded commit'} with ${baseline.vegInstances} vegetation instance(s); this run is at ${metrics.headSha || 'an unrecorded commit'} with ${metrics.vegInstances}`)

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
