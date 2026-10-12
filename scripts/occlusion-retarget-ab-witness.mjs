#!/usr/bin/env node
// Live instrument, not a fixture: the paired A/B the retarget has to be judged on.
//
// One page load, one GPU lock hold, one continuous walk, and the two arms interleaved
// inside it:
//   arm ON  -- vegetation/rocks/grass registered with sceneOcclusion, so the retargeted
//              tier is asked to cull the population it owns.
//   arm OFF -- the same three subsystems unregistered, so sceneOcclusion falls below its
//              candidate gate and issues nothing.
//
// Interleaving is the point. A draw count taken on this work tree minutes apart means
// nothing (74 in one lane, 187.86 in another), so the only reading that carries is two
// arms measured against each other inside one hold, with the ON arm's own counters
// proving the cull actually ran rather than being assumed to have run.
//
// Counted units only: draw calls per frame off three's own info, plus the cull's own
// counters. No GPU pass timing is read anywhere in this file.
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
const numeric = (name, dflt) => {
  const raw = flag(name, null)
  if (raw === null) return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? n : dflt
}

const PORT = flag('port', '3158')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const WINDOW_FRAMES = numeric('frames', '60')
const WINDOWS = numeric('windows', '5')
const SETTLE_MS = numeric('settle', '6000')
const TIMEOUT_MS = numeric('timeout', '420000')
const BACKEND = flag('backend', 'webgpu')
const WALK = flag('walk', '1') !== '0'

const GPU_MODE = gpuModeFlag('gpu', 'accelerated')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__sceneOcclusion && window.__veg && window.__rocks && window.__grass`

// Per-frame samples of every counted unit, so a median -- not a mean over a window whose
// length the host load decides -- is what the two arms are compared on.
const PROBE = `(() => {
  const W = window
  if (W.__occAbProbe) return
  const p = { samples: [], recording: false }
  W.__occAbProbe = p
  function tick() {
    const r = W.__app && W.__app.renderer
    if (r && r.info && p.recording) {
      const d = r.info.render.drawCalls !== undefined ? r.info.render.drawCalls : r.info.render.calls
      if (Number.isFinite(d)) {
        const so = W.__sceneOcclusion
        const st = so && so.getStats ? so.getStats() : {}
        p.samples.push({
          draws: d,
          queried: st.queriedThisFrame || 0,
          tested: st.entityTested || 0,
          occluded: st.entityOccluded || 0,
          hiddenKeys: so && so.snapshotOccludedKeys ? so.snapshotOccludedKeys().size : 0,
          flips: st.flips || 0,
          anomaly: st.anomalyTrips || 0,
          starved: st.readbackStarved || 0,
          slice: st.sliceSize || 0,
          reverify: st.reverify || 0,
          // A fail-open is a hidden candidate forced back to visible because its verdict
          // went stale. That IS the pop this cull must not produce, so it is counted per
          // frame rather than inferred from a screenshot.
          failOpens: st.failOpens || 0,
          oldestPending: st.oldestPendingFrames || 0,
          vegVis: (W.__vegProfile && W.__vegProfile.visibleInstances) || 0,
        })
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  W.__occAbReset = () => { p.samples.length = 0 }
  W.__occAbRec = (on) => { p.recording = !!on }
})()`

// The two arms differ in exactly one thing: whether the tier is allowed to issue. The
// OFF arm wraps `setMaxQueriesPerFrame` -- the same entry point the frame-time budget
// allocator already drives -- and forces 0 through it, so no subsystem is unregistered
// and the cull's verdict state survives the arm change. Unregistering instead would
// release every candidate and restart discovery in every ON window, which is a different
// experiment: it would measure how fast the cull boots, not what it saves.
const SET_ARM = (on) => `(() => {
  const so = window.__sceneOcclusion
  if (!so.__abOrigSet) {
    so.__abOrigSet = so.setMaxQueriesPerFrame.bind(so)
    so.__abReal = so.getMaxQueriesPerFrame()
    so.setMaxQueriesPerFrame = (n) => { so.__abReal = n; so.__abOrigSet(window.__occAbForceOff ? 0 : n) }
  }
  window.__occAbForceOff = ${on ? 'false' : 'true'}
  so.__abOrigSet(window.__occAbForceOff ? 0 : (so.__abReal || 0))
  const b = window.__occlusionQueryBudget ? window.__occlusionQueryBudget.getStats() : null
  return { candidates: so.getCandidateCount(), budget: so.getMaxQueriesPerFrame(), realBudget: so.__abReal, alloc: b }
})()`

function median(arr) {
  if (!arr.length) return null
  const a = arr.slice().sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0)
const max = (rows, k) => rows.reduce((a, r) => Math.max(a, r[k] || 0), 0)

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[occ-ab] booting real server on ${PORT} world=${process.env.WORLD} backend=${BACKEND}`)
  rebuildIfRequested('occ-ab')
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ headless: false, args: LAUNCH_ARGS, owner: 'occ-ab-r270', leaseWaitMs: numeric('lease-wait', '150000'), leaseTtlMs: 600000 })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : (BACKEND === 'webgl' ? `${PARAMS}&legacygl=1` : PARAMS)
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}`
    console.log(`[occ-ab] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      console.error('[occ-ab] RESULT: FAIL -- page never became ready with all three occlusion subsystems exposed')
      process.exit(1)
    }
    console.log(`[occ-ab] ready @ ${Date.now() - t0}ms`)

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'occ-ab' })
    console.log(`[occ-ab] served ${clientRootTag(servedRoot)}`)

    const gpu = await assertGpu(page, { requireAccelerated: GPU_MODE.accelerated, expectVendor: GPU_MODE.vendor || null })
    console.log(`[occ-ab] rasterizer=${gpu.rasterizer} adapter=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor) : 'none'}`)

    const wa = await page.evaluate(`(() => { const r = window.__app && window.__app.renderer; const b = r && r.backend; return { hasRendererInfo: !!window.__rendererInfo, isWebGPURenderer: !!(r && r.isWebGPURenderer), backendIsWebGPU: !!(b && b.isWebGPUBackend) } })()`)
    console.log(`[occ-ab] webgpu arm assert: ${JSON.stringify(wa)}`)
    if (BACKEND === 'webgpu' && (!wa.isWebGPURenderer || !wa.backendIsWebGPU || !wa.hasRendererInfo)) {
      console.error('[occ-ab] RESULT: FAIL -- webgpu arm requested but the renderer did not come up WebGPU')
      process.exit(1)
    }

    const built = `performance.getEntriesByType('mark').some(m => m.name === 'boot:scenery-built')`
    const tS = Date.now()
    let scenery = false
    while (Date.now() - tS < TIMEOUT_MS) {
      scenery = await page.evaluate(built).catch(() => false)
      if (scenery) break
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[occ-ab] boot:scenery-built ${scenery ? 'reached' : 'UNREACHED'} -- settling ${SETTLE_MS}ms`)
    await new Promise(r => setTimeout(r, SETTLE_MS))

    const tierInfo = await page.evaluate(`(() => { const s = window.__sceneOcclusion.getStats(); return { tier: s.tier, kind: window.__sceneOcclusion.tierKind ? window.__sceneOcclusion.tierKind() : null, candidates: s.candidateCount, supported: window.__sceneOcclusion.supported(), subsystems: s.subsystems } })()`)
    console.log(`[occ-ab] sceneOcclusion tier=${tierInfo.tier} kind=${tierInfo.kind} supported=${tierInfo.supported} candidates=${tierInfo.candidates} subsystems=${JSON.stringify(tierInfo.subsystems)}`)
    if (BACKEND === 'webgpu' && tierInfo.kind !== 'webgpu-hiz') {
      console.error(`[occ-ab] RESULT: FAIL -- the retarget did not install: kind=${tierInfo.kind} tier=${tierInfo.tier}`)
      process.exit(1)
    }

    // The camera-still gate is what decides whether this system runs at all, so the walk
    // is not decoration: without it `maxQueriesPerFrame` is 0 and both arms are "off".
    if (WALK) {
      await page._send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, text: 'w' })
      console.log('[occ-ab] walking: KeyW down')
    }

    const arms = { on: [], off: [] }
    const windows = []
    for (let w = 0; w < WINDOWS; w++) {
      for (const arm of ['off', 'on']) {
        const set = await page.evaluate(SET_ARM(arm === 'on'))
        console.log(`[occ-ab]   arm=${arm} budget=${set.budget} realBudget=${set.realBudget} alloc=${JSON.stringify(set.alloc)}`)
        await page.evaluate(`(() => { window.__occAbReset(); window.__occAbRec(true); return true })()`)
        const tW = Date.now()
        while (Date.now() - tW < TIMEOUT_MS) {
          const n = await page.evaluate(`window.__occAbProbe.samples.length`).catch(() => 0)
          if (n >= WINDOW_FRAMES) break
          await new Promise(r => setTimeout(r, 40))
        }
        const res = await page.evaluate(`(() => { const p = window.__occAbProbe; const s = p.samples.slice(); window.__occAbRec(false); return s })()`)
        // Per-band census: the cull is allowed to remove instances, never to remove the
        // near band, so the band split is read per window rather than averaged away.
        const bands = await page.evaluate(`(() => {
          const W = window
          const v = W.__vegProfile || {}
          const g = W.__grassProfile || {}
          return {
            vegVisible: v.visibleInstances ?? null, vegTotal: v.totalInstances ?? null,
            vegMeshBands: v.meshTierInstances ? v.meshTierInstances.slice() : null,
            vegLeafBands: v.leafTierInstances ? v.leafTierInstances.slice() : null,
            vegDrawCalls: v.vegDrawCalls ?? null,
            grassTotal: g.totalInstances ?? null,
            rocksTotal: (W.__rocks && W.__rocks.totalInstances) ?? null,
            grassTotalInst: (W.__grass && W.__grass.totalInstances) ?? null,
          }
        })()`)
        arms[arm].push(res)
        windows.push({ w, arm, n: res.length, candidates: set.candidates, medianDraws: median(res.map(r => r.draws)), bands })
        console.log(`[occ-ab]   window ${w} arm=${arm} frames=${res.length} medianDraws=${median(res.map(r => r.draws))} queriedSum=${sum(res, 'queried')} testedMax=${max(res, 'tested')} occludedMax=${max(res, 'occluded')} hiddenKeysMax=${max(res, 'hiddenKeys')} sliceMax=${max(res, 'slice')} reverifyMax=${max(res, 'reverify')} starved=${sum(res, 'starved')} anomaly=${sum(res, 'anomaly')} flips=${sum(res, 'flips')} failOpens=${sum(res, 'failOpens')} oldestPending=${max(res, 'oldestPending')}`)
        console.log(`[occ-ab]     bands arm=${arm}: ${JSON.stringify(bands)}`)
      }
    }

    if (WALK) await page._send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 })

    const flat = (arm) => arms[arm].flat()
    const report = (arm) => {
      const rows = flat(arm)
      return {
        frames: rows.length,
        medianDraws: median(rows.map(r => r.draws)),
        meanDraws: rows.length ? +(rows.reduce((a, r) => a + r.draws, 0) / rows.length).toFixed(2) : null,
        queriedSum: sum(rows, 'queried'),
        testedMax: max(rows, 'tested'),
        occludedMax: max(rows, 'occluded'),
        hiddenKeysMax: max(rows, 'hiddenKeys'),
        starvedSum: sum(rows, 'starved'),
        anomalySum: sum(rows, 'anomaly'),
        flipsSum: sum(rows, 'flips'),
        failOpensSum: sum(rows, 'failOpens'),
        oldestPendingMax: max(rows, 'oldestPending'),
        vegVisMedian: median(rows.map(r => r.vegVis)),
      }
    }
    const on = report('on')
    const off = report('off')
    console.log(`[occ-ab] arm OFF: ${JSON.stringify(off)}`)
    console.log(`[occ-ab] arm ON : ${JSON.stringify(on)}`)
    const delta = (on.medianDraws === null || off.medianDraws === null) ? null : on.medianDraws - off.medianDraws
    console.log(`[occ-ab] draw delta (ON - OFF): ${delta === null ? 'n/a' : delta.toFixed(2)} draws/frame (median)`)
    console.log(`[occ-ab] cull actually ran: queriedSum=${on.queriedSum} testedMax=${on.testedMax} (a zero here means the arm is void, not a result)`)

    // Per-window ON medians, so a drift across the run is visible instead of hidden by a
    // single median over eight seconds of walking.
    console.log(`[occ-ab] per-window ON medians: ${JSON.stringify(windows.filter(x => x.arm === 'on').map(x => x.medianDraws))}`)
    console.log(`[occ-ab] per-window OFF medians: ${JSON.stringify(windows.filter(x => x.arm === 'off').map(x => x.medianDraws))}`)

    await browser.close().catch(() => {})
    server.stop()
    const ran = on.queriedSum > 0
    console.log(`[occ-ab] RESULT: ${ran ? 'PASS' : 'FAIL'} tier=${tierInfo.kind} candidates=${tierInfo.candidates} offMedianDraws=${off.medianDraws} onMedianDraws=${on.medianDraws} delta=${delta === null ? 'n/a' : delta.toFixed(2)} cullRan=${ran} hiddenKeysMax=${on.hiddenKeysMax} occludedMax=${on.occludedMax}`)
    process.exit(ran ? 0 : 1)
  } catch (e) {
    console.error('[occ-ab] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
