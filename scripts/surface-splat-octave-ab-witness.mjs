#!/usr/bin/env node
// PERF-terrain-fragment-fetch-budget-1013-wall-unresolved-1013: the frame-wall half of the splat
// octave collapse.
//
// The structural change landed in d78604ae and is pinned gpu-free by
// surface-splat-octave-ab-switch-witness.mjs. What was NOT resolved is its wall delta: the arm that
// measured it ran at a pose where thread ~= wall, so the frame was MAIN-THREAD bound and the
// instrument could not have shown a fragment win at any magnitude. A sibling lane has since
// retracted a headline number for exactly the other failure: two logs from DIFFERENT runs published
// as a comparison. So this witness does three things before it will quote anything:
//
//   1. ONE page load, ONE tree, ONE run id. `splatOctaveCollapse` is a uniform the fragment guard
//      reads, so both arms come from the same loaded page and the arms INTERLEAVE -- the order
//      alternates per round, so a box that is drifting slowly cannot line up with an arm.
//   2. A POSE PROOF before any measurement. If the frame wall is not clearly above main-thread
//      ThreadTime, this run is measuring the wrong pose and it refuses rather than reporting.
//   3. A CONTENTION FINGERPRINT per sample. host-contention's fixed spin is marked after every
//      sample; a run whose spin slows past the bar is refused, not reported with a caveat.
//   4. A POSITIVE CONTROL. `u.surfReady` gates the whole splat block, so an interleaved third arm
//      with the splat off measures what ALL of the splat's fetches cost at this pose. That is the
//      instrument's sensitivity floor: the octave collapse removes part of that block, so a run
//      where the control does not move cannot resolve the collapse either, and says so instead of
//      reporting a number.
//
// Instruments: rAF-to-rAF delta median (wall) and Performance.getMetrics ThreadTime per frame
// (main-thread CPU). No per-pass GPU figure is read anywhere -- s0 INVALIDATED every one of them.
// The authoritative draw count rides alongside so a draw change can be told from a fill change.
//
// rAF is UNLOCKED with --disable-frame-rate-limit --disable-gpu-vsync, and the unlock is PROVEN: a
// median still sitting on the k*16.68 ms grid, or a sample distribution still concentrated there,
// fails this witness instead of being reported as a measurement.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { contentionWatch, contentionMark, contentionVerdict, formatContention } from './lib/host-contention.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)
const has = (n) => ARGS.has(n)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const RUN_ID = String(flag('run-id', 'r' + Date.now()))
const LABEL = String(flag('label', 'surface-splat-octave-ab-' + RUN_ID))
const ROUNDS = Number(flag('rounds', 8))
const SETTLE_MS = Number(flag('settle-ms', 1200))
const SAMPLE_MS = Number(flag('sample-ms', 4000))
const POSE_PROBE_MS = Number(flag('pose-probe-ms', 3000))
const GPU = String(flag('gpu', 'amd'))
const EXPECT_VENDOR = String(flag('expect-vendor', GPU))
const WORLD = String(flag('world', 'tps-game'))
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const BASE_KNOBS = String(flag('knob', 'dprOff=true,qualityGovernorOff=true'))
const LEASE_WAIT_MS = Number(flag('lease-wait-ms', 420000))
const REFRESH_MS = Number(flag('refresh-ms', 16.68))
const GRID_TOL_MS = 0.6
const GRID_FRAC_BAR = 0.70
// A pose is GPU-bound for this measurement when the frame wall clears main-thread CPU by this much:
// below it, a fragment fetch cut has no headroom to show up in, and the arm is worthless.
const GPU_BOUND_FACTOR = Number(flag('gpu-bound-factor', 1.35))
const MIN_DELTA_MS = Number(flag('min-delta-ms', 0.5))
// How far the same arm may move from the opening sample to the closing one before the run is read as
// measuring a world that never stopped loading.
const DRIFT_BAR_PCT = Number(flag('drift-bar-pct', 15))
const VEG_FLOOR = Number(flag('veg-floor', 1000))
const VEG_WAIT_MS = Number(flag('veg-wait-ms', 20000))
// The page keeps streaming after it is "ready" -- colliders, vegetation, heightfields -- so a run
// that starts measuring the moment it can present frames watches its own wall climb for the whole
// run (41.8 -> 77.0 ms observed, in EVERY arm), which is the same failure the parent row reported
// and the same one a sibling lane retracted. Nothing is measured until two consecutive probes agree.
const SETTLE_BUDGET_MS = Number(flag('settle-budget-ms', 420000))
const SETTLE_PROBE_MS = Number(flag('settle-probe-ms', 2000))
const SETTLE_MIN_SAMPLES = Number(flag('settle-min-samples', 20))
const SETTLE_WORST_FACTOR = Number(flag('settle-worst-factor', 1.8))
const SETTLE_TOL = Number(flag('settle-tol', 0.08))
const SETTLE_STABLE_PROBES = Number(flag('settle-stable-probes', 3))
const LIVE_TIMEOUT_MS = Number(flag('live-timeout-ms', 420000))
const PROBE_MS = 1500
const LIVE_FRAMES = 10
const CONTROL = !has('no-control')
const ARM_COLLAPSE = { name: 'collapse', collapse: 1, surf: 1 }
const ARM_REVERT = { name: 'revert', collapse: 0, surf: 1 }
const ARM_NOSPLAT = { name: 'nosplat', collapse: 1, surf: 0 }
const ARM_ORDER = CONTROL ? [ARM_COLLAPSE, ARM_REVERT, ARM_NOSPLAT] : [ARM_COLLAPSE, ARM_REVERT]

const KNOBS = BASE_KNOBS.split(',').filter(Boolean).map((p) => {
  const eq = p.indexOf('=')
  const key = (eq > 0 ? p.slice(0, eq) : p).trim()
  const raw = eq > 0 ? p.slice(eq + 1).trim() : ''
  const value = /^(true|false)$/.test(raw) ? raw === 'true' : Number(raw)
  return { key, value }
})

const INSTRUMENT = `(() => {
  const W = window
  if (W.__ab) return
  const rig = { frames: [], on: false, wgpuDraws: 0, wgpuOn: false, glDraws: 0, glOn: false, renderCalls: 0 }
  W.__ab = rig
  const DRAWF = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
  const PROTOS = ['GPUDevice', 'GPUQueue', 'GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder', 'GPUCanvasContext']
  for (let i = 0; i < PROTOS.length; i++) {
    const C = W[PROTOS[i]]
    if (!C || !C.prototype) continue
    const names = Object.getOwnPropertyNames(C.prototype)
    for (let j = 0; j < names.length; j++) {
      const k = names[j]
      if (k === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(C.prototype, k)
      if (!d || typeof d.value !== 'function') continue
      const orig = d.value
      Object.defineProperty(C.prototype, k, {
        value: function () {
          if (W.__ab && W.__ab.wgpuOn && DRAWF.has(k)) W.__ab.wgpuDraws++
          return orig.apply(this, arguments)
        },
        writable: true, configurable: true,
      })
    }
  }
  const GL_DRAW = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__abWrapped) {
      ctx.__abWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      for (const k of GL_DRAW) {
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () { if (W.__ab && W.__ab.glOn) W.__ab.glDraws++; return orig.apply(this, arguments) },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
  let last = -1
  function tick(now) {
    const dt = last < 0 ? 0 : now - last
    last = now
    if (rig.on && rig.frames.length < 400000) rig.frames.push(+dt.toFixed(3))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const knobApplySrc = (knobs) => `(() => {
  const W = window
  const want = ${JSON.stringify(knobs)}
  let registry = null
  const apply = () => {
    const applied = []
    for (const k of want) {
      const ok = registry.set(k.key, k.value)
      applied.push({ key: k.key, value: k.value, setReturned: ok })
    }
    W.__abKnobs = applied
  }
  Object.defineProperty(W, '__renderControls', {
    configurable: true,
    get: () => registry,
    set: (v) => { registry = v; if (registry && typeof registry.set === 'function') apply() },
  })
})()`

const RESET = () => { const r = window.__ab; r.frames.length = 0; r.wgpuDraws = 0; r.glDraws = 0; r.renderCalls = 0; r.wgpuOn = true; r.glOn = true; r.on = true; return true }
const STOP = () => { const r = window.__ab; r.on = false; r.wgpuOn = false; r.glOn = false; return { frames: r.frames.slice(), wgpuDraws: r.wgpuDraws, glDraws: r.glDraws, renderCalls: r.renderCalls } }

const SET_ARMS = (collapse, surf) => `(() => {
  const W = window
  const t = W.__terrain
  const p = t && t.planet
  const u = p && p.uniforms
  if (!u) return { ok: false, reason: 'window.__terrain.planet.uniforms is absent, so this page has no splat uniform to flip' }
  const sw = u.splatOctaveCollapse
  if (!sw) return { ok: false, reason: 'uniforms.splatOctaveCollapse is absent, so this page is not carrying the reproduction switch' }
  const sr = u.surfReady
  if (!sr) return { ok: false, reason: 'uniforms.surfReady is absent, so the splat control arm cannot be run' }
  sw.value = ${collapse}
  sr.value = ${surf}
  return { ok: true, collapse: sw.value, surfReady: sr.value }
})()`

const COUNTS = () => {
  const W = window
  const t = W.__terrain
  const p = t && t.planet
  const vegProfile = W.__vegProfile
  const app = W.__app
  const r = app && app.renderer
  const geo = p && p.mesh && p.mesh.geometry ? p.mesh.geometry : null
  const rc = W.__renderControls
  return {
    quads: geo ? geo.instanceCount : null,
    veg: vegProfile && typeof vegProfile.totalInstances === 'number' ? vegProfile.totalInstances : null,
    arm: p && p.uniforms && p.uniforms.splatOctaveCollapse ? p.uniforms.splatOctaveCollapse.value : null,
    surfReady: p && p.uniforms && p.uniforms.surfReady ? p.uniforms.surfReady.value : null,
    knobMaxLevel: rc && typeof rc.get === 'function' ? rc.get('maxLevel') : null,
    governor: W.__qualityGovernorState || null,
    canvas: r && r.domElement ? r.domElement.width + 'x' + r.domElement.height : null,
    rendererInfo: W.__rendererInfo || null,
  }
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2) }
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) }
const r2 = (x) => (x === null || x === undefined ? null : +Number(x).toFixed(2))

function offGridMs(v) {
  if (v === null || !Number.isFinite(v)) return null
  const k = Math.max(1, Math.round(v / REFRESH_MS))
  let best = Infinity
  for (const kk of [k - 1, k, k + 1]) {
    if (kk < 1) continue
    best = Math.min(best, Math.abs(v - kk * REFRESH_MS))
  }
  return +best.toFixed(2)
}
function gridFrac(samples) {
  if (!samples.length) return null
  let on = 0
  for (const v of samples) {
    const d = offGridMs(v)
    if (d !== null && d <= GRID_TOL_MS) on++
  }
  return +(on / samples.length).toFixed(3)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const { chromium } = await import(pathToFileURL(resolve(ROOT, 'scripts', 'lib', 'cdp-browser.mjs')).href)
  const { assertGpu, vendorGpuArgs } = await import(pathToFileURL(resolve(ROOT, 'scripts', 'lib', 'gpu-probe.mjs')).href)

  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log(`[${LABEL}] run=${RUN_ID} server up on ${port}`)

  const args = vendorGpuArgs(GPU)
  const UNLOCK = !has('lock-raf')
  if (UNLOCK) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync')
  args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion')
  const browser = await chromium.launch({ headless: true, args, owner: LABEL, root: ROOT, leaseWaitMs: LEASE_WAIT_MS })
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  await page._send('Page.bringToFront').catch(() => {})
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: knobApplySrc(KNOBS) })
  await page._send('Performance.enable').catch(() => {})

  const url = `http://localhost:${port}/?singleplayer&webgpu=1&world=${WORLD}&v=${Date.now()}`
  console.log(`[${LABEL}] navigating ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })

  let ready = false
  for (let i = 0; i < 400 && !ready; i++) {
    ready = await page.evaluate(`(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady) && !!(window.__terrain && window.__terrain.planet))()`).catch(() => false)
    if (!ready) await wait(500)
  }
  if (!ready) throw new Error(`[${LABEL}] world never became ready`)
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  const ri = await page.evaluate(`(() => { const r = window.__rendererInfo; return r ? { glRenderer: r.glRenderer || null, glVendor: r.glVendor || null, adapterVendor: r.adapter ? (r.adapter.vendor || r.adapter.description || null) : null } : null })()`).catch(() => null)
  if (!ri || !ri.glRenderer) throw new Error(`[${LABEL}] window.__rendererInfo carries no glRenderer, so this run cannot name the adapter it measured (an unresolvable --use-adapter-luid still reports accelerated)`)
  console.log(`[${LABEL}] gpu: ${JSON.stringify(gpu)}`)
  console.log(`[${LABEL}] rendererInfo: ${JSON.stringify(ri)}`)
  console.log(`[${LABEL}] knobs: ${JSON.stringify(await page.evaluate(`(() => window.__abKnobs || null)()`).catch(() => null))}`)

  // `u.surfReady` gates the WHOLE splat block and ships at 0 until the surface textures decode, so
  // it is read before this witness writes anything: a page where it never reached 1 is comparing two
  // dead arms, whatever the deltas say.
  let shippedSurface = null
  const shippedProbe = await page.evaluate(`(() => { const u = window.__terrain && window.__terrain.planet && window.__terrain.planet.uniforms; return u ? { surfReady: u.surfReady ? u.surfReady.value : null, hasAlb: !!(u.surfAlb && u.surfAlb.value), hasNrm: !!(u.surfNrm && u.surfNrm.value) } : null })()`).catch(() => null)
  shippedSurface = shippedProbe
  console.log(`[${LABEL}] shipped surface state (read before any override): ${JSON.stringify(shippedProbe)}`)

  const armProbe = await page.evaluate(SET_ARMS(ARM_COLLAPSE.collapse, ARM_COLLAPSE.surf)).catch((e) => ({ ok: false, reason: e.message }))
  if (!armProbe.ok) throw new Error(`[${LABEL}] the reproduction switch is not reachable on this page: ${armProbe.reason}`)
  console.log(`[${LABEL}] switch reachable: ${JSON.stringify(armProbe)}`)

  async function liveProbe() {
    await page.evaluate(RESET).catch(() => null)
    await wait(PROBE_MS)
    const seen = await page.evaluate(`(() => { const r = window.__ab; r.on = false; r.wgpuOn = false; r.glOn = false; return { frames: r.frames.filter((d) => d > 0).length, renderCalls: r.renderCalls, wgpu: r.wgpuDraws, gl: r.glDraws } })()`).catch(() => null)
    const c = await page.evaluate(COUNTS).catch(() => ({}))
    return { frames: (seen && seen.frames) || 0, renderCalls: (seen && seen.renderCalls) || 0, quads: c.quads || 0, veg: c.veg || 0 }
  }
  let live = null
  let vegMet = false
  const tLive = Date.now()
  while (Date.now() - tLive < LIVE_TIMEOUT_MS) {
    live = await liveProbe()
    console.log(`[${LABEL}] liveness probe after ${((Date.now() - tLive) / 1000).toFixed(0)}s: ${JSON.stringify(live)}`)
    if (live.frames >= LIVE_FRAMES && live.quads > 0 && live.veg >= VEG_FLOOR) { vegMet = true; break }
    if (live.frames >= LIVE_FRAMES && live.quads > 0 && Date.now() - tLive > VEG_WAIT_MS) break
    await wait(2000)
  }
  if (!live || live.frames < LIVE_FRAMES) throw new Error(`[${LABEL}] the page presented ${live ? live.frames : 0} frame(s) in a ${PROBE_MS}ms probe, under the ${LIVE_FRAMES} a frame series needs, so rAF is not firing and no arm can be measured`)
  if (!(live.quads > 0)) throw new Error(`[${LABEL}] the terrain mesh carries ${live.quads} quad(s), so the render loop never filled the quad buffer`)
  if (!vegMet) console.log(`[${LABEL}] NOTE: vegetation stands at ${live.veg} instance(s), under the ${VEG_FLOOR} floor -- a half-built world is main-thread work, not a settled pose`)

  const metrics = async () => {
    const m = await page._send('Performance.getMetrics').catch(() => ({ metrics: [] }))
    const by = {}
    for (const e of m.metrics || []) by[e.name] = e.value
    return by
  }

  async function sampleOnce(arm, ms) {
    const set = await page.evaluate(SET_ARMS(arm.collapse, arm.surf)).catch((e) => ({ ok: false, reason: e.message }))
    await wait(SETTLE_MS)
    await page.evaluate(RESET).catch(() => null)
    const m0 = await metrics()
    const t0 = Date.now()
    await wait(ms)
    const m1 = await metrics()
    const wall = Date.now() - t0
    const acc = await page.evaluate(STOP).catch(() => null)
    const c = await page.evaluate(COUNTS).catch(() => ({}))
    const frames = ((acc && acc.frames) || []).filter((d) => d > 0)
    const n = frames.length
    const drawsField = acc && acc.wgpuDraws > 0 ? 'wgpuDrawsPerFrame' : (acc && acc.glDraws > 0 ? 'glDrawCallsPerFrame' : null)
    const drawsPerFrame = drawsField === 'wgpuDrawsPerFrame' ? r2(acc.wgpuDraws / n) : (drawsField === 'glDrawCallsPerFrame' ? r2(acc.glDraws / n) : 0)
    return {
      arm: arm.name,
      armCollapse: arm.collapse,
      armSurf: arm.surf,
      setOk: set && set.ok === true,
      armReadback: c.arm,
      surfReadback: c.surfReady,
      frames: n,
      wallP50Ms: median(frames),
      wallP95Ms: pct(frames, 0.95),
      wallMinMs: n ? +Math.min(...frames).toFixed(2) : null,
      offGridMs: offGridMs(median(frames)),
      vsyncGridFrac: gridFrac(frames),
      fps: n && wall ? +(n / (wall / 1000)).toFixed(2) : null,
      threadMsPerFrame: m0 && m1 && m1.ThreadTime != null && n ? +(((m1.ThreadTime - m0.ThreadTime) * 1000) / n).toFixed(3) : null,
      authoritativeField: drawsField,
      drawsPerFrame,
      renderCallsPerFrame: acc && n ? +(acc.renderCalls / n).toFixed(2) : null,
      quads: c.quads, veg: c.veg, canvas: c.canvas,
      governor: c.governor, knobMaxLevel: c.knobMaxLevel,
    }
  }

  // ---- SETTLE: the page has to stop changing before any arm is measured ----------------------
  async function probeOnce(ms) {
    await page.evaluate(RESET).catch(() => null)
    await wait(ms)
    const acc = await page.evaluate(STOP).catch(() => null)
    const frames = ((acc && acc.frames) || []).filter((d) => d > 0)
    return { n: frames.length, p50: median(frames), worst: frames.length ? +Math.max(...frames).toFixed(2) : null }
  }
  async function settleAtPose() {
    const t0 = Date.now()
    let prev = null
    let stable = 0
    let last = null
    let probes = 0
    while (Date.now() - t0 < SETTLE_BUDGET_MS) {
      const p = await probeOnce(SETTLE_PROBE_MS)
      probes++
      last = p
      const shaped = p.n >= SETTLE_MIN_SAMPLES && p.worst !== null && p.p50 !== null && p.worst <= p.p50 * SETTLE_WORST_FACTOR
      const steady = prev !== null && p.p50 !== null && Math.abs(p.p50 - prev) <= prev * SETTLE_TOL
      stable = shaped && steady ? stable + 1 : 0
      console.log(`[${LABEL}] settle probe ${probes} after ${((Date.now() - t0) / 1000).toFixed(0)}s: p50=${p.p50}ms worst=${p.worst}ms over ${p.n} frame(s) (prev ${prev === null ? 'none' : prev + 'ms'}) stable ${stable}/${SETTLE_STABLE_PROBES}`)
      prev = p.p50
      if (stable >= SETTLE_STABLE_PROBES) return { settled: true, probes, waitedMs: Date.now() - t0, ...p }
      await wait(400)
    }
    return { settled: false, probes, waitedMs: Date.now() - t0, ...(last || {}) }
  }
  const settle = await settleAtPose()
  console.log(`[${LABEL}] settle: ${JSON.stringify(settle)}`)
  if (!settle.settled) failures.push(`the page never settled inside the ${(SETTLE_BUDGET_MS / 1000).toFixed(0)}s budget (${settle.probes} probe(s), last p50 ${settle.p50}ms, worst ${settle.worst}ms over ${settle.n} frame(s)), so the world was still streaming while every arm below was measured and the run's wall drift is the load, not an arm`)

  // ---- POSE PROOF: measure the pose before trusting it ----------------------------------------
  const pose = await sampleOnce(ARM_COLLAPSE, POSE_PROBE_MS)
  console.log(`[${LABEL}] pose proof: ${JSON.stringify(pose)}`)
  const poseRatio = pose.wallP50Ms && pose.threadMsPerFrame ? +(pose.wallP50Ms / pose.threadMsPerFrame).toFixed(2) : null
  console.log(`[${LABEL}] pose proof: wall ${pose.wallP50Ms}ms vs main thread ${pose.threadMsPerFrame}ms per frame (ratio ${poseRatio}, bar ${GPU_BOUND_FACTOR})`)

  const failures = []
  if (!shippedSurface || shippedSurface.surfReady !== 1) failures.push(`the page ships surfReady=${shippedSurface ? shippedSurface.surfReady : 'unreadable'} (alb ${shippedSurface ? shippedSurface.hasAlb : '?'}, nrm ${shippedSurface ? shippedSurface.hasNrm : '?'}), so the splat block this A/B flips never became live in the shipped page and the pair was comparing two arms the shader never entered`)
  if (pose.threadMsPerFrame === null) failures.push(`Performance.getMetrics carried no ThreadTime, so the main-thread instrument never ran and this run cannot say which side bound the frame`)
  if (poseRatio !== null && !(poseRatio >= GPU_BOUND_FACTOR)) failures.push(`the pose is NOT GPU-bound: wall ${pose.wallP50Ms}ms against ${pose.threadMsPerFrame}ms of main-thread CPU is only x${poseRatio}, under the x${GPU_BOUND_FACTOR} bar, so a fragment fetch cut has no headroom to appear in and this arm measures the wrong pose`)

  // ---- the matched, interleaved pair ----------------------------------------------------------
  const watch = contentionWatch()
  const rows = []
  for (let r = 0; r < ROUNDS; r++) {
    // The arms rotate one position per round, so across the run each arm has sat in every slot: a
    // box drifting slowly cannot line up with an arm.
    const order = ARM_ORDER.map((_, i) => ARM_ORDER[(i + r) % ARM_ORDER.length])
    for (const arm of order) {
      const row = await sampleOnce(arm, SAMPLE_MS)
      row.round = r
      row.spinMs = contentionMark(watch)
      rows.push(row)
      console.log(`[${LABEL}] round ${r} ${row.arm}: wall=${row.wallP50Ms}ms thread=${row.threadMsPerFrame}ms draws=${row.drawsPerFrame} frames=${row.frames} offGrid=${row.offGridMs} gridFrac=${row.vsyncGridFrac} spin=${row.spinMs}ms`)
    }
  }
  const contention = contentionVerdict(watch)
  console.log(`[${LABEL}] ${formatContention(contention)}`)

  // A closing probe at the same arm the run opened on: if the wall moved across the run, the arms
  // were measured on a world that kept loading, whatever the paired estimator says.
  const closing = await sampleOnce(ARM_COLLAPSE, SETTLE_PROBE_MS)
  const openingP50 = rows.length ? rows[0].wallP50Ms : null
  const runDrift = openingP50 && closing.wallP50Ms ? +Math.abs(closing.wallP50Ms - openingP50).toFixed(2) : null
  const runDriftPct = openingP50 && runDrift !== null ? +(100 * runDrift / openingP50).toFixed(1) : null
  console.log(`[${LABEL}] closing probe: opening ${openingP50}ms -> closing ${closing.wallP50Ms}ms on the same arm, drift ${runDrift}ms (${runDriftPct}%)`)
  if (runDriftPct !== null && runDriftPct > DRIFT_BAR_PCT) failures.push(`the same arm read ${openingP50}ms at the start of the run and ${closing.wallP50Ms}ms at the end (${runDriftPct}% drift, bar ${DRIFT_BAR_PCT}%), so the arms were measured on a world that kept loading and the run's spread is the load, not an arm`)

  const info = await page.evaluate(COUNTS).catch(() => null)
  const out = {
    label: LABEL, runId: RUN_ID, ts: new Date().toISOString(), gpu: GPU, world: WORLD, viewport: VIEW_W + 'x' + VIEW_H,
    unlockRaf: UNLOCK, refreshMs: REFRESH_MS, knobs: BASE_KNOBS, gpuProbe: gpu, rendererInfo: ri,
    settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, rounds: ROUNDS, gpuBoundFactor: GPU_BOUND_FACTOR,
    settle, shippedSurface, pose, poseRatio, closing, runDriftMs: runDrift, runDriftPct, contention, rows, final: info,
  }
  writeFileSync(resolve(OUT_DIR, LABEL + '.json'), JSON.stringify(out, null, 1))
  console.log(`[${LABEL}] wrote ${resolve(OUT_DIR, LABEL + '.json')}`)

  // ---- instrument admissibility ---------------------------------------------------------------
  if (!UNLOCK) failures.push('rAF was launched vsync-locked (--lock-raf), so every median carries the refresh divisor')
  for (const row of rows) {
    if (!row.setOk) failures.push(`round ${row.round} ${row.arm}: the reproduction switch did not take, so this sample is not the arm it is labelled`)
    if (row.armReadback !== row.armCollapse) failures.push(`round ${row.round} ${row.arm}: the switch read back ${row.armReadback}, not ${row.armCollapse}, so the page was on another arm while it was sampled`)
    if (row.surfReadback !== row.armSurf) failures.push(`round ${row.round} ${row.arm}: surfReady read back ${row.surfReadback}, not ${row.armSurf}, so the arm was not the one it is labelled`)
    if (!(row.frames >= 20)) failures.push(`round ${row.round} ${row.arm}: only ${row.frames} frame(s) sampled, under the 20 a median needs`)
    if (row.threadMsPerFrame === null) failures.push(`round ${row.round} ${row.arm}: no ThreadTime, so the main-thread instrument never ran`)
    if (!row.authoritativeField) failures.push(`round ${row.round} ${row.arm}: no API-boundary draw counter moved, so the draw count is an unmeasured zero`)
  }
  const fracs = rows.map((r) => r.vsyncGridFrac).filter((v) => Number.isFinite(v))
  const medianFrac = fracs.length ? +fracs.slice().sort((a, b) => a - b)[Math.floor(fracs.length / 2)].toFixed(3) : null
  const offGridMedians = rows.filter((r) => r.offGridMs > GRID_TOL_MS).length
  console.log(`[${LABEL}] unlock proof: refresh ${REFRESH_MS}ms, tol +/-${GRID_TOL_MS}ms -- median on-grid share ${medianFrac} (bar <= ${GRID_FRAC_BAR}), ${offGridMedians}/${rows.length} sample median(s) off the grid`)
  console.log(`[${LABEL}] unlock proof: medians ${rows.map((r) => r.wallP50Ms).join(', ')}ms`)
  if (medianFrac !== null && medianFrac > GRID_FRAC_BAR) failures.push(`the median share of samples on the k*${REFRESH_MS}ms vsync grid is ${medianFrac}, over the ${GRID_FRAC_BAR} bar -- rAF did not unlock, so these medians carry the refresh divisor`)
  if (offGridMedians < Math.ceil(rows.length * 0.75)) failures.push(`only ${offGridMedians} of ${rows.length} sample median(s) sit off the vsync grid, so rAF did not unlock for this run`)
  if (contention.contested) failures.push(`${formatContention(contention)} -- this run shared the box, so its wall figures must not be quoted`)

  // ---- the paired delta, with the spread ------------------------------------------------------
  const medOf = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const series = (arm, key) => rows.filter((r) => r.arm === arm && r[key] !== null && r[key] !== undefined).map((r) => r[key])
  const medAt = (arm, key) => medOf(series(arm, key))
  const spreadAt = (arm, key) => { const m = medAt(arm, key); return m === null ? null : +medOf(series(arm, key).map((v) => Math.abs(v - m))).toFixed(3) }
  // The paired estimator. The two arms of a round are seconds apart, so the drift the run as a whole
  // suffers cancels inside a pair; the median of those per-round differences is the delta, and their
  // own disagreement is the noise floor it has to beat.
  const pairedAt = (aArm, bArm, key) => {
    const out = []
    for (let r = 0; r < ROUNDS; r++) {
      const a = rows.find((x) => x.round === r && x.arm === aArm)
      const b = rows.find((x) => x.round === r && x.arm === bArm)
      if (!a || !b || a[key] === null || b[key] === null || a[key] === undefined || b[key] === undefined) continue
      out.push(+(a[key] - b[key]).toFixed(3))
    }
    return out
  }
  const pairedMed = (aArm, bArm, key) => medOf(pairedAt(aArm, bArm, key))
  const pairedSpread = (aArm, bArm, key) => { const m = pairedMed(aArm, bArm, key); return m === null ? null : +medOf(pairedAt(aArm, bArm, key).map((v) => Math.abs(v - m))).toFixed(3) }
  const nCollapse = series('collapse', 'wallP50Ms').length
  const nRevert = series('revert', 'wallP50Ms').length
  const nNosplat = series('nosplat', 'wallP50Ms').length
  if (nCollapse < 2 || nRevert < 2) failures.push(`only ${nCollapse} collapse and ${nRevert} revert sample(s) carried a wall median, so there is no pair to compare`)
  if (CONTROL && nNosplat < 2) failures.push(`only ${nNosplat} control sample(s) carried a wall median, so the run has no sensitivity floor`)

  const wallCollapse = medAt('collapse', 'wallP50Ms')
  const wallRevert = medAt('revert', 'wallP50Ms')
  const wallNosplat = CONTROL ? medAt('nosplat', 'wallP50Ms') : null
  const threadCollapse = medAt('collapse', 'threadMsPerFrame')
  const threadRevert = medAt('revert', 'threadMsPerFrame')
  const drawsCollapse = medAt('collapse', 'drawsPerFrame')
  const drawsRevert = medAt('revert', 'drawsPerFrame')
  const wallSpreadCollapse = spreadAt('collapse', 'wallP50Ms')
  const wallSpreadRevert = spreadAt('revert', 'wallP50Ms')
  const threadSpreadCollapse = spreadAt('collapse', 'threadMsPerFrame')
  const threadSpreadRevert = spreadAt('revert', 'threadMsPerFrame')
  const wallSpread = Math.max(wallSpreadCollapse || 0, wallSpreadRevert || 0)
  const threadSpread = Math.max(threadSpreadCollapse || 0, threadSpreadRevert || 0)
  const wallBar = +Math.max(MIN_DELTA_MS, 2 * wallSpread).toFixed(2)
  const threadBar = +Math.max(MIN_DELTA_MS, 2 * threadSpread).toFixed(2)
  const wallDelta = wallRevert !== null && wallCollapse !== null ? +(wallRevert - wallCollapse).toFixed(2) : null
  const threadDelta = threadRevert !== null && threadCollapse !== null ? +(threadRevert - threadCollapse).toFixed(2) : null
  const wallResolved = wallDelta !== null && wallDelta > wallBar

  // Paired, drift-cancelled: the headline number.
  const pairDelta = pairedMed('revert', 'collapse', 'wallP50Ms')
  const pairSpread = pairedSpread('revert', 'collapse', 'wallP50Ms')
  const pairBar = +Math.max(MIN_DELTA_MS, 2 * (pairSpread || 0)).toFixed(2)
  const pairResolved = pairDelta !== null && pairDelta > pairBar
  const pairN = pairedAt('revert', 'collapse', 'wallP50Ms').length
  // The control: what ALL of the splat's fetches cost at this pose. A run where the whole block does
  // not move has no instrument for a part of it.
  const controlDelta = CONTROL ? pairedMed('revert', 'nosplat', 'wallP50Ms') : null
  const controlSpread = CONTROL ? pairedSpread('revert', 'nosplat', 'wallP50Ms') : null
  const controlBar = CONTROL ? +Math.max(MIN_DELTA_MS, 2 * (controlSpread || 0)).toFixed(2) : null
  const controlMoved = CONTROL ? controlDelta !== null && controlDelta > controlBar : null
  const threadResolved = threadDelta !== null && Math.abs(threadDelta) > threadBar

  console.log(`[${LABEL}] wall   revert ${wallRevert}ms (spread ${wallSpreadRevert}, series ${JSON.stringify(series('revert', 'wallP50Ms'))}) -> collapse ${wallCollapse}ms (spread ${wallSpreadCollapse}, series ${JSON.stringify(series('collapse', 'wallP50Ms'))}): median delta ${wallDelta}ms against a ${wallBar}ms bar`)
  console.log(`[${LABEL}] PAIRED revert - collapse per round ${JSON.stringify(pairedAt('revert', 'collapse', 'wallP50Ms'))}ms over ${pairN} pair(s): median ${pairDelta}ms, spread ${pairSpread}ms, bar ${pairBar}ms -> ${pairResolved ? 'RESOLVED' : 'NOT RESOLVABLE'}`)
  if (CONTROL) console.log(`[${LABEL}] CONTROL revert - nosplat per round ${JSON.stringify(pairedAt('revert', 'nosplat', 'wallP50Ms'))}ms: median ${controlDelta}ms, spread ${controlSpread}ms, bar ${controlBar}ms -> the whole splat block ${controlMoved ? 'IS visible to this instrument' : 'is NOT visible to this instrument at this pose'}`)
  console.log(`[${LABEL}] thread revert ${threadRevert}ms (spread ${threadSpreadRevert}, series ${JSON.stringify(series('revert', 'threadMsPerFrame'))}) -> collapse ${threadCollapse}ms (spread ${threadSpreadCollapse}, series ${JSON.stringify(series('collapse', 'threadMsPerFrame'))}): delta ${threadDelta}ms against a ${threadBar}ms bar`)
  console.log(`[${LABEL}] authoritative draws (${rows.find((r) => r.authoritativeField) ? rows.find((r) => r.authoritativeField).authoritativeField : 'none'}): revert ${drawsRevert} -> collapse ${drawsCollapse} per frame`)
  console.log(`[${LABEL}] verdict: paired wall delta ${pairResolved ? 'RESOLVED' : 'NOT RESOLVABLE'} at this pose; thread delta ${threadResolved ? 'moved' : 'did not move'} (a fragment fetch cut must not move main-thread CPU, so a moving thread is a warning, not a win)`)
  if (CONTROL && !controlMoved) console.log(`[${LABEL}] verdict: the control arm moved only ${controlDelta}ms against a ${controlBar}ms bar, so this pose cannot see the splat block at all and the collapse delta is unmeasurable HERE rather than absent`)

  console.log(`[${LABEL}] MEASURED surface-splat-octave-ab: ` + JSON.stringify({
    runId: RUN_ID, world: WORLD, viewport: VIEW_W + 'x' + VIEW_H, gpu: GPU, rasterizer: gpu.rasterizer, renderer: ri.glRenderer,
    unlockRaf: UNLOCK, medianVsyncGridFrac: medianFrac, offGridSamples: offGridMedians + '/' + rows.length,
    pose: { wallP50Ms: pose.wallP50Ms, threadMsPerFrame: pose.threadMsPerFrame, ratio: poseRatio, bar: GPU_BOUND_FACTOR, vegInstances: pose.veg, quads: pose.quads },
    settle: { settled: settle.settled, probes: settle.probes, waitedMs: settle.waitedMs, p50Ms: settle.p50Ms ?? settle.p50 },
    drift: { openingP50Ms: openingP50, closingP50Ms: closing.wallP50Ms, driftMs: runDrift, driftPct: runDriftPct },
    contention: { beforeMs: contention.beforeMs, afterMs: contention.afterMs, peakMs: contention.peakMs, bestMs: contention.bestMs, slowdown: contention.slowdown, contested: contention.contested },
    rounds: ROUNDS, samplesPerArm: { collapse: nCollapse, revert: nRevert, nosplat: nNosplat },
    wall: { revertMs: wallRevert, collapseMs: wallCollapse, deltaMs: wallDelta, spreadMs: wallSpread, barMs: wallBar, resolved: wallResolved,
      revertSeries: series('revert', 'wallP50Ms'), collapseSeries: series('collapse', 'wallP50Ms') },
    paired: { deltaMs: pairDelta, spreadMs: pairSpread, barMs: pairBar, resolved: pairResolved, pairs: pairN,
      series: pairedAt('revert', 'collapse', 'wallP50Ms') },
    control: CONTROL ? { splatOffDeltaMs: controlDelta, spreadMs: controlSpread, barMs: controlBar, moved: controlMoved, nosplatMs: wallNosplat,
      series: pairedAt('revert', 'nosplat', 'wallP50Ms') } : null,
    thread: { revertMs: threadRevert, collapseMs: threadCollapse, deltaMs: threadDelta, spreadMs: threadSpread, barMs: threadBar, moved: threadResolved,
      revertSeries: series('revert', 'threadMsPerFrame'), collapseSeries: series('collapse', 'threadMsPerFrame') },
    draws: { revert: drawsRevert, collapse: drawsCollapse, authoritativeField: (rows.find((r) => r.authoritativeField) || {}).authoritativeField || null },
  }))

  try { await server.stop() } catch (_) {}
  await wait(1500)
  if (failures.length) {
    console.error(`[${LABEL}] RESULT: FAIL -- ` + failures.join('; '))
    process.exit(1)
  }
  console.log(`[${LABEL}] RESULT: PASS run=${RUN_ID} label=${LABEL} world=${WORLD} viewport=${VIEW_W}x${VIEW_H} gpu=${GPU} renderer=${ri.glRenderer} unlockRaf=${UNLOCK} medianVsyncGridFrac=${medianFrac} poseRatio=${poseRatio} contested=${contention.contested} rounds=${ROUNDS} pairedDeltaMs=${pairDelta} pairedBarMs=${pairBar} pairedResolved=${pairResolved} controlDeltaMs=${controlDelta} controlBarMs=${controlBar} controlMoved=${controlMoved} armMedianDeltaMs=${wallDelta} wallBarMs=${wallBar} threadDeltaMs=${threadDelta} authoritative=${(rows.find((r) => r.authoritativeField) || {}).authoritativeField || 'none'}`)
  process.exit(0)
}

main().catch(async (e) => { console.error(`[${LABEL}] FAILED: ${e && e.stack || e}`); process.exit(1) })
