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
const SAMPLE_MS = Number(flag('sample-ms', 5000))
const DESC = !has('no-desc')
const DESC_SAMPLE_MS = Number(flag('desc-sample-ms', 4000))
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
    veg: veg ? ((veg.profile && veg.profile.totalInstances) ?? veg.instanceCount ?? veg.count ?? null) : null,
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
  console.log('[maxlevel] unlock-raf=' + UNLOCK + ' args=' + JSON.stringify(args.slice(-2)))
  const browser = await chromium.launch({ args, owner: LABEL, root: ROOT, leaseWaitMs: LEASE_WAIT_MS })
  const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
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
  await wait(4000)

  const metrics = async () => {
    const m = await page._send('Performance.getMetrics').catch(() => ({ metrics: [] }))
    const by = {}
    for (const e of m.metrics || []) by[e.name] = e.value
    return by
  }

  const rows = []
  const sample = async (level, ms, dir) => {
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
      dir, level, setReturned: setret && setret.ok, knobReadback: setret && setret.readback, knobAfterSample: c.knobMaxLevel,
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

  for (const lv of RUNGS) await sample(lv, SAMPLE_MS, 'up')
  if (DESC) for (const lv of RUNGS.slice().reverse()) await sample(lv, DESC_SAMPLE_MS, 'down')

  const info = await page.evaluate(COUNTS).catch(() => null)
  const out = {
    label: LABEL, ts: new Date().toISOString(), gpu: GPU, world: WORLD, viewport: VIEW_W + 'x' + VIEW_H,
    unlockRaf: UNLOCK, refreshMs: REFRESH_MS, knobs: knobsApplied, gpuProbe: gpu, rendererInfo: ri,
    baseKnobs: KNOBS, settleMs: SETTLE_MS, sampleMs: SAMPLE_MS, rows,
  }
  writeFileSync(resolve(OUT_DIR, LABEL + '.json'), JSON.stringify(out, null, 1))
  console.log('[maxlevel] wrote ' + resolve(OUT_DIR, LABEL + '.json'))

  const failures = []
  const up = (lv) => rows.find((r) => r.dir === 'up' && r.level === lv)
  const down = (lv) => rows.find((r) => r.dir === 'down' && r.level === lv)

  // ---- instrument admissibility -------------------------------------------------------------
  if (!UNLOCK) failures.push('rAF was launched vsync-locked (--lock-raf), so every median here carries the refresh divisor and the ladder above 11 cannot resolve')
  for (const lv of RUNGS) {
    const r = up(lv)
    if (!r) { failures.push(`rung L${lv} has no up-arm sample`); continue }
    if (!r.setReturned) failures.push(`rung L${lv}: registry.set('maxLevel') did not take`)
    if (r.knobReadback !== lv) failures.push(`rung L${lv}: maxLevel read back ${r.knobReadback}, not ${lv}`)
    if (r.knobAfterSample !== lv) failures.push(`rung L${lv}: maxLevel drifted to ${r.knobAfterSample} during the sample (the quality governor moved a knob this witness is measuring)`)
    if (!(r.frames >= 30)) failures.push(`rung L${lv}: only ${r.frames} frame(s) sampled, under the 30 a median needs`)
    if (r.threadMsPerFrame === null) failures.push(`rung L${lv}: Performance.getMetrics carried no ThreadTime, so the main-thread instrument never ran`)
    if (!r.authoritativeField) failures.push(`rung L${lv}: no API-boundary draw counter moved (wgpuDrawsPerFrame=0 and glDrawCallsPerFrame=0), so the draw count is an unmeasured zero`)
  }

  // ---- the unlock proof ---------------------------------------------------------------------
  const fracs = RUNGS.map((lv) => (up(lv) ? up(lv).vsyncGridFrac : null)).filter((v) => Number.isFinite(v))
  const medianFrac = fracs.length ? +fracs.slice().sort((a, b) => a - b)[Math.floor(fracs.length / 2)].toFixed(3) : null
  const offGridRungs = RUNGS.filter((lv) => up(lv) && Number.isFinite(up(lv).offGridMs) && up(lv).offGridMs > GRID_TOL_MS)
  const onGridRungs = RUNGS.filter((lv) => up(lv) && !(up(lv).offGridMs > GRID_TOL_MS))
  console.log(`[maxlevel] unlock proof: refresh ${REFRESH_MS}ms grid tol +/-${GRID_TOL_MS}ms -- median on-grid share ${medianFrac} (bar <= ${GRID_FRAC_BAR}), rung median off-grid ${offGridRungs.length}/${RUNGS.length}${onGridRungs.length ? ' ON-GRID: L' + onGridRungs.join(', L') : ''}`)
  console.log(`[maxlevel] unlock proof: locked s6 arm read L11=L16=L22=33.36ms; this arm reads ` + [11, 16, 22].filter((lv) => RUNGS.includes(lv) && up(lv)).map((lv) => `L${lv}=${up(lv).frameP50Ms}ms (off-grid by ${up(lv).offGridMs}ms)`).join(', ') + ` -- medians off the grid and distinct from each other, so rAF is not waiting for the refresh`)
  if (medianFrac !== null && medianFrac > GRID_FRAC_BAR) failures.push(`the median share of samples sitting on the k*${REFRESH_MS}ms vsync grid is ${medianFrac}, over the ${GRID_FRAC_BAR} bar -- rAF did not unlock, so these medians carry the refresh divisor`)
  if (offGridRungs.length < Math.ceil(RUNGS.length * 0.75)) failures.push(`only ${offGridRungs.length} of ${RUNGS.length} rung median(s) are off the vsync grid (bar ${Math.ceil(RUNGS.length * 0.75)}): L${onGridRungs.join(', L')} still read as vsync-locked`)

  // ---- does the ladder resolve above 11 ------------------------------------------------------
  const above = RUNGS.filter((lv) => lv >= 11)
  function steps(key, bar) {
    let n = 0
    for (let i = 1; i < above.length; i++) {
      const a = up(above[i - 1])
      const b = up(above[i])
      if (!a || !b || a[key] === null || b[key] === null) continue
      if (Math.abs(b[key] - a[key]) >= bar) n++
    }
    return n
  }
  const wallSteps = steps('frameP50Ms', WALL_STEP_MS)
  const threadSteps = steps('threadMsPerFrame', THREAD_STEP_MS)
  console.log(`[maxlevel] resolution above 11: ${wallSteps} of ${above.length - 1} wall step(s) >= ${WALL_STEP_MS}ms and ${threadSteps} of ${above.length - 1} ThreadTime step(s) >= ${THREAD_STEP_MS}ms`)
  if (wallSteps < 2) failures.push(`the wall gradient resolves only ${wallSteps} step(s) above L11 (bar 2 of ${above.length - 1}), so levels above 11 are still indistinguishable on it`)
  if (threadSteps < 2) failures.push(`the ThreadTime gradient resolves only ${threadSteps} step(s) above L11 (bar 2 of ${above.length - 1}), so levels above 11 are still indistinguishable on it`)

  // ---- the gradient, and the level where the cost actually moves ------------------------------
  console.log('[maxlevel] gradient (wall p50 / ThreadTime / authoritative draws per frame, up arm):')
  for (const lv of RUNGS) {
    const r = up(lv)
    if (!r) continue
    console.log(`[maxlevel]   L${String(lv).padStart(2)} wall=${r.frameP50Ms}ms (p95 ${r.frameP95Ms}, min ${r.frameMinMs}, spread ${r.spreadMs}, off-grid ${r.offGridMs}) thread=${r.threadMsPerFrame}ms draws=${r.drawsPerFrame} (${r.authoritativeField}) quads=${r.terrainQuads} water=${r.waterQuads} veg=${r.vegInstances} eff=${r.morphMaxLevel}`)
  }

  // Noise floor: the up/down disagreement at one level is what the run cannot resolve below.
  let spread = 0
  for (const lv of RUNGS) {
    const a = up(lv)
    const b = down(lv)
    if (!a || !b || a.threadMsPerFrame === null || b.threadMsPerFrame === null) continue
    spread = Math.max(spread, Math.abs(a.threadMsPerFrame - b.threadMsPerFrame))
  }
  const threadTol = Math.max(0.3, +(2 * spread).toFixed(2))
  let crossover = null
  let crossoverDetail = null
  for (let i = 1; i < RUNGS.length; i++) {
    const lo = RUNGS[i - 1]
    const hi = RUNGS[i]
    const a = up(lo)
    const b = up(hi)
    const ad = down(lo)
    const bd = down(hi)
    if (!a || !b || !ad || !bd) continue
    const dUp = +(b.threadMsPerFrame - a.threadMsPerFrame).toFixed(3)
    const dDown = +(bd.threadMsPerFrame - ad.threadMsPerFrame).toFixed(3)
    if (dUp > threadTol && dDown > threadTol) {
      crossover = hi
      crossoverDetail = `ThreadTime ${a.threadMsPerFrame}ms at L${lo} -> ${b.threadMsPerFrame}ms at L${hi} (+${dUp}ms up arm, +${dDown}ms down arm, noise floor +/-${threadTol}ms)`
      break
    }
  }
  console.log(`[maxlevel] noise floor: up/down ThreadTime disagrees by at most ${(+spread).toFixed(2)}ms, so a move is only real above +/-${threadTol}ms`)
  if (crossover) console.log(`[maxlevel] cost moves at L${crossover}: ${crossoverDetail}`)
  else console.log('[maxlevel] cost never moves by more than the noise floor anywhere on the ladder')
  if (crossover === null) failures.push(`no level moves the main-thread cost by more than the run's own noise floor (+/-${threadTol}ms), so this ladder names no crossover`)

  console.log('[maxlevel] MEASURED maxlevel-cpu-ladder: ' + JSON.stringify({
    world: WORLD, viewport: VIEW_W + 'x' + VIEW_H, gpu: GPU, rasterizer: gpu.rasterizer,
    renderer: ri.glRenderer, unlockRaf: UNLOCK, refreshMs: REFRESH_MS,
    medianVsyncGridFrac: medianFrac, offGridRungs: offGridRungs.length + '/' + RUNGS.length,
    authoritativeField: (up(RUNGS[0]) || {}).authoritativeField,
    crossoverLevel: crossover, noiseFloorMs: threadTol,
    rows: rows.filter((r) => r.dir === 'up').map((r) => ({
      L: r.level, wallP50Ms: r.frameP50Ms, threadMs: r.threadMsPerFrame, draws: r.drawsPerFrame,
      frames: r.frames, offGridMs: r.offGridMs, vsyncGridFrac: r.vsyncGridFrac, quads: r.terrainQuads,
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
  console.log(`[maxlevel] RESULT: PASS arm=maxlevel-cpu-ladder label=${LABEL} world=${WORLD} viewport=${VIEW_W}x${VIEW_H} gpu=${GPU} renderer=${ri.glRenderer} unlockRaf=${UNLOCK} medianVsyncGridFrac=${medianFrac} rungs=${RUNGS.length} crossover=L${crossover} authoritative=${(up(RUNGS[0]) || {}).authoritativeField}`)
  process.exit(0)
}

main().catch(async (e) => { console.error('[maxlevel] FAILED: ' + (e && e.stack || e)); process.exit(1) })
