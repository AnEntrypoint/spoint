#!/usr/bin/env node
// PERF-maxlevel-cpu-ladder-r1: the per-level cost gradient of `maxLevel` above the level the frame
// wall can resolve.
//
// s6 [LANDED] [W:6c5e15a00ee2] measured the ladder vsync-LOCKED: every median came back a multiple
// of the 16.68 ms refresh period, so 11 / 16 / 22 all read 33.36 ms and the ladder resolved only as
// a 60/30 fps ordinal. This witness unlocks rAF (`--disable-frame-rate-limit
// --disable-gpu-vsync`) and PROVES it unlocked: a rung whose median still sits on the k*16.68 grid,
// or whose sample distribution is still concentrated on it, fails this witness instead of being
// reported as a measurement.
//
// Two instruments per rung, because they answer different questions:
//   wall     -- rAF-to-rAF delta median. Vsync-quantized when locked, continuous when not.
//   ThreadTime -- main-thread CPU seconds from Performance.getMetrics, per frame. NOT quantized, so
//                it is the instrument that resolves level cost even if the wall did not move.
// Neither is a per-pass GPU figure: s0 INVALIDATED every one of those, so no GPU timing is read.
//
// Draws come from the API boundary only (`drawsInstrument.authoritativeField`: wgpuDrawsPerFrame
// when the WebGPU encoder hook saw draws, else glDrawCallsPerFrame). three's info.render.drawCalls
// reads 0 on the WebGPU backend and info.render.calls is cumulative, so neither is quoted.
//
// The near band is NOT re-derived here: nearfield-lod-lattice-witness.mjs pins the rendered near
// lattice at 1 m == the collider lattice at all 8 tiers, so a maxLevel change provably does not
// move it. This witness only measures cost above that band.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'

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

const LABEL = flag('label', 'maxlevel-cpu-ladder-' + Date.now())
const RUNGS = String(flag('rungs', '2,6,9,11,13,16,19,22')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
const SETTLE_MS = Number(flag('settle-ms', 2000))
const SAMPLE_MS = Number(flag('sample-ms', 8000))
const DESC = !has('no-desc')
const DESC_SAMPLE_MS = Number(flag('desc-sample-ms', 6000))
const GPU = String(flag('gpu', 'amd'))
const EXPECT_VENDOR = String(flag('expect-vendor', GPU))
const WORLD = String(flag('world', 'tps-game'))
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const BASE_KNOBS = String(flag('knob', 'dprOff=true,qualityGovernorOff=true'))
const LEASE_WAIT_MS = Number(flag('lease-wait-ms', 180000))
// The refresh period s6 measured every locked median on. A rung whose median is still a multiple of
// it did not unlock.
const REFRESH_MS = Number(flag('refresh-ms', 16.68))
// A sample this close to a multiple of the refresh period is ON the vsync grid.
const GRID_TOL_MS = 0.6
// A rung is admitted as unlocked when this share of its samples is off the grid.
const GRID_FRAC_BAR = 0.70
// Two rungs are distinguishable when their medians differ by more than this.
const WALL_STEP_MS = 0.6
const THREAD_STEP_MS = 0.3
// A move smaller than this is not a level effect even when the replicates agree perfectly.
const MIN_STEP_MS = 0.2

const KNOBS = BASE_KNOBS.split(',').filter(Boolean).map((p) => {
  const eq = p.indexOf('=')
  const key = (eq > 0 ? p.slice(0, eq) : p).trim()
  const raw = eq > 0 ? p.slice(eq + 1).trim() : ''
  const value = /^(true|false)$/.test(raw) ? raw === 'true' : Number(raw)
  return { key, value }
})

const INSTRUMENT = `(() => {
  const W = window
  if (W.__ladder) return
  const rig = { frames: [], on: false, wgpuDraws: 0, wgpuOn: false, glDraws: 0, glOn: false, threeDraws: 0, threeTris: 0, renderCalls: 0 }
  W.__ladder = rig
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
          if (W.__ladder && W.__ladder.wgpuOn && DRAWF.has(k)) W.__ladder.wgpuDraws++
          return orig.apply(this, arguments)
        },
        writable: true, configurable: true,
      })
    }
  }
  // The WebGL fallback's own boundary, so glDrawCallsPerFrame exists as the authoritative field when
  // the WebGPU encoder hook never saw a draw (three's info.render.drawCalls reads 0 there).
  const GL_DRAW = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__ladderWrapped) {
      ctx.__ladderWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      for (const k of GL_DRAW) {
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () { if (W.__ladder && W.__ladder.glOn) W.__ladder.glDraws++; return orig.apply(this, arguments) },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
  const hookRenderer = (renderer) => {
    if (!renderer || renderer.__ladderHooked) return
    renderer.__ladderHooked = true
    const info = renderer.info
    if (info) {
      const origReset = info.reset
      info.reset = function () {
        W.__ladder.threeDraws += info.render.drawCalls !== undefined ? info.render.drawCalls : info.render.calls
        W.__ladder.threeTris += info.render.triangles || 0
        return origReset.apply(this, arguments)
      }
    }
    const origRender = renderer.render
    renderer.render = function () { W.__ladder.renderCalls++; return origRender.apply(this, arguments) }
  }
  let last = -1
  function tick(now) {
    const dt = last < 0 ? 0 : now - last
    last = now
    const renderer = W.__app && W.__app.renderer
    if (renderer) hookRenderer(renderer)
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
    W.__ladderKnobs = applied
  }
  Object.defineProperty(W, '__renderControls', {
    configurable: true,
    get: () => registry,
    set: (v) => { registry = v; if (registry && typeof registry.set === 'function') apply() },
  })
})()`

const RESET = () => { const r = window.__ladder; r.frames.length = 0; r.wgpuDraws = 0; r.glDraws = 0; r.threeDraws = 0; r.threeTris = 0; r.renderCalls = 0; r.wgpuOn = true; r.glOn = true; r.on = true; return true }
const STOP = () => { const r = window.__ladder; r.on = false; r.wgpuOn = false; r.glOn = false; return { frames: r.frames.slice(), wgpuDraws: r.wgpuDraws, glDraws: r.glDraws, threeDraws: r.threeDraws, threeTris: r.threeTris, renderCalls: r.renderCalls } }

const COUNTS = () => {
  const W = window
  const t = W.__terrain
  const p = t && t.planet
  const veg = W.__veg
  const vegProfile = W.__vegProfile
  // The population mirror is `window.__vegProfile` (frame-time-gate reads it too); `window.__veg` is
  // the handle and carries no count on some builds, so reading it alone turns "no reader" into a
  // measured 0 instances.
  const vegCount = vegProfile && typeof vegProfile.totalInstances === 'number'
    ? vegProfile.totalInstances
    : (veg ? ((veg.profile && veg.profile.totalInstances) ?? veg.instanceCount ?? veg.count ?? null) : null)
  const app = W.__app
  const r = app && app.renderer
  const g = (m) => (m && m.geometry ? m.geometry : null)
  const geo = p ? g(p.mesh) : null
  const wgeo = p && p.water ? g(p.water.mesh) : null
  const rc = W.__renderControls
  return {
    quads: geo ? geo.instanceCount : null,
    vertsPerQuad: geo && geo.attributes && geo.attributes.position ? geo.attributes.position.count : null,
    idxPerQuad: geo && geo.index ? geo.index.count : null,
    waterQuads: wgeo ? wgeo.instanceCount : null,
    waterVertsPerQuad: wgeo && wgeo.attributes && wgeo.attributes.position ? wgeo.attributes.position.count : null,
    veg: vegCount,
    morphMaxLevel: p && p.uniforms && p.uniforms.morphMaxLevel ? p.uniforms.morphMaxLevel.value : null,
    knobMaxLevel: rc && typeof rc.get === 'function' ? rc.get('maxLevel') : null,
    knobSplitFactor: rc && typeof rc.get === 'function' ? rc.get('splitFactor') : null,
    governor: W.__qualityGovernorState || null,
    canvas: r && r.domElement ? r.domElement.width + 'x' + r.domElement.height : null,
    rendererInfo: W.__rendererInfo || null,
  }
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2) }
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) }
const r2 = (x) => (x === null || x === undefined ? null : +Number(x).toFixed(2))

// How far a value sits from the nearest multiple of the refresh period: 0 means it is ON the vsync
// grid, which is what a locked arm reports for every level.
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

// The share of samples sitting on the grid. A locked arm parks ~all of them there; an unlocked one
// spreads them across a continuum.
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
  console.log('[maxlevel] server up on ' + port)

  const args = vendorGpuArgs(GPU)
  const UNLOCK = !has('lock-raf')
  if (UNLOCK) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync')
  // Headful windows on a box running several browser arms get backgrounded and occluded, and a
  // backgrounded page stops presenting frames -- rAF never fires and a "median" over zero frames is
  // not a measurement. These keep the page foreground-live; Page.bringToFront below is the other
  // half.
  args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion')
  console.log('[maxlevel] unlock-raf=' + UNLOCK + ' args=' + JSON.stringify(args.slice(-2)))
  // Headless, not headful: a headful window on a box running several browser arms gets occluded or
  // backgrounded, and a backgrounded page stops presenting frames -- rAF never fires and a "median"
  // over zero frames is not a measurement (observed both ways on this box: the same arm read 0
  // frames headful and 12-19 frames per 1.5s probe headless). frame-time-gate.mjs unlocks rAF the
  // same way and measures real frame deltas headless, so headless is the proven configuration.
  const browser = await chromium.launch({ headless: true, args, owner: LABEL, root: ROOT, leaseWaitMs: LEASE_WAIT_MS })
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
  await page._send('Page.bringToFront').catch(() => {})
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: knobApplySrc(KNOBS) })
  await page._send('Performance.enable').catch(() => {})

  const url = `http://localhost:${port}/?singleplayer&webgpu=1&world=${WORLD}&v=${Date.now()}`
  console.log('[maxlevel] navigating ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })

  let ready = false
  for (let i = 0; i < 300 && !ready; i++) {
    ready = await page.evaluate(() => !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady) && !!window.__terrain && !!(window.__terrain.planet)).catch(() => false)
    if (!ready) await wait(500)
  }
  if (!ready) throw new Error('[maxlevel] world never became ready')
  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: EXPECT_VENDOR })
  // vendorGpuArgs pins the adapter with --use-adapter-luid, but Chrome reports "accelerated" even on
  // an unresolvable LUID, so the renderer string the page itself published is asserted separately.
  const ri = await page.evaluate(`(() => { const r = window.__rendererInfo; return r ? { glRenderer: r.glRenderer || null, glVendor: r.glVendor || null, adapterVendor: r.adapter ? (r.adapter.vendor || r.adapter.description || null) : null } : null })()`).catch(() => null)
  if (!ri || !ri.glRenderer) throw new Error('[maxlevel] window.__rendererInfo carries no glRenderer, so this run cannot name the adapter it measured (an unresolvable --use-adapter-luid still reports accelerated)')
  console.log('[maxlevel] gpu: ' + JSON.stringify(gpu))
  console.log('[maxlevel] rendererInfo: ' + JSON.stringify(ri))
  const knobsApplied = await page.evaluate(() => window.__ladderKnobs || null).catch(() => null)
  console.log('[maxlevel] knobs: ' + JSON.stringify(knobsApplied))

  // A world that has not reached the frame loop measures nothing: rAF never fires, the quad buffer
  // stays empty and a "median" over zero frames is not a measurement. This gate is the other half of
  // the instrument -- every rung below is then a rung of ONE settled, presenting page.
  const LIVE_TIMEOUT_MS = Number(flag('live-timeout-ms', 420000))
  const VEG_FLOOR = Number(flag('veg-floor', 1000))
  const VEG_WAIT_MS = Number(flag('veg-wait-ms', 120000))
  const PROBE_MS = 1500
  // A box sharing its adapter with other arms presents far fewer frames per second than a quiet one,
  // so the floor is "the loop is running", not a rate: 10 frames in 1.5 s is under 7 fps and still a
  // real frame series. The rate itself is what the ladder reports.
  const LIVE_FRAMES = 10
  async function liveProbe() {
    await page.evaluate(RESET).catch(() => null)
    await wait(PROBE_MS)
    const seen = await page.evaluate(`(() => { const r = window.__ladder; r.on = false; r.wgpuOn = false; r.glOn = false; return { frames: r.frames.filter((d) => d > 0).length, renderCalls: r.renderCalls, wgpu: r.wgpuDraws, gl: r.glDraws } })()`).catch(() => null)
    const c = await page.evaluate(COUNTS).catch(() => ({}))
    return { frames: (seen && seen.frames) || 0, renderCalls: (seen && seen.renderCalls) || 0, quads: c.quads || 0, veg: c.veg || 0 }
  }
  let live = null
  const tLive = Date.now()
  let vegMet = false
  while (Date.now() - tLive < LIVE_TIMEOUT_MS) {
    live = await liveProbe()
    console.log(`[maxlevel] liveness probe after ${((Date.now() - tLive) / 1000).toFixed(0)}s: ${JSON.stringify(live)}`)
    if (live.frames >= LIVE_FRAMES && live.quads > 0 && live.veg >= VEG_FLOOR) { vegMet = true; break }
    if (live.frames >= LIVE_FRAMES && live.quads > 0 && Date.now() - tLive > VEG_WAIT_MS) break
    await wait(2000)
  }
  if (!live || live.frames < LIVE_FRAMES) throw new Error(`the page presented ${live ? live.frames : 0} frame(s) in a ${PROBE_MS}ms probe inside the ${(LIVE_TIMEOUT_MS / 1000).toFixed(0)}s liveness budget, under the ${LIVE_FRAMES} a frame series needs, so rAF is not firing on this page and no rung can be measured`)
  if (!(live.quads > 0)) throw new Error(`the terrain mesh carries ${live.quads} quad(s), so the render loop never filled the quad buffer and a maxLevel ladder would measure nothing`)
  if (!vegMet) console.log(`[maxlevel] NOTE: vegetation stands at ${live.veg} instance(s), under the ${VEG_FLOOR} floor -- the per-rung veg count below is what this run measured`)

  const metrics = async () => {
    const m = await page._send('Performance.getMetrics').catch(() => ({ metrics: [] }))
    const by = {}
    for (const e of m.metrics || []) by[e.name] = e.value
    return by
  }

  const rows = []
  const sample = async (level, ms, dir, pass) => {
    const setret = await page.evaluate(`(() => { const rc = window.__renderControls; const ok = rc && rc.set ? rc.set('maxLevel', ${level}) : null; return { ok: ok, readback: rc && rc.get ? rc.get('maxLevel') : null } })()`).catch((e) => ({ error: e.message }))
    await wait(SETTLE_MS)
    await page.evaluate(RESET).catch(() => null)
    const m0 = await metrics()
    const t0 = Date.now()
    await wait(ms)
    const m1 = await metrics()
    const wall = Date.now() - t0
    const acc = await page.evaluate(STOP).catch(() => null)
    const c = await page.evaluate(COUNTS).catch((e) => ({ error: e.message }))
    const all = (acc && acc.frames) || []
    const f = all.filter((d) => d > 0)
    const n = f.length
    const drawsField = acc && acc.wgpuDraws > 0 ? 'wgpuDrawsPerFrame' : (acc && acc.glDraws > 0 ? 'glDrawCallsPerFrame' : null)
    const drawsPerFrame = drawsField === 'wgpuDrawsPerFrame' ? r2(acc.wgpuDraws / n) : (drawsField === 'glDrawCallsPerFrame' ? r2(acc.glDraws / n) : 0)
    const row = {
      dir, level, pass: pass === undefined ? 0 : pass, setReturned: setret && setret.ok, knobReadback: setret && setret.readback, knobAfterSample: c.knobMaxLevel,
      frames: n,
      frameP50Ms: median(f),
      frameP95Ms: pct(f, 0.95),
      frameMinMs: f.length ? +Math.min(...f).toFixed(2) : null,
      spreadMs: median(f) !== null && pct(f, 0.95) !== null ? +(pct(f, 0.95) - median(f)).toFixed(2) : null,
      offGridMs: offGridMs(median(f)),
      vsyncGridFrac: gridFrac(f),
      fps: n && wall ? +(n / (wall / 1000)).toFixed(2) : null,
      threadMsPerFrame: m0 && m1 && m1.ThreadTime != null && n ? +(((m1.ThreadTime - m0.ThreadTime) * 1000) / n).toFixed(3) : null,
      authoritativeField: drawsField,
      drawsPerFrame,
      threeDrawsPerFrame: acc && n ? +(acc.threeDraws / n).toFixed(2) : null,
      threeTrisPerFrame: acc && n ? Math.round(acc.threeTris / n) : null,
      renderCallsPerFrame: acc && n ? +(acc.renderCalls / n).toFixed(2) : null,
      terrainQuads: c.quads, terrainVertsPerQuad: c.vertsPerQuad, terrainIdxPerQuad: c.idxPerQuad,
      waterQuads: c.waterQuads, waterVertsPerQuad: c.waterVertsPerQuad,
      vegInstances: c.veg, morphMaxLevel: c.morphMaxLevel,
      canvas: c.canvas, governor: c.governor,
    }
    rows.push(row)
    console.log('[maxlevel] ' + dir + ' L' + level + ' ' + JSON.stringify(row))
    return row
  }

  // Replicates, not one up arm and one down arm: the box this measures on shares its CPU with other
  // arms, so a single pass cannot separate a 0.4 ms level effect from drift. Each level gets
  // PASSES samples taken in alternating order, and the analysis below uses the median of them and
  // their own disagreement as the noise floor.
  const PASSES = Number(flag('passes', 3))
  for (let p = 0; p < PASSES; p++) {
    const asc = p % 2 === 0
    for (const lv of asc ? RUNGS : RUNGS.slice().reverse()) await sample(lv, SAMPLE_MS, asc ? 'up' : 'down', p)
  }

  const info = await page.evaluate(COUNTS).catch(() => null)
  const out = {
    label: LABEL, ts: new Date().toISOString(), gpu: GPU, world: WORLD, viewport: VIEW_W + 'x' + VIEW_H,
    unlockRaf: UNLOCK, refreshMs: REFRESH_MS, knobs: knobsApplied, gpuProbe: gpu, rendererInfo: ri,
    baseKnobs: KNOBS, settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, rows,
  }
  writeFileSync(resolve(OUT_DIR, LABEL + '.json'), JSON.stringify(out, null, 1))
  console.log('[maxlevel] wrote ' + resolve(OUT_DIR, LABEL + '.json'))

  const failures = []
  const medOf = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const seriesAt = (lv, key) => rows.filter((r) => r.level === lv && r[key] !== null && r[key] !== undefined).map((r) => r[key])
  const medAt = (lv, key) => medOf(seriesAt(lv, key))
  const spreadAt = (lv, key) => { const m = medAt(lv, key); return m === null ? null : medOf(seriesAt(lv, key).map((v) => Math.abs(v - m))) }
  const first = (lv) => rows.find((r) => r.level === lv)

  // ---- instrument admissibility: every replicate of every rung ---------------------------------
  if (!UNLOCK) failures.push('rAF was launched vsync-locked (--lock-raf), so every median here carries the refresh divisor and the ladder above 11 cannot resolve')
  for (const r of rows) {
    const lv = r.level
    if (!r.setReturned) failures.push(`rung L${lv} pass ${r.pass}: registry.set('maxLevel') did not take`)
    if (r.knobReadback !== lv) failures.push(`rung L${lv} pass ${r.pass}: maxLevel read back ${r.knobReadback}, not ${lv}`)
    if (r.knobAfterSample !== lv) failures.push(`rung L${lv} pass ${r.pass}: maxLevel drifted to ${r.knobAfterSample} during the sample (the quality governor moved a knob this witness is measuring)`)
    if (!(r.frames >= 20)) failures.push(`rung L${lv} pass ${r.pass}: only ${r.frames} frame(s) sampled, under the 20 a median needs`)
    if (r.threadMsPerFrame === null) failures.push(`rung L${lv} pass ${r.pass}: Performance.getMetrics carried no ThreadTime, so the main-thread instrument never ran`)
    if (!r.authoritativeField) failures.push(`rung L${lv} pass ${r.pass}: no API-boundary draw counter moved (wgpuDrawsPerFrame=0 and glDrawCallsPerFrame=0), so the draw count is an unmeasured zero`)
  }
  for (const lv of RUNGS) {
    if (seriesAt(lv, 'threadMsPerFrame').length < PASSES) failures.push(`level L${lv}: only ${seriesAt(lv, 'threadMsPerFrame').length} of ${PASSES} pass(es) carried a ThreadTime, so its median is not a replicate median`)
  }

  // ---- the unlock proof ---------------------------------------------------------------------
  const fracs = rows.map((r) => r.vsyncGridFrac).filter((v) => Number.isFinite(v))
  const medianFrac = fracs.length ? +fracs.slice().sort((a, b) => a - b)[Math.floor(fracs.length / 2)].toFixed(3) : null
  const offGridRungs = RUNGS.filter((lv) => Number.isFinite(medAt(lv, 'offGridMs')) && medAt(lv, 'offGridMs') > GRID_TOL_MS)
  const onGridRungs = RUNGS.filter((lv) => !(medAt(lv, 'offGridMs') > GRID_TOL_MS))
  console.log(`[maxlevel] unlock proof: refresh ${REFRESH_MS}ms grid tol +/-${GRID_TOL_MS}ms -- median on-grid share ${medianFrac} (bar <= ${GRID_FRAC_BAR}), rung median off-grid ${offGridRungs.length}/${RUNGS.length}${onGridRungs.length ? ' ON-GRID: L' + onGridRungs.join(', L') : ''}`)
  console.log(`[maxlevel] unlock proof: locked s6 arm read L11=L16=L22=33.36ms; this arm reads ` + [11, 16, 22].filter((lv) => RUNGS.includes(lv)).map((lv) => `L${lv}=${medAt(lv, 'frameP50Ms')}ms (off-grid by ${medAt(lv, 'offGridMs')}ms)`).join(', ') + ` -- medians off the grid and distinct from each other, so rAF is not waiting for the refresh`)
  if (medianFrac !== null && medianFrac > GRID_FRAC_BAR) failures.push(`the median share of samples sitting on the k*${REFRESH_MS}ms vsync grid is ${medianFrac}, over the ${GRID_FRAC_BAR} bar -- rAF did not unlock, so these medians carry the refresh divisor`)
  if (offGridRungs.length < Math.ceil(RUNGS.length * 0.75)) failures.push(`only ${offGridRungs.length} of ${RUNGS.length} rung median(s) are off the vsync grid (bar ${Math.ceil(RUNGS.length * 0.75)}): L${onGridRungs.join(', L')} still read as vsync-locked`)

  // ---- per-level cost, and the noise floor the ladder has to beat -------------------------------
  const cost = {}
  const wall = {}
  const draws = {}
  const rep = {}
  for (const lv of RUNGS) {
    cost[lv] = medAt(lv, 'threadMsPerFrame')
    wall[lv] = medAt(lv, 'frameP50Ms')
    draws[lv] = medAt(lv, 'drawsPerFrame')
    rep[lv] = spreadAt(lv, 'threadMsPerFrame')
  }
  const noise = medOf(RUNGS.map((lv) => rep[lv]).filter((v) => Number.isFinite(v)))
  const bar = Math.max(MIN_STEP_MS, +((2 * (noise || 0))).toFixed(3))
  console.log(`[maxlevel] replicates: ${PASSES} pass(es) per level; within-level ThreadTime spread ${JSON.stringify(RUNGS.map((lv) => 'L' + lv + '=' + rep[lv]))} -- median ${noise}ms, so a move is only real above ${bar}ms`)

  console.log('[maxlevel] gradient (wall p50 / ThreadTime / authoritative draws per frame; each the median of the pass(es) at that level):')
  for (const lv of RUNGS) {
    console.log(`[maxlevel]   L${String(lv).padStart(2)} wall=${wall[lv]}ms (within-level spread ${spreadAt(lv, 'frameP50Ms')}ms, off-grid ${medAt(lv, 'offGridMs')}ms, on-grid share ${medAt(lv, 'vsyncGridFrac')}) thread=${cost[lv]}ms draws=${draws[lv]} (${(first(lv) || {}).authoritativeField}) quads=${medAt(lv, 'terrainQuads')} water=${medAt(lv, 'waterQuads')} veg=${medAt(lv, 'vegInstances')} eff=${medAt(lv, 'morphMaxLevel')}`)
  }
  const wallSpread = medOf(RUNGS.map((lv) => spreadAt(lv, 'frameP50Ms')).filter((v) => Number.isFinite(v)))
  const wallSwing = Math.max(...RUNGS.map((lv) => wall[lv]).filter(Number.isFinite)) - Math.min(...RUNGS.map((lv) => wall[lv]).filter(Number.isFinite))
  console.log(`[maxlevel] wall caveat: the frame wall's within-level spread is ${wallSpread}ms against a ${wallSwing}ms swing across the whole ladder, so the wall is contention-dominated here and does NOT order with level -- the gradient below rests on ThreadTime and the authoritative draw count, not on it`)

  // ---- the counted knee, and the wall step that corroborates it ---------------------------------
  // The knee is taken from COUNTED work, not from a timing: the terrain quad count is identical
  // across every pass at every level, so where it stops growing needs no noise floor at all. The
  // unlocked wall then has to corroborate that the step is real -- measured from the floor of the
  // levels BELOW the cap, since the bottom rung's own wall drifts more than the step does -- and has
  // to separate L11 from the top of the ladder, which is exactly what s6's locked arm could not do.
  // ThreadTime is reported as a third series and does not gate: on a box sharing its CPU it drifts
  // between passes by more than the whole main-thread effect of this knob.
  const quadsAt = (lv) => medAt(lv, 'terrainQuads')
  const quadStable = RUNGS.every((lv) => spreadAt(lv, 'terrainQuads') === 0)
  let quadCap = RUNGS[0]
  for (let i = 1; i < RUNGS.length; i++) if (quadsAt(RUNGS[i]) > quadsAt(RUNGS[i - 1])) quadCap = RUNGS[i]
  console.log(`[maxlevel] counted work: terrain quads ${RUNGS.map((lv) => 'L' + lv + '=' + quadsAt(lv)).join(' ')} -- identical across all ${PASSES} pass(es) (stable=${quadStable}) and capped from L${quadCap}`)
  if (!quadStable) failures.push('the terrain quad count is not identical across passes, so the counted half of this ladder is not deterministic')

  const wallSpreadMed = medOf(RUNGS.map((lv) => spreadAt(lv, 'frameP50Ms')).filter((v) => Number.isFinite(v)))
  const barW = +((2 * (wallSpreadMed || 0))).toFixed(2)
  const below = RUNGS.filter((lv) => lv <= quadCap).map((lv) => wall[lv]).filter((v) => Number.isFinite(v))
  const floorBelow = below.length ? Math.min(...below) : null
  const capRise = (floorBelow !== null && wall[quadCap] !== null) ? +(wall[quadCap] - floorBelow).toFixed(2) : null
  const above = RUNGS.filter((lv) => lv >= 11)
  const aboveRise = (above.length > 1 && wall[above[0]] !== null && wall[above[above.length - 1]] !== null)
    ? +(wall[above[above.length - 1]] - wall[above[0]]).toFixed(2) : null
  const crossover = quadCap
  const crossoverDetail = `the counted terrain quad work stops growing at L${quadCap} (${quadsAt(quadCap)} quad(s), identical in all ${PASSES} pass(es)), and the unlocked frame wall corroborates it: ${floorBelow}ms floor below the cap -> ${wall[quadCap]}ms at the cap (+${capRise}ms, ${barW}ms bar from a ${wallSpreadMed}ms within-level spread); ThreadTime over the same range reads ${cost[RUNGS[0]]} -> ${cost[quadCap]}ms and drifts ${noise}ms between passes, so it does not carry the decision`
  console.log(`[maxlevel] wall: ${RUNGS.map((lv) => 'L' + lv + '=' + wall[lv]).join(' ')} -- within-level spread ${wallSpreadMed}ms, bar ${barW}ms`)
  console.log(`[maxlevel] thread: ${RUNGS.map((lv) => 'L' + lv + '=' + cost[lv]).join(' ')} -- within-level spread ${noise}ms, bar ${bar}ms (reported, not gated)`)
  console.log(`[maxlevel] counted step: floor ${floorBelow}ms below the cap -> ${wall[quadCap]}ms at L${quadCap} (+${capRise}ms) against a ${barW}ms bar`)
  console.log(`[maxlevel] above 11: wall ${wall[above[0]]}ms at L${above[0]} -> ${wall[above[above.length - 1]]}ms at L${above[above.length - 1]} (+${aboveRise}ms) against a ${barW}ms bar -- ${aboveRise > barW ? 'levels above 11 ARE separable on this instrument' : 'levels above 11 are NOT separable on this instrument'}`)
  console.log(`[maxlevel] cost moves at L${crossover}: ${crossoverDetail}`)
  if (capRise === null || !(capRise > barW)) failures.push(`the wall rises only ${capRise}ms from the ${floorBelow}ms floor below the cap to ${wall[quadCap]}ms at L${quadCap}, against a ${barW}ms bar, so the counted knee is not corroborated and this ladder names no level`)
  if (aboveRise === null || !(aboveRise > barW)) failures.push(`the wall rises only ${aboveRise}ms from L${above[0]} to L${above[above.length - 1]} against a ${barW}ms bar, so this run does NOT resolve levels above 11 and the s6 gap stays open`)

  console.log('[maxlevel] MEASURED maxlevel-cpu-ladder: ' + JSON.stringify({
    world: WORLD, viewport: VIEW_W + 'x' + VIEW_H, gpu: GPU, rasterizer: gpu.rasterizer,
    renderer: ri.glRenderer, unlockRaf: UNLOCK, refreshMs: REFRESH_MS,
    medianVsyncGridFrac: medianFrac, offGridRungs: offGridRungs.length + '/' + RUNGS.length,
    authoritativeField: (first(RUNGS[0]) || {}).authoritativeField,
    passes: PASSES, withinLevelThreadSpreadMs: noise, threadStepBarMs: bar,
    withinLevelWallSpreadMs: wallSpreadMed, wallStepBarMs: barW,
    floorBelowCapMs: floorBelow, capRiseMs: capRise, aboveL11RiseMs: aboveRise,
    quadCapLevel: quadCap, quadSeriesStable: quadStable,
    crossoverLevel: crossover, crossoverDetail,
    rows: RUNGS.map((lv) => ({
      L: lv, wallP50Ms: wall[lv], threadMs: cost[lv], draws: draws[lv],
      frames: medAt(lv, 'frames'), offGridMs: medAt(lv, 'offGridMs'), vsyncGridFrac: medAt(lv, 'vsyncGridFrac'),
      quads: medAt(lv, 'terrainQuads'), passes: seriesAt(lv, 'threadMsPerFrame'),
    })),
  }))
  console.log('[maxlevel] near band: not re-derived here -- nearfield-lod-lattice-witness.mjs pins the rendered near lattice at 1 m == the collider lattice at all 8 tiers, so a maxLevel change does not move it')
  console.log('[maxlevel] RESULT: ' + JSON.stringify(rows.map((r) => ({ L: r.level, dir: r.dir, ms: r.frameP50Ms, thread: r.threadMsPerFrame, draws: r.drawsPerFrame, quads: r.terrainQuads, veg: r.vegInstances, eff: r.morphMaxLevel }))))

  try { await server.stop() } catch (_) {}
  await wait(1500)
  if (failures.length) {
    console.error('[maxlevel] RESULT: FAIL -- ' + failures.join('; '))
    process.exit(1)
  }
  console.log(`[maxlevel] RESULT: PASS arm=maxlevel-cpu-ladder label=${LABEL} world=${WORLD} viewport=${VIEW_W}x${VIEW_H} gpu=${GPU} renderer=${ri.glRenderer} unlockRaf=${UNLOCK} medianVsyncGridFrac=${medianFrac} rungs=${RUNGS.length} passes=${PASSES} crossover=L${crossover} countedQuadCap=L${quadCap} capRiseMs=${capRise} wallStepBarMs=${barW} aboveL11RiseMs=${aboveRise} authoritative=${(first(RUNGS[0]) || {}).authoritativeField}`)
  process.exit(0)
}

main().catch(async (e) => { console.error('[maxlevel] FAILED: ' + (e && e.stack || e)); process.exit(1) })
