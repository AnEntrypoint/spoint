#!/usr/bin/env node
// Live instrument, not a fixture: boots the real server and the real browser and reads
// the occlusion population off the running scene. Reports counted units only -- no
// timings are read anywhere in this file, and no GPU pass duration is ever cited.
//
// What it answers: how many entities each occlusion system can actually cull in a
// shipped world, and whether each system's candidate gate is reached.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuModeFlag, gpuLaunchArgs } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import { assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE } from './lib/served-client-root.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3149')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const FRAMES = Number(flag('frames', '20'))
const SETTLE_MS = Number(flag('settle', '6000'))
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const BACKEND = flag('backend', 'webgpu')

const GPU_MODE = gpuModeFlag('gpu', 'accelerated')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__modelPool && window.__sceneOcclusion`

// Counts draws per frame off three's own info, so the number is the authoritative
// field for whichever backend booted (wgpuDrawsPerFrame / glDrawCallsPerFrame).
const PROBE = `(() => {
  const W = window
  if (W.__occPopProbe) return
  const p = { frames: 0, draws: 0, hooked: false }
  W.__occPopProbe = p
  function tick() {
    const r = W.__app && W.__app.renderer
    if (r && r.info) {
      if (!p.hooked && r.info.render) p.hooked = true
      const d = r.info.render.drawCalls !== undefined ? r.info.render.drawCalls : r.info.render.calls
      if (Number.isFinite(d)) { p.draws += d }
      p.frames++
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const READ_EXPR = `(() => {
  const W = window
  const mp = W.__modelPool
  const so = W.__sceneOcclusion
  const pool = mp && mp.pool
  const tier = pool && (pool._occlusionTier || null)
  // ModelPool keeps its entities in a Set of Entity objects, not a Map: an id/url
  // pair can only be read off the entity itself.
  const entities = []
  if (pool && pool._entities) {
    for (const e of pool._entities) {
      entities.push({ id: (e && (e.id || e.uuid)) || null, url: (e && e.asset && e.asset.url) || null })
    }
  }
  const subCounts = {}
  for (const name of ['vegetation', 'rocks', 'grass']) {
    const sys = W.__veg && name === 'vegetation' ? W.__veg : (W.__rocks && name === 'rocks' ? W.__rocks : (W.__grass && name === 'grass' ? W.__grass : null))
    let n = null, instances = null
    try { if (sys && sys.getOcclusionCandidates) n = sys.getOcclusionCandidates().length } catch (_) { n = 'threw' }
    try { if (sys && sys.totalInstances !== undefined) instances = sys.totalInstances } catch (_) {}
    subCounts[name] = { cells: n, instances }
  }
  const probe = W.__occPopProbe || { frames: 0, draws: 0 }
  return {
    rendererIsWebGPU: !!(W.__app && W.__app.renderer && W.__app.renderer.isWebGPURenderer),
    poolEntityCount: pool && pool._entities ? pool._entities.size : null,
    poolEntities: entities,
    occlusionCandidates: mp && mp.getCandidateCount ? mp.getCandidateCount() : null,
    occlusionMinCandidates: pool ? pool._occlusionMinCandidates : null,
    occlusionSkippedBelowMin: pool ? (pool._occlusionSkippedBelowMin || 0) : null,
    useOcclusionQuery: pool ? !!pool._useOcclusionQuery : null,
    tierInstalled: !!tier,
    tierCtor: tier ? (tier.constructor && tier.constructor.name) : null,
    tierStats: tier && tier.stats ? JSON.parse(JSON.stringify(tier.stats)) : null,
    adapterStats: mp && mp.getStats ? (mp.getStats().occlusion || null) : null,
    sceneCandidateCount: so && so.getCandidateCount ? so.getCandidateCount() : null,
    sceneSupported: so && so.supported ? so.supported() : null,
    sceneStats: so && so.getStats ? JSON.parse(JSON.stringify(so.getStats())) : null,
    subCounts,
    probeFrames: probe.frames,
    probeDraws: probe.draws,
    worldModelUrls: (W.__app && W.__app.worldDef && W.__app.worldDef._modelUrls) || null,
  }
})()`

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[occ-population] booting real server on ${PORT} world=${process.env.WORLD} backend=${BACKEND}`)
  rebuildIfRequested('occ-population')
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ args: LAUNCH_ARGS })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : (BACKEND === 'webgl' ? `${PARAMS}&legacygl=1` : PARAMS)
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}`
    console.log(`[occ-population] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      console.error('[occ-population] RESULT: FAIL -- page never became ready with both occlusion systems exposed')
      process.exit(1)
    }
    console.log(`[occ-population] ready @ ${Date.now() - t0}ms`)

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'occ-population' })
    console.log(`[occ-population] served ${clientRootTag(servedRoot)}`)

    const gpu = await assertGpu(page, { requireAccelerated: GPU_MODE.accelerated, expectVendor: GPU_MODE.vendor || null })
    console.log(`[occ-population] rasterizer=${gpu.rasterizer} adapter=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor) : 'none'}`)

    // `vendorGpuArgs` pins the adapter, but Chrome reports "accelerated" even on an
    // unresolvable LUID, so the arm is only real if the renderer actually came up WebGPU.
    if (BACKEND === 'webgpu') {
      const wa = await page.evaluate(`(() => { const r = window.__app && window.__app.renderer; const b = r && r.backend; return { hasRendererInfo: !!window.__rendererInfo, isWebGPURenderer: !!(r && r.isWebGPURenderer), backendIsWebGPU: !!(b && b.isWebGPUBackend) } })()`)
      console.log(`[occ-population] webgpu arm assert: ${JSON.stringify(wa)}`)
      if (!wa.isWebGPURenderer || !wa.backendIsWebGPU || !wa.hasRendererInfo) {
        console.error('[occ-population] RESULT: FAIL -- webgpu arm requested but the renderer did not come up WebGPU')
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
    console.log(`[occ-population] boot:scenery-built ${scenery ? 'reached' : 'UNREACHED'}`)
    await new Promise(r => setTimeout(r, SETTLE_MS))

    await page.evaluate(`(() => { const p = window.__occPopProbe; if (p) { p.frames = 0; p.draws = 0 } return true })()`)
    const t1 = Date.now()
    while (Date.now() - t1 < TIMEOUT_MS) {
      const n = await page.evaluate(`window.__occPopProbe.frames`).catch(() => 0)
      if (n >= FRAMES) break
      await new Promise(r => setTimeout(r, 100))
    }
    const out = await page.evaluate(READ_EXPR)
    const perFrame = out.probeFrames > 0 ? +(out.probeDraws / out.probeFrames).toFixed(2) : null

    console.log(`[occ-population] renderer isWebGPURenderer=${out.rendererIsWebGPU} drawsPerFrame=${perFrame} over ${out.probeFrames} frames`)
    console.log(`[occ-population] modelPool entities=${out.poolEntityCount} urls=${JSON.stringify(out.poolEntities.map(e => e.url))}`)
    console.log(`[occ-population] modelPool occlusion: useOcclusionQuery=${out.useOcclusionQuery} tierInstalled=${out.tierInstalled} tier=${out.tierCtor} minCandidates=${out.occlusionMinCandidates} candidates=${out.occlusionCandidates} skippedBelowMin=${out.occlusionSkippedBelowMin}`)
    console.log(`[occ-population] modelPool tier stats: ${JSON.stringify(out.tierStats)}`)
    console.log(`[occ-population] modelPool adapter occlusion: ${JSON.stringify(out.adapterStats)}`)
    console.log(`[occ-population] sceneOcclusion supported=${out.sceneSupported} candidates=${out.sceneCandidateCount} subsystems=${JSON.stringify(out.sceneStats && out.sceneStats.subsystems)}`)
    console.log(`[occ-population] sceneOcclusion stats: ${JSON.stringify(out.sceneStats)}`)
    console.log(`[occ-population] scene subsystems (cells / instances): ${JSON.stringify(out.subCounts)}`)
    console.log(`[occ-population] world _modelUrls: ${JSON.stringify(out.worldModelUrls)}`)

    const gateReached = out.occlusionCandidates >= out.occlusionMinCandidates
    console.log(`[occ-population] modelPool gate reached: ${gateReached} (${out.occlusionCandidates} >= ${out.occlusionMinCandidates})`)
    const sceneGate = out.sceneCandidateCount >= 32
    console.log(`[occ-population] sceneOcclusion gate reached: ${sceneGate} (${out.sceneCandidateCount} >= 32)`)

    await browser.close().catch(() => {})
    server.stop()
    console.log(`[occ-population] RESULT: PASS world=${WORLD} poolEntities=${out.poolEntityCount} poolCandidates=${out.occlusionCandidates} sceneCandidates=${out.sceneCandidateCount} drawsPerFrame=${perFrame}`)
    process.exit(0)
  } catch (e) {
    console.error('[occ-population] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
