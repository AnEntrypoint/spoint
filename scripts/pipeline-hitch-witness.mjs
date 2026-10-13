#!/usr/bin/env node
// Witness: an inventory of first-use WebGPU pipeline compiles, and WHEN they land.
//
// The class this kills: a pipeline is minted the first time its render object is drawn, so the
// compile lands inside the frame that first needs the object -- a hitch, not a steady-state cost.
// `client/core/ProgramReadiness.js` hands three's `Pipelines.getForRender` a promises sink so the
// final `device.createRenderPipeline` goes async; everything three does BEFORE that call -- the
// TSL node graph build, `device.createShaderModule` for both stages, `createBindGroupLayout` and
// `createPipelineLayout` -- is still synchronous and still on the draw path. This witness measures
// each of those sites separately, per frame, from the first frame of the page to the last.
//
// It answers three questions and refuses to answer anything it did not measure:
//   * how many creations there are, and how expensive the worst one is, at each site;
//   * WHEN they land -- boot or steady state, which frame, and how long that frame was;
//   * whether the frame that first needs a pipeline is still the worst frame of the run.
//
// Two controls keep the numbers honest:
//   --revert=1  restores the un-wrapped `getForRender`, which is exactly the behaviour before the
//               async sink existed. An instrument that reads the same number with and without the
//               fix it is measuring has not measured the fix.
//   settle()    will not start the capture window until the vegetation count and the frame time
//               have both been stable, so a capture that starts mid-stream measures streaming.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuArgs } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'
import { contentionWatch, contentionMark, contentionVerdict, formatContention } from './lib/host-contention.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}
const bool = (name, dflt) => {
  const hit = process.argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='))
  if (!hit) return dflt
  const v = hit.slice(name.length + 2)
  return v === '' || v === '=true' || v === '1' ? true : v === '=false' || v === '0' ? false : dflt
}
const num = (name, dflt) => {
  const raw = flag(name, '')
  const v = Number(raw)
  return raw === '' || !Number.isFinite(v) ? dflt : v
}
const MODE = flag('mode', 'inventory')
const VENDOR = flag('vendor', process.env.SPOINT_GPU || 'amd')
const WORLD = flag('world', 'tps-game')
const PORT = flag('port', '3097')
const AT = flag('at', '-15,-12.5')
const CAPTURE_MS = num('capture-ms', 8000)
const VEGETATION_FLOOR = num('veg-floor', 1000)
const VEGETATION_WAIT_MS = num('veg-wait-ms', 420000)
const SETTLE_BUDGET_MS = num('settle-budget-ms', 240000)
const LOAD_TIMEOUT_MS = num('load-timeout-ms', 480000)
const CAPTURE_TIMEOUT_MS = CAPTURE_MS * 6 + 60000
const MIN_STEADY_FRAMES = num('min-steady-frames', 40)
const REVERT = bool('revert', false)
const NO_DEFER = bool('nodefer', false)
const UNLOCKED_RAF_ARGS = process.env.SPOINT_UNLOCK_RAF === '0' ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync']
const VENDOR_ARGS = vendorPinArgs(VENDOR)

// Every GPUDevice factory three reaches while minting a pipeline. `createRenderPipeline` and
// `createShaderModule` have no async form, so they are the sites that can still block a frame;
// the async forms are recorded too, because a creation that goes async still costs main-thread
// time to set up and still has to be shown not to land anywhere.
const SITES = [
  ['createRenderPipeline', false],
  ['createRenderPipelineAsync', true],
  ['createShaderModule', false],
  ['createBindGroupLayout', false],
  ['createPipelineLayout', false],
  ['createComputePipeline', false],
  ['createComputePipelineAsync', true],
]

const PAGE_INSTRUMENT = [
  '(() => {',
  ...(NO_DEFER ? ['  window.__spointDeferFirstUse = false'] : []),
  '  if (typeof GPUDevice === "undefined" || !GPUDevice.prototype) {',
  '    window.__pipelineProbe = { installed: false, reason: "GPUDevice is not a global on this page, so no WebGPU pipeline can be attributed" }',
  '    return',
  '  }',
  '  const log = []',
  '  const frames = []',
  '  let frame = -1',
  '  let last = performance.now()',
  // One rAF chain, registered before anything else on the page, is the only clock this witness
  // trusts: frames[i] is the wall time of frame i, filled in when frame i+1 ticks. A creation
  // recorded at frame i therefore sits inside frames[i] and nowhere else.
  '  const tick = (now) => {',
  '    const i = ++frame',
  '    if (i > 0) frames[i - 1] = now - last',
  '    last = now',
  '    requestAnimationFrame(tick)',
  '  }',
  '  requestAnimationFrame(tick)',
  '  const probe = { installed: true, log, frames, frameOf: () => frame, bootEnd: -1, bootEndFrame: -1 }',
  '  probe.startT = performance.now()',
  '  window.__pipelineProbe = probe',
  '  const wrap = (name, awaited) => {',
  '    const proto = GPUDevice.prototype',
  '    const original = proto[name]',
  '    if (typeof original !== "function") {',
  '      probe.installed = false',
  '      probe.reason = "GPUDevice.prototype." + name + " is not a function"',
  '      return',
  '    }',
  '    proto[name] = function (descriptor) {',
  '      const t0 = performance.now()',
  '      const label = descriptor && descriptor.label ? String(descriptor.label) : "(unlabelled)"',
  '      const at = frame',
  '      const result = original.call(this, descriptor)',
  '      const mainThreadMs = performance.now() - t0',
  '      if (!awaited) {',
  '        log.push({ kind: name, label, frame: at, t: t0, mainThreadMs, settledMs: mainThreadMs })',
  '        return result',
  '      }',
  '      Promise.resolve(result).then(',
  '        () => log.push({ kind: name, label, frame: at, t: t0, mainThreadMs, settledMs: performance.now() - t0 }),',
  '        () => log.push({ kind: name, label, frame: at, t: t0, mainThreadMs, settledMs: performance.now() - t0, rejected: true }),',
  '      )',
  '      return result',
  '    }',
  '  }',
  ...SITES.map(([name, awaited]) => `  wrap(${JSON.stringify(name)}, ${awaited})`),
  '  const longTasks = []',
  '  probe.longTasks = longTasks',
  '  try {',
  '    new PerformanceObserver((list) => {',
  '      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration, name: e.name || "longtask" })',
  '    }).observe({ type: "longtask" })',
  '  } catch (_) { probe.longTasksUnsupported = true }',
  '})()',
].join('\n')

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function worstOf(entries) {
  let worst = null
  for (const e of entries) if (!worst || e.mainThreadMs > worst.mainThreadMs) worst = e
  return worst
}

function labelHistogram(entries) {
  const byLabel = new Map()
  for (const e of entries) {
    const key = e.kind + ' ' + e.label.replace(/_[0-9]+$/, '_N')
    byLabel.set(key, (byLabel.get(key) || 0) + 1)
  }
  return [...byLabel.entries()].sort((a, b) => b[1] - a[1])
}

function evaluateWithDeadline(page, fn, ms, arg) {
  return Promise.race([
    Promise.resolve(page.evaluate(fn, arg)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('page.evaluate did not answer within ' + ms + 'ms -- the page main thread is blocked')), ms)),
  ])
}

async function waitForReady(page) {
  const start = Date.now()
  while (Date.now() - start < LOAD_TIMEOUT_MS) {
    const probe = await evaluateWithDeadline(page, () => ({
      ready: !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady),
      state: window.__app && window.__app.loadingMachine ? String(window.__app.loadingMachine.state) : null,
    }), 20000).catch((e) => ({ stalled: e.message }))
    if (probe.stalled) {
      console.log('[pipeline-hitch] isReady probe stalled: ' + probe.stalled)
    } else if (probe.ready) {
      return Date.now() - start
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('loadingMachine never reached isReady within ' + LOAD_TIMEOUT_MS + 'ms')
}

async function waitForDrawing(page) {
  const start = Date.now()
  let prev = null
  while (Date.now() - start < 180000) {
    const now = await evaluateWithDeadline(page, () => {
      const i = window.__app && window.__app.renderer && window.__app.renderer.info
      return i ? { calls: i.render.calls } : null
    }, 15000).catch(() => null)
    if (now) {
      if (prev !== null && now.calls - prev >= 5) return
      prev = now.calls
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('renderer.info.render.calls never advanced -- the page is not presenting frames')
}

// A profile that is absent and a profile that reads zero are different facts, and the run has to
// say which one it got: `|| 0` would report an absent instrument as an empty world.
async function vegetationCount(page) {
  return evaluateWithDeadline(page, () => {
    const p = window.__vegProfile
    if (!p) return { available: false, count: 0 }
    return { available: true, count: p.totalInstances || 0 }
  }, 15000).catch(() => null)
}

async function waitForVegetationFloor(page) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < VEGETATION_WAIT_MS) {
    last = await vegetationCount(page)
    if (last && last.available && last.count >= VEGETATION_FLOOR) {
      console.log('[pipeline-hitch] vegetation floor met: ' + last.count + ' instance(s) after ' + ((Date.now() - start) / 1000).toFixed(0) + 's')
      return last.count
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  if (!last || last.available !== true) {
    // Vegetation is one source of first uses, not the only one, and the shared tree can be mid-edit
    // under another lane. The run says so and measures whatever this page actually drew.
    console.log('[pipeline-hitch] window.__vegProfile is absent after ' + VEGETATION_WAIT_MS + 'ms, so the vegetation floor cannot be checked -- this run measured whatever this page drew')
    return 0
  }
  throw new Error('vegetation reached ' + last.count + ' instance(s), under the ' + VEGETATION_FLOOR + ' floor -- an empty-vegetation world is a different workload')
}

async function settle(page) {
  const start = Date.now()
  let previous = null
  let stable = 0
  let probeStable = 0
  while (Date.now() - start < SETTLE_BUDGET_MS) {
    await new Promise((r) => setTimeout(r, 3000))
    const seen = await vegetationCount(page)
    const count = seen && seen.available ? seen.count : null
    if (count === null) { previous = null; stable = 0 } else {
      stable = count === previous ? stable + 1 : 0
      previous = count
    }
    const probe = await evaluateWithDeadline(page, (ms) => new Promise((resolve) => {
      const deltas = []
      let last = performance.now()
      let first = true
      const t0 = last
      const tick = (now) => {
        const dt = now - last
        last = now
        if (!first) deltas.push(dt)
        first = false
        if (now - t0 < ms) requestAnimationFrame(tick)
        else resolve(deltas)
      }
      requestAnimationFrame(tick)
    }), 30000, 2000).catch(() => null)
    if (!probe) { probeStable = 0; continue }
    const sorted = probe.slice().sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const worst = sorted[sorted.length - 1]
    const quiet = probe.length >= MIN_STEADY_FRAMES && worst <= p50 * 4
    probeStable = quiet ? probeStable + 1 : 0
    // The vegetation count is a second, independent signal; where the profile is absent the frame
    // probe alone decides, and the run has already said so.
    if (probeStable >= 2 && (count === null || stable >= 3)) {
      console.log('[pipeline-hitch] settled at ' + (count === null ? 'an unreported vegetation count' : count + ' instance(s)') + ': probe p50=' + p50.toFixed(2) + 'ms worst=' + worst.toFixed(2) + 'ms over ' + probe.length + ' frame(s)')
      return count
    }
  }
  throw new Error('the pose never settled inside ' + SETTLE_BUDGET_MS + 'ms (last vegetation count ' + previous + ')')
}

// Control arm: hand `getForRender` and `updateForRender` back to three untouched, so the draw path
// neither gets a promises sink nor defers a first use -- every pipeline is minted synchronously
// inside the frame that first draws its object.
async function revertAsyncPipelines(page) {
  return evaluateWithDeadline(page, () => {
    const renderer = window.__app && window.__app.renderer
    const pipelines = renderer && renderer._pipelines
    if (!pipelines) return { ok: false, reason: 'renderer._pipelines is absent, so there is no wrapper to revert' }
    const proto = Object.getPrototypeOf(pipelines)
    const restored = []
    for (const [name, key] of [['getForRender', '__spointOriginalGetForRender'], ['updateForRender', '__spointOriginalUpdateForRender']]) {
      const desc = proto && Object.getOwnPropertyDescriptor(proto, name)
      const wrapped = desc && desc.value
      const orig = wrapped && wrapped[key]
      if (typeof orig === 'function') {
        Object.defineProperty(proto, name, { value: orig, writable: true, configurable: true })
        restored.push(name)
      }
    }
    if (restored.length === 0) return { ok: false, reason: 'neither getForRender nor updateForRender carries an original, so this page never installed either' }
    return { ok: true, restored }
  }, 15000)
}

async function orbitCapture(page) {
  return evaluateWithDeadline(page, (captureMs) => new Promise((resolve) => {
    const MOUSE_SENSITIVITY = 0.002
    const SWEEP_RAD = 0.25
    const SWEEPS = 2
    let appliedYaw = 0
    let last = performance.now()
    let first = true
    const t0 = last
    const tick = (now) => {
      last = now
      const wantYaw = SWEEP_RAD * Math.sin((2 * Math.PI * SWEEPS * (now - t0)) / captureMs)
      const deltaYaw = wantYaw - appliedYaw
      appliedYaw = wantYaw
      window.__app && window.__app.cam && window.__app.cam.editLook && window.__app.cam.editLook(deltaYaw / MOUSE_SENSITIVITY, 0)
      if (first) { first = false; resolve({ startFrame: window.__pipelineProbe.frameOf() }) }
      if (now - t0 < captureMs) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), CAPTURE_TIMEOUT_MS, CAPTURE_MS)
}

async function main() {
  process.env.WORLD = WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rebuildIfRequested('pipeline-hitch')

  console.log('[pipeline-hitch] booting real server on port ' + PORT + ' (world=' + WORLD + ') ...')
  const { boot } = await import('../src/sdk/server.js')
  let server = null
  let browser = null
  try {
    server = await boot()
    console.log('[pipeline-hitch] server up.')

    browser = await chromium.launch({ headless: true, args: [...gpuArgs({ accelerated: true }), ...VENDOR_ARGS, ...UNLOCKED_RAF_ARGS] })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_INSTRUMENT })

    const url = 'http://localhost:' + PORT + '/?singleplayer&world=' + WORLD + '&at=' + encodeURIComponent(AT)
    console.log('[pipeline-hitch] navigating to ' + url + ' ...')
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'pipeline-hitch' })
    console.log('[pipeline-hitch] served ' + clientRootTag(servedRoot))

    const readyMs = await waitForReady(page)
    console.log('[pipeline-hitch] loadingMachine.isReady after ' + (readyMs / 1000).toFixed(1) + 's')

    const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: VENDOR })
    console.log('[pipeline-hitch] rasterizer=' + gpu.rasterizer + ' renderer=' + (gpu.renderer || 'none') + ' adapter=' + (gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor || 'yes') : 'none'))

    const installed = await evaluateWithDeadline(page, () => {
      const p = window.__pipelineProbe
      return p ? { installed: p.installed, reason: p.reason || null } : null
    }, 15000)
    if (!installed || installed.installed !== true) {
      throw new Error('the pipeline instrument never installed' + (installed && installed.reason ? ': ' + installed.reason : ' -- window.__pipelineProbe is absent, so this run measured no pipeline creation'))
    }

    if (REVERT) {
      const reverted = await revertAsyncPipelines(page)
      if (!reverted.ok) throw new Error('the revert control could not run: ' + reverted.reason)
      console.log('[pipeline-hitch] CONTROL: getForRender reverted to three\'s own, so every pipeline is minted synchronously on the draw path')
    }

    await page.evaluate(() => { window.__app && window.__app.clientMachine && window.__app.clientMachine.send && window.__app.clientMachine.send('TOGGLE_EDITOR') }).catch(() => {})
    const camStart = Date.now()
    let camReady = false
    while (Date.now() - camStart < 10000) {
      camReady = await evaluateWithDeadline(page, () => !!(window.__app && window.__app.cam && window.__app.cam.setEditCameraPosition), 15000).catch(() => false)
      if (camReady) break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!camReady) throw new Error('window.__app.cam.setEditCameraPosition never became available within 10s of TOGGLE_EDITOR')

    await waitForDrawing(page)
    const vegInstances = await waitForVegetationFloor(page)
    await settle(page)

    await evaluateWithDeadline(page, () => {
      const p = window.__pipelineProbe
      p.bootEnd = p.log.length
      p.taskMark = p.longTasks.length
      p.bootEndFrame = p.frameOf()
      return { bootEnd: p.bootEnd, bootEndFrame: p.bootEndFrame, taskMark: p.taskMark }
    }, 15000)
    const mark = await evaluateWithDeadline(page, () => ({ bootEnd: window.__pipelineProbe.bootEnd, bootEndFrame: window.__pipelineProbe.bootEndFrame }), 15000)
    console.log('[pipeline-hitch] steady-state mark: ' + mark.bootEnd + ' pipeline(s) and ' + mark.bootEndFrame + ' frame(s) already recorded at boot')

    const watch = contentionWatch()
    console.log('[pipeline-hitch] capturing orbit pose (' + CAPTURE_MS + 'ms) ...')
    await orbitCapture(page)
    contentionMark(watch)
    const contention = contentionVerdict(watch)

    const final = await evaluateWithDeadline(page, (fromFrame) => {
      const p = window.__pipelineProbe
      const top = (lo, hi, n) => {
        const out = []
        for (let i = lo; i < hi; i++) if (Number.isFinite(p.frames[i]) && p.frames[i] > 0) out.push({ i, dt: p.frames[i] })
        out.sort((a, b) => b.dt - a.dt)
        return out.slice(0, n)
      }
      const stats = (lo, hi) => {
        const all = []
        for (let i = lo; i < hi; i++) if (Number.isFinite(p.frames[i]) && p.frames[i] > 0) all.push(p.frames[i])
        all.sort((a, b) => a - b)
        if (all.length === 0) return { n: 0, p50: 0, p95: 0, worst: 0, worstFrame: -1 }
        return { n: all.length, p50: all[Math.floor(0.5 * all.length)] || 0, p95: all[Math.floor(0.95 * all.length)] || 0, worst: all[all.length - 1], worstFrame: top(lo, hi, 1)[0].i }
      }
      // A frame before the world is revealed is a frame nobody is looking at, so the frame windows
      // that can carry a VISIBLE hitch are the streaming window after the reveal and the settled
      // window after that. The hidden window is still reported, because that is where a prewarm
      // has to have moved the cost to.
      const revealFrame = (() => {
        const at = window.__app && window.__app.revealedAt
        if (!at) return -1
        let acc = p.startT || 0
        for (let i = 0; i < p.frames.length; i++) {
          const d = p.frames[i]
          if (!Number.isFinite(d) || d <= 0) continue
          acc += d
          if (acc >= at) return i
        }
        return p.frames.length
      })()
      const empty = { n: 0, p50: 0, p95: 0, worst: 0, worstFrame: -1 }
      const out = {
        log: p.log.slice(0, 20000),
        logDropped: Math.max(0, p.log.length - 20000),
        longTasks: p.longTasks.slice(0, 5000),
        unsupported: !!p.longTasksUnsupported,
        boot: stats(0, fromFrame),
        steady: stats(fromFrame, p.frames.length),
        bootTop: top(0, fromFrame, 10),
        steadyTop: top(fromFrame, p.frames.length, 10),
        total: p.frames.length,
        deferState: window.__deferredFirstUsePipelines ? { ...window.__deferredFirstUsePipelines } : null,
        revealFrame,
      }
      out.hidden = revealFrame > 0 ? stats(0, revealFrame) : empty
      out.stream = revealFrame > 0 ? stats(revealFrame, fromFrame) : out.boot
      out.hiddenTop = revealFrame > 0 ? top(0, revealFrame, 5) : []
      out.streamTop = revealFrame > 0 ? top(revealFrame, fromFrame, 5) : out.bootTop
      return out
    }, 60000, mark.bootEndFrame)

    const { log, longTasks } = final
    const bootEntries = log.slice(0, mark.bootEnd)
    const steadyEntries = log.slice(mark.bootEnd)
    // A creation that has no async form is the one that can block the frame it lands in.
    const SYNC_KINDS = new Set(['createRenderPipeline', 'createShaderModule', 'createBindGroupLayout', 'createPipelineLayout', 'createComputePipeline'])
    const steadySync = steadyEntries.filter((e) => SYNC_KINDS.has(e.kind))
    const bootSync = bootEntries.filter((e) => SYNC_KINDS.has(e.kind))
    const worstBoot = worstOf(bootEntries)
    const worstSteady = worstOf(steadyEntries)
    const bootStats = final.boot
    const steadyStats = final.steady

    console.log('[pipeline-hitch] inventory: ' + log.length + ' creation(s) (' + bootEntries.length + ' at boot, ' + steadyEntries.length + ' in steady state)')
    console.log('[pipeline-hitch] synchronous (no async form) creations: boot ' + bootSync.length + ', steady ' + steadySync.length)
    for (const [name] of SITES) {
      const all = log.filter((e) => e.kind === name)
      const steady = all.filter((e) => e.frame >= mark.bootEndFrame)
      const w = worstOf(all)
      const sw = worstOf(steady)
      console.log('[pipeline-hitch] site ' + name + ': ' + all.length + ' total, ' + steady.length + ' in steady state, worst ' + (w ? w.mainThreadMs.toFixed(2) : 'n/a') + 'ms' + (sw ? ', worst steady ' + sw.mainThreadMs.toFixed(2) + 'ms ' + sw.label + ' at frame ' + sw.frame : ''))
    }
    if (worstBoot) console.log('[pipeline-hitch] worst boot creation: ' + worstBoot.mainThreadMs.toFixed(2) + 'ms ' + worstBoot.kind + ' ' + worstBoot.label + ' at frame ' + worstBoot.frame)
    if (worstSteady) console.log('[pipeline-hitch] worst steady creation: ' + worstSteady.mainThreadMs.toFixed(2) + 'ms ' + worstSteady.kind + ' ' + worstSteady.label + ' at frame ' + worstSteady.frame)
    for (const [key, count] of labelHistogram(steadyEntries)) console.log('[pipeline-hitch] steady pipeline: ' + count + 'x ' + key)
    const hidden = final.hidden
    const stream = final.stream
    console.log('[pipeline-hitch] window hidden  (frame 0..' + final.revealFrame + '): n=' + hidden.n + ' p50=' + hidden.p50.toFixed(2) + 'ms p95=' + hidden.p95.toFixed(2) + 'ms worst=' + hidden.worst.toFixed(2) + 'ms at frame ' + hidden.worstFrame)
    console.log('[pipeline-hitch] window stream  (frame ' + final.revealFrame + '..' + mark.bootEndFrame + '): n=' + stream.n + ' p50=' + stream.p50.toFixed(2) + 'ms p95=' + stream.p95.toFixed(2) + 'ms worst=' + stream.worst.toFixed(2) + 'ms at frame ' + stream.worstFrame)
    console.log('[pipeline-hitch] window settled (frame ' + mark.bootEndFrame + '..' + final.total + '): n=' + steadyStats.n + ' p50=' + steadyStats.p50.toFixed(2) + 'ms p95=' + steadyStats.p95.toFixed(2) + 'ms worst=' + steadyStats.worst.toFixed(2) + 'ms at frame ' + steadyStats.worstFrame)
    const windowOf = (i) => (i < final.revealFrame ? 'hidden' : i < mark.bootEndFrame ? 'stream' : 'settled')
    for (const [name, top] of [['stream', final.streamTop], ['settled', final.steadyTop], ['hidden', final.hiddenTop]]) {
      for (const f of top.slice(0, 5)) {
        const inside = log.filter((e) => e.frame === f.i)
        console.log('[pipeline-hitch] ' + name + ' frame ' + f.i + ': dt=' + f.dt.toFixed(2) + 'ms with ' + inside.length + ' creation(s) inside it, ' + inside.reduce((a, e) => a + e.mainThreadMs, 0).toFixed(2) + 'ms of them measured')
      }
    }
    const byWindow = { hidden: 0, stream: 0, settled: 0 }
    for (const e of log) byWindow[windowOf(e.frame)]++
    console.log('[pipeline-hitch] creations by window: hidden ' + byWindow.hidden + ', stream ' + byWindow.stream + ', settled ' + byWindow.settled)
    const steadyTasks = longTasks.slice(mark.taskMark)
    let worstTask = null
    for (const t of steadyTasks) if (!worstTask || t.duration > worstTask.duration) worstTask = t
    const createdInside = (t) => log.filter((e) => e.t >= t.start && e.t <= t.start + t.duration).length
    if (final.unsupported) console.log('[pipeline-hitch] longtask observer unavailable on this page, so main-thread stalls carry no attribution')
    else console.log('[pipeline-hitch] steady long tasks: ' + steadyTasks.length + ', worst ' + (worstTask ? worstTask.duration.toFixed(2) + 'ms at t=' + worstTask.start.toFixed(0) + 'ms with ' + createdInside(worstTask) + ' pipeline/module creation(s) inside it' : 'none'))
    const ranked = steadyTasks.slice().sort((a, b) => b.duration - a.duration).slice(0, 5)
    for (const t of ranked) console.log('[pipeline-hitch] long task: ' + t.duration.toFixed(2) + 'ms at t=' + t.start.toFixed(0) + 'ms, ' + createdInside(t) + ' creation(s) inside')
    const ds = final.deferState
    if (ds) console.log('[pipeline-hitch] first-use deferral: ' + ds.deferred + ' deferred, ' + ds.drained + ' drained, ' + ds.skippedReady + ' already ready, ' + ds.buildFailed + ' failed, over ' + ds.slices + ' slice(s), worst slice ' + ds.worstSliceMs.toFixed(2) + 'ms, worst single first use ' + ds.worstBuildMs.toFixed(2) + 'ms' + (ds.installed ? '' : ' (NOT installed)'))
    else console.log('[pipeline-hitch] first-use deferral: window.__deferredFirstUsePipelines is absent, so no first use was deferred on this page')

    const arm = REVERT ? 'revert' : NO_DEFER ? 'nodefer' : 'defer'
    const failures = []
    if (log.length === 0) failures.push('the instrument recorded no pipeline creation, so this run measured nothing')
    if (steadyStats.n < MIN_STEADY_FRAMES) failures.push('the capture presented only ' + steadyStats.n + ' frame(s), under the ' + MIN_STEADY_FRAMES + ' a steady-state frame verdict needs')
    if (contention.contested) failures.push(formatContention(contention) + ', so this run measured a shared box')
    if (MODE === 'gate') {
      if (steadySync.length > 0) failures.push(steadySync.length + ' creation(s) with no async form were still made on the main thread during steady state (worst ' + (worstSteady ? worstSteady.mainThreadMs.toFixed(2) : 'n/a') + 'ms ' + (worstSteady ? worstSteady.label : '') + ')')
      if (!REVERT && (!ds || ds.installed !== true)) failures.push('the first-use deferral never installed, so this run did not measure the path it gates')
    }
    if (failures.length) {
      console.error('[pipeline-hitch] RESULT: FAIL -- ' + failures.join('; '))
      process.exit(1)
    }
    console.log('[pipeline-hitch] RESULT: PASS -- ' + log.length + ' creation(s), ' + steadyEntries.length + ' in steady state (' + steadySync.length + ' with no async form), boot worst frame ' + bootStats.worst.toFixed(2) + 'ms, steady worst frame ' + steadyStats.worst.toFixed(2) + 'ms over ' + steadyStats.n + ' frame(s) [arm=' + arm + ']')
    process.exit(0)
  } finally {
    try { if (browser) await browser.close() } catch (_) {}
    try { if (server && server.stop) await server.stop() } catch (_) {}
  }
}

main().catch((e) => {
  console.error('[pipeline-hitch] ' + (e && e.message ? e.message : e))
  process.exit(1)
})
