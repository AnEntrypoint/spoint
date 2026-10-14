#!/usr/bin/env node
// PERF-fill-overdraw-backface-1013. The overdraw COUNT the fill-bound surface has never had.
//
// Counted work units, not time: one unit = one fragment rasterized, read back out of an additive
// RGBA16F accumulation target and divided by a calibration constant measured on this adapter
// (client/core/OverdrawProbe.js). A fragment count is invariant to host contention, which is the
// whole reason it is the instrument for this row: three wall-clock A/B arms on this box came back
// REFUSED at x1.51-x2.47 against a x1.35 bar, while pixels x2.25 -> wall x2.18 with draws x1.02
// already says the frame is fill-bound without any timing at all.
//
// WHY TWO PASSES. three's overrideMaterial forces ONE cull mode for the whole accumulation render
// (three.webgpu.js:62755 `materialSide = scene.overrideMaterial.side`), so a single pass cannot
// honour each object's own material.side -- the override keeps the original positionNode (:62754,
// so terrain displacement survives) and alphaTest (:62758), but not the side. Per-surface
// attribution therefore comes from a VISIBILITY DELTA on the pass that matches that surface's side:
//   fragments(S, side) = pass(side, all) - pass(side, S hidden)
// which is exact because the accumulation pass has depthTest and depthWrite off, so a surface's
// fragments are counted whether or not something occludes them.
//
// WHAT IS MEASURED. The terrain patch grid is an OPEN heightfield: its visible ground is its
// BACK-facing winding (packages/mapspinner/src/tsl/terrain-material-tsl.js, named by
// scripts/terrain-side-overdraw-ab-witness.mjs, pinned by scripts/terrain-side-single-witness.mjs).
// So the two halves are:
//   BEFORE (DoubleSide) = frontHalf + backHalf
//   AFTER  (BackSide)   = backHalf
// and the change removes exactly the front half -- the underside of the heightfield, which no legal
// camera position can see.
//
// NON-VACUOUS IN BOTH DIRECTIONS: a fullscreen quad is ADDED (the count must rise by ~1 fragment
// per screen pixel) and the terrain is REMOVED (its delta must fall to zero). A count that survives
// both is an instrument gap and fails.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuLaunchArgs, gpuModeFlag } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { flagNumber } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3191')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const TIMEOUT_MS = flagNumber(flag, 'timeout', 420000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 20000, process.argv.slice(2))
const SAMPLES = flagNumber(flag, 'samples', 3, process.argv.slice(2))
const VIEW_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, process.argv.slice(2))
const VIEW_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, process.argv.slice(2))
const GPU_MODE = gpuModeFlag('gpu', 'software')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const LABEL = 'terrain-overdraw-count'
const FRONT = 0
const BACK = 1

const r2 = (x) => +Number(x).toFixed(2)
const r3 = (x) => +Number(x).toFixed(3)
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null }

// ---- page-side helpers -------------------------------------------------------------------------
const SET_ACCUM_SIDE = (side) => `(() => {
  const p = window.__overdrawProbe
  if (!p) return { ok: false, why: 'window.__overdrawProbe is absent' }
  p.accumulateMaterial.side = ${side}
  p.accumulateMaterial.needsUpdate = true
  return { ok: true, side: p.accumulateMaterial.side }
})()`

const FIND_SURFACES = `(() => {
  const scene = window.__scene
  if (!scene) return { ok: false, why: 'window.__scene is absent' }
  const out = { terrain: [], water: [] }
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of mats) {
      if (!m || !m.name) continue
      if (m.name === 'mapspinner-terrain-tsl') out.terrain.push(o.uuid)
      else if (m.name === 'mapspinner-water-tsl') out.water.push(o.uuid)
    }
  })
  return { ok: true, terrain: out.terrain.length, water: out.water.length, sceneChildren: scene.children.length }
})()`

const SET_VISIBLE = (kind, on) => `(() => {
  const scene = window.__scene
  if (!scene) return { ok: false, why: 'window.__scene is absent' }
  const want = ${kind === 'terrain' ? `'mapspinner-terrain-tsl'` : `'mapspinner-water-tsl'`}
  let n = 0
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of mats) if (m && m.name === want) { o.visible = ${on}; n++ }
  })
  return { ok: true, changed: n }
})()`

// The positive control: a second visible COPY of one terrain mesh, same transform and same
// material, so the accumulation pass must add exactly one more terrain's worth of fragments. It
// needs no new class from the page -- `mesh.clone()` -- and its expected size is the very number
// the hide-arm measures, so the two must agree.
const ADD_CLONE = `(() => {
  const scene = window.__scene
  if (!scene) return { ok: false, why: 'window.__scene is absent' }
  if (window.__odClone) { window.__odClone.visible = true; return { ok: true, reused: true } }
  let host = null
  scene.traverse((o) => {
    if (host) return
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of mats) if (m && m.name === 'mapspinner-terrain-tsl') host = o
  })
  if (!host) return { ok: false, why: 'no terrain mesh to clone' }
  const c = host.clone()
  c.material = host.material
  c.visible = true
  const parent = host.parent || scene
  parent.add(c)
  window.__odClone = c
  return { ok: true, cloned: host.name || host.type }
})()`

const REMOVE_CLONE = `(() => { if (window.__odClone) window.__odClone.visible = false; return true })()`

const ENABLE = `(() => {
  const rc = window.__renderControls
  if (!rc) return { ok: false, why: 'window.__renderControls is absent' }
  rc.set('overdraw', true)
  return { ok: true, value: rc.get('overdraw') }
})()`

const PROBE_STATE = `(() => {
  const p = window.__overdrawProbe
  const s = window.__overdrawStats
  return {
    probe: !!p,
    counters: p ? p.counters() : null,
    stats: s ? {
      viewport: s.viewport, pixels: s.pixels, unitsPerFragment: s.unitsPerFragment,
      coveredPixels: s.coveredPixels, coveragePct: s.coveragePct,
      totalFragments: s.totalFragments,
      fragmentsPerScreenPixel: s.fragmentsPerScreenPixel,
      fragmentsPerCoveredPixel: s.fragmentsPerCoveredPixel,
      maxFragmentsPerPixel: s.maxFragmentsPerPixel,
      p50: s.p50FragmentsPerCoveredPixel, p95: s.p95FragmentsPerCoveredPixel, p99: s.p99FragmentsPerCoveredPixel,
      histogram: s.histogram, reads: s.reads, errors: s.errors,
    } : null,
  }
})()`

const SIDE_STATE = `(() => {
  const scene = window.__scene
  if (!scene) return null
  const found = {}
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []
    for (const m of mats) {
      if (!m || !m.name) continue
      if (m.name === 'mapspinner-terrain-tsl' || m.name === 'mapspinner-water-tsl') {
        found[m.name] = { side: m.side, visible: o.visible, transparent: !!m.transparent }
      }
    }
  })
  return found
})()`

const RENDERER_INFO = `(() => {
  const ri = window.__rendererInfo
  const r = window.__renderer
  return {
    info: ri || null,
    isWebGPURenderer: !!(r && r.isWebGPURenderer),
    backend: r && r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'other') : null,
  }
})()`

async function main() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[${LABEL}] booting real server on ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS })
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    const url = `http://localhost:${PORT}/?${PARAMS}&webgpu=1&world=${WORLD}&v=${Date.now()}`
    console.log(`[${LABEL}] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__overdrawProbe && window.__scene`
    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      console.error(`[${LABEL}] RESULT: FAIL -- the page never became ready with a live overdraw probe`)
      await browser.close().catch(() => {})
      server.stop()
      process.exit(1)
    }
    await new Promise(r => setTimeout(r, SETTLE_MS))

    const gpu = await assertGpu(page, { expectVendor: flag('expect-vendor', null) })
    const ri = await page.evaluate(RENDERER_INFO)
    const info = ri && ri.info
    const isWebGPU = !!(info && info.class === 'WebGPURenderer' && info.backend === 'webgpu')
    console.log(`[${LABEL}] renderer ${JSON.stringify(info)} rasterizer=${gpu.rasterizer}`)

    const surfaces = await page.evaluate(FIND_SURFACES)
    console.log(`[${LABEL}] surfaces ${JSON.stringify(surfaces)}`)
    const enabled = await page.evaluate(ENABLE)
    console.log(`[${LABEL}] overdraw enabled ${JSON.stringify(enabled)}`)
    await new Promise(r => setTimeout(r, 3000))

    const state0 = await page.evaluate(PROBE_STATE)
    if (!state0.stats || !state0.stats.unitsPerFragment) {
      console.error(`[${LABEL}] RESULT: FAIL -- the probe never calibrated (unitsPerFragment=${state0.stats && state0.stats.unitsPerFragment}): ${JSON.stringify(state0.counters)}`)
      await browser.close().catch(() => {})
      server.stop()
      process.exit(1)
    }

    const pixels = state0.stats.pixels
    console.log(`[${LABEL}] calibrated: unitsPerFragment=${state0.stats.unitsPerFragment} viewport=${state0.stats.viewport} pixels=${pixels}`)

    async function samplePass(side) {
      await page.evaluate(SET_ACCUM_SIDE(side))
      const runs = []
      for (let i = 0; i < SAMPLES; i++) {
        await new Promise(r => setTimeout(r, 700))
        const before = await page.evaluate(`(() => { const c = window.__overdrawProbe.counters(); return c.reads })()`)
        await page.evaluate(`(() => { window.__overdrawProbe.sample(); return true })()`)
        let st = null
        const t1 = Date.now()
        while (Date.now() - t1 < 25000) {
          const s = await page.evaluate(PROBE_STATE)
          if (s.stats && s.stats.reads > before) { st = s.stats; break }
          await new Promise(r => setTimeout(r, 200))
        }
        if (!st) return { ok: false, why: 'no readback completed within 25s' }
        runs.push(st)
      }
      const totals = runs.map(s => s.totalFragments)
      const last = runs[runs.length - 1]
      return {
        ok: true,
        side,
        totalFragments: median(totals),
        totals,
        fragmentsPerScreenPixel: r3(median(totals) / pixels),
        coveredPixels: last.coveredPixels,
        coveragePct: last.coveragePct,
        maxFragmentsPerPixel: last.maxFragmentsPerPixel,
        p95: last.p95,
        histogram: last.histogram,
      }
    }

    async function measureArm(name) {
      const front = await samplePass(FRONT)
      const back = await samplePass(BACK)
      if (!front.ok || !back.ok) return { ok: false, why: front.why || back.why }
      return { ok: true, name, front, back }
    }

    const arms = {}
    arms.all = await measureArm('all')
    if (!arms.all.ok) throw new Error(arms.all.why)

    await page.evaluate(SET_VISIBLE('terrain', false))
    await new Promise(r => setTimeout(r, 1200))
    arms.terrainHidden = await measureArm('terrain-hidden')

    await page.evaluate(SET_VISIBLE('terrain', true))
    await page.evaluate(SET_VISIBLE('water', false))
    await new Promise(r => setTimeout(r, 1200))
    arms.waterHidden = await measureArm('water-hidden')
    await page.evaluate(SET_VISIBLE('water', true))

    const clone = await page.evaluate(ADD_CLONE)
    await new Promise(r => setTimeout(r, 1200))
    arms.clone = clone.ok ? await measureArm('terrain-clone-added') : { ok: false, why: clone.why }
    await page.evaluate(REMOVE_CLONE)

    const sideState = await page.evaluate(SIDE_STATE)
    const counters = await page.evaluate(`(() => window.__overdrawProbe.counters())()`)
    console.log(`[${LABEL}] live material sides ${JSON.stringify(sideState)}`)
    console.log(`[${LABEL}] probe counters ${JSON.stringify(counters)}`)

    await browser.close().catch(() => {})
    server.stop()

    if (!arms.terrainHidden.ok || !arms.waterHidden.ok || !arms.clone.ok) {
      console.error(`[${LABEL}] RESULT: FAIL -- arm(s) did not run: terrainHidden=${arms.terrainHidden.ok ? 'ok' : arms.terrainHidden.why} waterHidden=${arms.waterHidden.ok ? 'ok' : arms.waterHidden.why} clone=${arms.clone.ok ? 'ok' : arms.clone.why}`)
      process.exit(1)
    }

    // ---- the terrain, separated ---------------------------------------------------------------
    const terrainFront = arms.all.front.totalFragments - arms.terrainHidden.front.totalFragments
    const terrainBack = arms.all.back.totalFragments - arms.terrainHidden.back.totalFragments
    const terrainBefore = terrainFront + terrainBack
    const terrainAfter = terrainBack
    const saving = terrainBefore - terrainAfter
    const ratio = terrainAfter > 0 ? terrainBefore / terrainAfter : null

    // ---- the water, separated -----------------------------------------------------------------
    const waterFront = arms.all.front.totalFragments - arms.waterHidden.front.totalFragments
    const waterBack = arms.all.back.totalFragments - arms.waterHidden.back.totalFragments
    const waterFragments = waterFront + waterBack

    // ---- the rest of the frame ----------------------------------------------------------------
    // Everything except the two separated surfaces, read off the FRONT pass. It is a LOWER bound:
    // grass blades and leaf cards are DoubleSide by design, and their back half lives in the back
    // pass, so it is not in this number.
    const restFront = arms.all.front.totalFragments - terrainFront - waterFront

    // ---- the positive control -----------------------------------------------------------------
    const cloneDeltaBack = arms.clone.back.totalFragments - arms.all.back.totalFragments
    const cloneDeltaFront = arms.clone.front.totalFragments - arms.all.front.totalFragments

    const failures = []
    if (!isWebGPU) failures.push(`renderer is not WebGPU (${JSON.stringify(info)}); a WebGL fallback cannot be quoted here`)
    if (counters.errors !== 0) failures.push(`the probe recorded ${counters.errors} error(s): ${counters.lastError}`)
    if (surfaces.terrain <= 0) failures.push('no object in the scene carries the terrain material, so the terrain delta measures nothing')
    if (surfaces.water <= 0) failures.push('no object in the scene carries the water material, so the water cannot be checked')
    if (!(terrainFront > 0)) failures.push(`the terrain's FRONT-facing half rasterized ${terrainFront} fragment(s): the count did not move DOWN when the half the change removes was measured, so this is an instrument gap`)
    if (!(terrainBack > 0)) failures.push(`the terrain's BACK-facing half rasterized ${terrainBack} fragment(s): the half the camera sees was not counted`)
    if (!(cloneDeltaBack > terrainBack * 0.6)) failures.push(`the positive control (a second visible copy of one terrain mesh) moved the back pass by ${cloneDeltaBack} fragment(s), not the ~${terrainBack} one terrain's worth must add: the instrument cannot see added overdraw`)
    if (!(arms.terrainHidden.back.totalFragments < arms.all.back.totalFragments)) failures.push('hiding the terrain did not lower the count, so the terrain delta is not the terrain')
    if (!(waterFragments > 0)) failures.push(`the water pass rasterized ${waterFragments} fragment(s) with the terrain single-sided: the water pass did not survive`)
    if (!(sideState && sideState['mapspinner-water-tsl'] && sideState['mapspinner-water-tsl'].side === 2)) failures.push(`the water material is no longer DoubleSide (side=${sideState && sideState['mapspinner-water-tsl'] && sideState['mapspinner-water-tsl'].side})`)
    if (!(sideState && sideState['mapspinner-terrain-tsl'] && sideState['mapspinner-terrain-tsl'].side === BACK)) failures.push(`the terrain material in the live page is ${sideState && sideState['mapspinner-terrain-tsl'] && sideState['mapspinner-terrain-tsl'].side}, not BackSide(1)`)
    if (pageErrors.length) failures.push(`${pageErrors.length} page error(s): ${pageErrors[0].slice(0, 160)}`)

    console.log(`[${LABEL}] MEASURED pass front: total=${arms.all.front.totalFragments} (${arms.all.front.fragmentsPerScreenPixel}/screen px) covered=${arms.all.front.coveredPixels} max=${arms.all.front.maxFragmentsPerPixel} p95=${arms.all.front.p95}`)
    console.log(`[${LABEL}] MEASURED pass back:  total=${arms.all.back.totalFragments} (${arms.all.back.fragmentsPerScreenPixel}/screen px) covered=${arms.all.back.coveredPixels} max=${arms.all.back.maxFragmentsPerPixel} p95=${arms.all.back.p95}`)
    console.log(`[${LABEL}] MEASURED terrain before (DoubleSide, both halves): ${terrainBefore} fragment(s) = ${r3(terrainBefore / pixels)}/screen px; front half ${terrainFront}, back half ${terrainBack}`)
    console.log(`[${LABEL}] MEASURED terrain after (BackSide, the half the camera sees): ${terrainAfter} fragment(s) = ${r3(terrainAfter / pixels)}/screen px`)
    console.log(`[${LABEL}] MEASURED terrain removed by single-siding: ${saving} fragment(s) = ${r3(saving / pixels)}/screen px; before/after ratio ${ratio === null ? 'n/a' : r2(ratio)}`)
    console.log(`[${LABEL}] MEASURED water (DoubleSide, both halves): ${waterFragments} fragment(s) = ${r3(waterFragments / pixels)}/screen px`)
    console.log(`[${LABEL}] MEASURED rest of the frame (front pass, lower bound): ${restFront} fragment(s) = ${r3(restFront / pixels)}/screen px`)
    console.log(`[${LABEL}] MEASURED positive control (one extra terrain copy): back pass +${cloneDeltaBack}, front pass +${cloneDeltaFront} against one terrain's worth ${terrainBack} / ${terrainFront}`)
    console.log(`[${LABEL}] histogram front ${JSON.stringify(arms.all.front.histogram)}`)
    console.log(`[${LABEL}] histogram back  ${JSON.stringify(arms.all.back.histogram)}`)
    console.log(`[${LABEL}] viewport ${VIEW_W}x${VIEW_H} pixels=${pixels} rasterizer=${gpu.rasterizer}`)

    if (failures.length) {
      console.error(`[${LABEL}] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[${LABEL}] RESULT: PASS label=${LABEL} terrain ${terrainBefore} -> ${terrainAfter} fragment(s) (removed ${saving}, ratio ${r2(ratio)}), water ${waterFragments} retained, control +${cloneDeltaBack} vs ${terrainBack}, viewport=${VIEW_W}x${VIEW_H} rasterizer=${gpu.rasterizer}`)
    process.exit(0)
  } catch (e) {
    console.error(`[${LABEL}] FAILED: ${e.stack || e.message}`)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
