#!/usr/bin/env node
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
const UNLOCKED_RAF_ARGS = process.env.SPOINT_UNLOCK_RAF === '0' ? [] : ['--disable-frame-rate-limit', '--disable-gpu-vsync']
const VENDOR_ARGS = vendorPinArgs(VENDOR)

const PAGE_INSTRUMENT = [
  '(() => {',
  '  if (typeof GPUDevice === "undefined" || !GPUDevice.prototype) {',
  '    window.__pipelineProbe = { installed: false, reason: "GPUDevice is not a global on this page, so no WebGPU pipeline can be attributed" }',
  '    return',
  '  }',
  '  const log = []',
  '  let frame = -1',
  '  const tick = () => { frame += 1; requestAnimationFrame(tick) }',
  '  requestAnimationFrame(tick)',
  '  const probe = { installed: true, log, frameOf: () => frame, bootEnd: -1, bootEndFrame: -1 }',
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
  '  wrap("createRenderPipeline", false)',
  '  wrap("createRenderPipelineAsync", true)',
  '  wrap("createShaderModule", false)',
  '  const longTasks = []',
  '  probe.longTasks = longTasks',
  '  try {',
  '    new PerformanceObserver((list) => {',
  '      for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration, name: e.name || "longtask" })',
  '    }).observe({ type: "longtask" })',
  '  } catch (_) { probe.longTasksUnsupported = true }',
  '  wrap("createComputePipeline", false)',
  '  wrap("createComputePipelineAsync", true)',
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

async function vegetationCount(page) {
  return evaluateWithDeadline(page, () => (window.__vegProfile && window.__vegProfile.totalInstances) || 0, 15000).catch(() => null)
}

async function waitForVegetationFloor(page) {
  const start = Date.now()
  while (Date.now() - start < VEGETATION_WAIT_MS) {
    const count = await vegetationCount(page)
    if (count !== null && count >= VEGETATION_FLOOR) {
      console.log('[pipeline-hitch] vegetation floor met: ' + count + ' instance(s) after ' + ((Date.now() - start) / 1000).toFixed(0) + 's')
      return count
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  const last = await vegetationCount(page)
  throw new Error('vegetation reached ' + last + ' instance(s), under the ' + VEGETATION_FLOOR + ' floor -- an empty-vegetation world is a different workload')
}

async function settle(page) {
  const start = Date.now()
  let previous = null
  let stable = 0
  while (Date.now() - start < SETTLE_BUDGET_MS) {
    await new Promise((r) => setTimeout(r, 3000))
    const count = await vegetationCount(page)
    if (count === null) { previous = null; stable = 0; continue }
    stable = count === previous ? stable + 1 : 0
    previous = count
    if (stable < 3) continue
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
    if (!probe) continue
    const sorted = probe.slice().sort((a, b) => a - b)
    const p50 = percentile(sorted, 0.5)
    const worst = sorted[sorted.length - 1]
    if (probe.length >= MIN_STEADY_FRAMES && worst <= p50 * 4) {
      console.log('[pipeline-hitch] settled at ' + count + ' instance(s): probe p50=' + p50.toFixed(2) + 'ms worst=' + worst.toFixed(2) + 'ms over ' + probe.length + ' frame(s)')
      return count
    }
  }
  throw new Error('the pose never settled inside ' + SETTLE_BUDGET_MS + 'ms (last vegetation count ' + previous + ')')
}

async function orbitCapture(page) {
  return evaluateWithDeadline(page, (captureMs) => new Promise((resolve) => {
    const frames = []
    let last = performance.now()
    let first = true
    const t0 = last
    const MOUSE_SENSITIVITY = 0.002
    const SWEEP_RAD = 0.25
    const SWEEPS = 2
    let appliedYaw = 0
    const tick = (now) => {
      const dt = now - last
      last = now
      const wantYaw = SWEEP_RAD * Math.sin((2 * Math.PI * SWEEPS * (now - t0)) / captureMs)
      const deltaYaw = wantYaw - appliedYaw
      appliedYaw = wantYaw
      window.__app && window.__app.cam && window.__app.cam.editLook && window.__app.cam.editLook(deltaYaw / MOUSE_SENSITIVITY, 0)
      if (!first) {
        const probe = window.__pipelineProbe
        frames.push({ dt, frame: probe ? probe.frameOf() : -1, logLen: probe ? probe.log.length : -1 })
      }
      first = false
      if (now - t0 < captureMs) requestAnimationFrame(tick)
      else resolve(frames)
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
    const frames = await orbitCapture(page)
    contentionMark(watch)
    const contention = contentionVerdict(watch)

    const final = await evaluateWithDeadline(page, () => ({
      log: window.__pipelineProbe.log.slice(),
      longTasks: window.__pipelineProbe.longTasks.slice(),
      unsupported: !!window.__pipelineProbe.longTasksUnsupported,
    }), 30000)
    const log = final.log
    const longTasks = final.longTasks
    browser.close().catch(() => {})

    const bootEntries = log.slice(0, mark.bootEnd)
    const steadyEntries = log.slice(mark.bootEnd)
    const steadySync = steadyEntries.filter((e) => e.kind === 'createRenderPipeline' || e.kind === 'createComputePipeline')
    const bootSync = bootEntries.filter((e) => e.kind === 'createRenderPipeline' || e.kind === 'createComputePipeline')
    const worstBoot = worstOf(bootEntries)
    const worstSteady = worstOf(steadyEntries)

    const deltas = frames.map((f) => f.dt).sort((a, b) => a - b)
    const steadyP50 = percentile(deltas, 0.5)
    const steadyWorst = deltas[deltas.length - 1]
    let worstFrame = frames[0]
    for (const f of frames) if (f.dt > worstFrame.dt) worstFrame = f

    console.log('[pipeline-hitch] inventory: ' + log.length + ' pipeline(s) created (' + bootEntries.length + ' at boot, ' + steadyEntries.length + ' in steady state)')
    console.log('[pipeline-hitch] synchronous (main-thread) creations: boot ' + bootSync.length + ', steady ' + steadySync.length)
    if (worstBoot) console.log('[pipeline-hitch] worst boot creation: ' + worstBoot.mainThreadMs.toFixed(2) + 'ms ' + worstBoot.kind + ' ' + worstBoot.label + ' at frame ' + worstBoot.frame)
    if (worstSteady) console.log('[pipeline-hitch] worst steady creation: ' + worstSteady.mainThreadMs.toFixed(2) + 'ms ' + worstSteady.kind + ' ' + worstSteady.label + ' at frame ' + worstSteady.frame)
    for (const [key, count] of labelHistogram(steadyEntries)) console.log('[pipeline-hitch] steady pipeline: ' + count + 'x ' + key)
    console.log('[pipeline-hitch] steady frames: n=' + frames.length + ' p50=' + steadyP50.toFixed(2) + 'ms worst=' + steadyWorst.toFixed(2) + 'ms')
    console.log('[pipeline-hitch] worst steady frame: dt=' + worstFrame.dt.toFixed(2) + 'ms at frame ' + worstFrame.frame + ' with ' + (worstFrame.logLen - mark.bootEnd) + ' steady pipeline(s) created by then')
    const modules = log.filter((e) => e.kind === 'createShaderModule')
    const worstModule = worstOf(modules)
    console.log('[pipeline-hitch] shader modules: ' + modules.length + ' created, worst ' + (worstModule ? worstModule.mainThreadMs.toFixed(2) + 'ms ' + worstModule.label : 'none'))
    const steadyTasks = longTasks.slice(mark.taskMark)
    let worstTask = null
    for (const t of steadyTasks) if (!worstTask || t.duration > worstTask.duration) worstTask = t
    const createdInside = (t) => log.filter((e) => e.t >= t.start && e.t <= t.start + t.duration).length
    if (final.unsupported) console.log('[pipeline-hitch] longtask observer unavailable on this page, so main-thread stalls carry no attribution')
    else console.log('[pipeline-hitch] steady long tasks: ' + steadyTasks.length + ', worst ' + (worstTask ? worstTask.duration.toFixed(2) + 'ms at t=' + worstTask.start.toFixed(0) + 'ms with ' + createdInside(worstTask) + ' pipeline/module creation(s) inside it' : 'none'))
    const ranked = steadyTasks.slice().sort((a, b) => b.duration - a.duration).slice(0, 5)
    for (const t of ranked) console.log('[pipeline-hitch] long task: ' + t.duration.toFixed(2) + 'ms at t=' + t.start.toFixed(0) + 'ms, ' + createdInside(t) + ' creation(s) inside')

    const failures = []
    if (log.length === 0) failures.push('the instrument recorded no pipeline creation, so this run measured nothing')
    if (frames.length < MIN_STEADY_FRAMES) failures.push('the capture presented only ' + frames.length + ' frame(s), under the ' + MIN_STEADY_FRAMES + ' a steady-state frame verdict needs')
    if (contention.contested) failures.push(formatContention(contention) + ', so this run measured a shared box')
    if (MODE === 'gate' && steadySync.length > 0) failures.push(steadySync.length + ' pipeline(s) were still created synchronously on the main thread during steady state (worst ' + (worstSteady ? worstSteady.mainThreadMs.toFixed(2) : 'n/a') + 'ms ' + (worstSteady ? worstSteady.label : '') + ')')
    if (failures.length) {
      console.error('[pipeline-hitch] RESULT: FAIL -- ' + failures.join('; '))
      process.exit(1)
    }
    console.log('[pipeline-hitch] RESULT: PASS -- ' + log.length + ' pipeline(s) created, ' + steadyEntries.length + ' in steady state (' + steadySync.length + ' synchronous), worst steady frame ' + steadyWorst.toFixed(2) + 'ms over ' + frames.length + ' frame(s)')
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
