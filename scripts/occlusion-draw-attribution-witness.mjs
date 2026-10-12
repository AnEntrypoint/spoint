#!/usr/bin/env node
// Live instrument, not a fixture: boots the real server and the real browser and asks
// the ONE question that decides whether retargeting the working occlusion tier onto
// SceneOcclusion's population can ever move a draw count:
//
//   hide EVERY candidate of a subsystem at once -- the upper bound on the draw
//   reduction that subsystem's candidates can ever produce -- and count draws.
//
// If hiding all 1860 vegetation cells costs 0 draws, then no subset of them can cost
// more than 0, and the draw-count metric the retarget has to be judged on is 0 by
// construction. That is a result, not a failure, and it is the reason this file exists
// before any retarget code is written.
//
// Counted units only: draw calls per frame off three's own info, and instance counts
// off each subsystem's own profile. No GPU pass timing is read anywhere in this file.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from './lib/cdp-browser.mjs'
import { assertGpu, gpuModeFlag, gpuLaunchArgs } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const numeric = (name, dflt) => {
  const raw = flag(name, null)
  if (raw === null) return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? n : dflt
}

const PORT = flag('port', '3157')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const FRAMES = numeric('frames', '40')
const SETTLE_MS = numeric('settle', '6000')
const TIMEOUT_MS = numeric('timeout', '300000')
const BACKEND = flag('backend', 'webgpu')

const GPU_MODE = gpuModeFlag('gpu', 'accelerated')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__sceneOcclusion && window.__veg && window.__rocks && window.__grass`

// Per-frame draw samples, not a running mean: a median is what an A/B can be read off.
// `authoritativeField` decides which of three's counters is the real one for the
// backend that booted -- renderer.info.render is that field for both.
const PROBE = `(() => {
  const W = window
  if (W.__occAttrProbe) return
  const p = { samples: [], frames: 0, hooked: false, recording: false }
  W.__occAttrProbe = p
  function tick() {
    const r = W.__app && W.__app.renderer
    if (r && r.info) {
      if (!p.hooked && r.info.render) p.hooked = true
      const d = r.info.render.drawCalls !== undefined ? r.info.render.drawCalls : r.info.render.calls
      if (Number.isFinite(d)) { p.frames++; if (p.recording) p.samples.push(d) }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  W.__occAttrReset = () => { p.samples.length = 0 }
  W.__occAttrRec = (on) => { p.recording = !!on }
})()`

const SYS_OF = `(() => ({
  vegetation: window.__veg || null,
  rocks: window.__rocks || null,
  grass: window.__grass || null,
}))()`

const READ_STATE = `(() => {
  const W = window
  const names = ['vegetation', 'rocks', 'grass']
  const sys = { vegetation: W.__veg, rocks: W.__rocks, grass: W.__grass }
  const out = {}
  for (const n of names) {
    const s = sys[n]
    let cells = 0, keys = 0, instances = 0, threw = null
    try { const c = s.getOcclusionCandidates(); cells = c.length; keys = c.length } catch (e) { threw = (e && e.message) || String(e) }
    try { instances = s.totalInstances } catch (_) {}
    out[n] = { cells, instances, threw }
  }
  const prof = {}
  for (const k of ['__vegProfile', '__grassProfile', '__rocksProfile']) if (W[k]) prof[k] = JSON.parse(JSON.stringify(W[k]))
  return {
    subsystems: out,
    profiles: prof,
    rendererIsWebGPU: !!(W.__app && W.__app.renderer && W.__app.renderer.isWebGPURenderer),
    sceneSupported: W.__sceneOcclusion && W.__sceneOcclusion.supported ? W.__sceneOcclusion.supported() : null,
    sceneCandidates: W.__sceneOcclusion && W.__sceneOcclusion.getCandidateCount ? W.__sceneOcclusion.getCandidateCount() : null,
  }
})()`

function median(arr) {
  if (!arr.length) return null
  const a = arr.slice().sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

async function sampleFrames(page, n, label) {
  await page.evaluate(`(() => { window.__occAttrReset(); window.__occAttrRec(true); return true })()`)
  const t0 = Date.now()
  while (Date.now() - t0 < TIMEOUT_MS) {
    const got = await page.evaluate(`window.__occAttrProbe.samples.length`).catch(() => 0)
    if (got >= n) break
    await new Promise(r => setTimeout(r, 60))
  }
  const res = await page.evaluate(`(() => { const p = window.__occAttrProbe; const s = p.samples.slice(); window.__occAttrRec(false); return { samples: s, frames: p.frames } })()`)
  const m = median(res.samples)
  console.log(`[occ-attr]   ${label}: n=${res.samples.length} medianDraws=${m === null ? 'none' : m.toFixed(2)} min=${res.samples.length ? Math.min(...res.samples) : '-'} max=${res.samples.length ? Math.max(...res.samples) : '-'}`)
  return { samples: res.samples, median: m }
}

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[occ-attr] booting real server on ${PORT} world=${process.env.WORLD} backend=${BACKEND}`)
  rebuildIfRequested('occ-attr')
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : (BACKEND === 'webgl' ? `${PARAMS}&legacygl=1` : PARAMS)
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}`
    console.log(`[occ-attr] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      console.error('[occ-attr] RESULT: FAIL -- page never became ready with all three occlusion subsystems exposed')
      process.exit(1)
    }
    console.log(`[occ-attr] ready @ ${Date.now() - t0}ms`)

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'occ-attr' })
    console.log(`[occ-attr] served ${clientRootTag(servedRoot)}`)

    const gpu = await assertGpu(page, { requireAccelerated: GPU_MODE.accelerated, expectVendor: GPU_MODE.vendor || null })
    console.log(`[occ-attr] rasterizer=${gpu.rasterizer} adapter=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor) : 'none'}`)

    if (BACKEND === 'webgpu') {
      const wa = await page.evaluate(`(() => { const r = window.__app && window.__app.renderer; const b = r && r.backend; return { hasRendererInfo: !!window.__rendererInfo, isWebGPURenderer: !!(r && r.isWebGPURenderer), backendIsWebGPU: !!(b && b.isWebGPUBackend) } })()`)
      console.log(`[occ-attr] webgpu arm assert: ${JSON.stringify(wa)}`)
      if (!wa.isWebGPURenderer || !wa.backendIsWebGPU || !wa.hasRendererInfo) {
        console.error('[occ-attr] RESULT: FAIL -- webgpu arm requested but the renderer did not come up WebGPU')
        process.exit(1)
      }
    }

    const built = `performance.getEntriesByType('mark').some(m => m.name === 'boot:scenery-built')`
    const tS = Date.now()
    let scenery = false
    while (Date.now() - tS < TIMEOUT_MS) {
      scenery = await page.evaluate(built).catch(() => false)
      if (scenery) break
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[occ-attr] boot:scenery-built ${scenery ? 'reached' : 'UNREACHED'} -- waiting ${SETTLE_MS}ms for streaming to settle`)
    await new Promise(r => setTimeout(r, SETTLE_MS))

    const st0 = await page.evaluate(READ_STATE)
    console.log(`[occ-attr] renderer isWebGPU=${st0.rendererIsWebGPU} sceneOcclusion supported=${st0.sceneSupported} candidates=${st0.sceneCandidates}`)
    for (const [n, v] of Object.entries(st0.subsystems)) console.log(`[occ-attr] subsystem ${n}: cells=${v.cells} instances=${v.instances}${v.threw ? ' threw=' + v.threw : ''}`)

    // The population this whole question is about, written down before any arm runs.
    const totalCells = Object.values(st0.subsystems).reduce((a, v) => a + (v.cells || 0), 0)
    const totalInstances = Object.values(st0.subsystems).reduce((a, v) => a + (v.instances || 0), 0)
    console.log(`[occ-attr] population: cells=${totalCells} instances=${totalInstances}`)

    const results = {}
    results.__baseline__ = await sampleFrames(page, FRAMES, 'baseline (nothing hidden)')

    for (const name of ['vegetation', 'rocks', 'grass']) {
      console.log(`[occ-attr] -- ${name}: hide ALL ${st0.subsystems[name].cells} cells`)
      const hid = await page.evaluate(`(() => {
        const s = window.__${name === 'vegetation' ? 'veg' : name}
        const keys = []
        for (const c of s.getOcclusionCandidates()) keys.push(c.key)
        const set = new Set(keys)
        s.applyOcclusion(set)
        return { asked: keys.length }
      })()`)
      console.log(`[occ-attr]   applyOcclusion(all) asked=${hid.asked}`)
      const hidden = await sampleFrames(page, FRAMES, `${name} ALL HIDDEN`)
      const profAfter = await page.evaluate(`(() => {
        const W = window
        const out = {}
        for (const k of ['__vegProfile', '__grassProfile', '__rocksProfile']) if (W[k]) out[k] = { visibleInstances: W[k].visibleInstances, totalInstances: W[k].totalInstances, vegDrawCalls: W[k].vegDrawCalls, drawCalls: W[k].drawCalls }
        return out
      })()`)
      const restored = await page.evaluate(`(() => {
        const s = window.__${name === 'vegetation' ? 'veg' : name}
        s.applyOcclusion(new Set())
        return true
      })()`)
      const back = await sampleFrames(page, FRAMES, `${name} restored`)
      results[name] = { asked: hid.asked, hidden, back, profAfter, restored }
    }

    results.__baseline2__ = await sampleFrames(page, FRAMES, 'baseline again (drift check)')

    console.log('[occ-attr] ---- upper bound on draw reduction per subsystem ----')
    const b1 = results.__baseline__.median
    const b2 = results.__baseline2__.median
    console.log(`[occ-attr] baseline drift: ${b1} -> ${b2} (delta ${b1 === null || b2 === null ? 'n/a' : (b2 - b1).toFixed(2)})`)
    let anyNonZero = false
    for (const name of ['vegetation', 'rocks', 'grass']) {
      const r = results[name]
      const delta = (b1 === null || r.hidden.median === null) ? null : r.hidden.median - b1
      const restoredDelta = (b2 === null || r.back.median === null) ? null : r.back.median - b1
      if (delta !== null && Math.abs(delta) > 0) anyNonZero = true
      console.log(`[occ-attr] ${name}: cells=${r.asked} draws ${b1} -> ${r.hidden.median} (delta ${delta === null ? 'n/a' : delta.toFixed(2)}) restored=${r.back.median} (vs baseline ${restoredDelta === null ? 'n/a' : restoredDelta.toFixed(2)})`)
      console.log(`[occ-attr] ${name} profiles while hidden: ${JSON.stringify(r.profAfter)}`)
    }

    await browser.close().catch(() => {})
    server.stop()
    console.log(`[occ-attr] RESULT: PASS cells=${totalCells} instances=${totalInstances} baselineDraws=${b1} baselineDraws2=${b2} anySubsystemDrawReduction=${anyNonZero}`)
    process.exit(0)
  } catch (e) {
    console.error('[occ-attr] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
