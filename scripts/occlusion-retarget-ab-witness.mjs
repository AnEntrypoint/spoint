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
// Counted units only, and the draw figure is the one perf-run.mjs pins as
// `drawsInstrument.authoritativeField` -- `wgpuDrawsPerFrame` on the WebGPU arm,
// `glDrawCallsPerFrame` on the legacy GL arm, i.e. draws submitted at the API boundary.
// three's own info.render counter is sampled alongside it but is a different quantity:
// the render graph resets info per pass, so a raw rAF-time read is the LAST pass only.
// No GPU pass timing is read anywhere in this file.
import { resolve, dirname, join } from 'node:path'
import { mkdirSync, readdirSync } from 'node:fs'
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
// Camera motion is the load the no-pop claim has to survive: a verdict only goes stale
// while the camera is moving, so a still camera cannot produce the pop and cannot refute
// it either. Mouse sweeps ride every window next to the walk.
const TURN = flag('turn', '1') !== '0'
const SHOTS = flag('shots', '0') !== '0'
const SHOT_DIR = flag('shot-dir', resolve(ROOT, '.gm/witness-out/occ-ab-r270-74'))
// Only these subsystems stay registered. The draw budget each one can move was measured by
// hiding every cell of it at once (rocks 112, vegetation 45, grass 0), so whether the cull
// reaches one of them is a per-subsystem question and not one total delta.
const ONLY = flag('only', null)

const GPU_MODE = gpuModeFlag('gpu', 'accelerated')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__sceneOcclusion && window.__veg && window.__rocks && window.__grass`

// Per-frame samples of every counted unit, so a median -- not a mean over a window whose
// length the host load decides -- is what the two arms are compared on.
const PROBE = `(() => {
  const W = window
  if (W.__occAbProbe) return
  const p = { samples: [], recording: false, sawApiDraws: false }
  W.__occAbProbe = p
  let prevApiW = 0, prevApiG = 0, prevThree = 0, prevVp = null, prevPos = null
  // three's info is reset by the render graph once per pass, so the frame's real total is
  // the sum over every reset, not the value left standing when rAF fires.
  const hookRenderer = (renderer) => {
    if (!renderer || renderer.__abHooked || !renderer.info || !W.__abDraws) return
    renderer.__abHooked = true
    const info = renderer.info
    const origReset = info.reset
    info.reset = function () {
      W.__abDraws.three += info.render.drawCalls !== undefined ? info.render.drawCalls : info.render.calls
      return origReset.apply(this, arguments)
    }
  }
  // Two independent motion signals, because the cull's own gate is "the camera has not
  // moved", and a signal that is absent reads exactly like a camera that is still. The
  // view-projection is the stronger one (it covers rotation too); the player position
  // covers the case where __lastVP is not published at all.
  const vpSig = () => {
    const vp = W.__lastVP
    const e = vp && vp.elements ? vp.elements : vp
    if (!e || typeof e.length !== 'number' || typeof e[0] !== 'number') return null
    let s = 0
    for (let i = 0; i < e.length; i += 5) s += e[i] * (i + 1)
    return s
  }
  // __lastVP is published by mapspinner's GL renderer only, so on the WebGPU arm it is
  // absent by construction and the position fallbacks are the signal that carries.
  const posSig = () => {
    const a = W.__app
    if (!a) return null
    const ls = a.client && a.client.getLocalState && a.client.getLocalState()
    const st = a.client && a.client.state
    const cands = [
      ls && ls.position,
      st && st.local && st.local.position,
      st && st.players && st.players[0] && st.players[0].position,
      a.localPlayer && a.localPlayer.position,
      a.player && a.player.position,
      a.engine && a.engine.client && a.engine.client.getLocalState && a.engine.client.getLocalState().position,
      W.__spoint && W.__spoint.player && W.__spoint.player.position,
    ]
    for (const q of cands) {
      if (q && typeof q.x === 'number' && typeof q.z === 'number') return q.x + q.z
    }
    return null
  }
  function tick() {
    const r = W.__app && W.__app.renderer
    if (r) hookRenderer(r)
    const c = W.__abDraws || { wgpu: 0, gl: 0, three: 0 }
    const dW = c.wgpu - prevApiW, dG = c.gl - prevApiG, dT = c.three - prevThree
    prevApiW = c.wgpu; prevApiG = c.gl; prevThree = c.three
    const vp = vpSig()
    const ps = posSig()
    const vpStill = vp === null || (prevVp !== null && Math.abs(vp - prevVp) < 1e-9)
    const posStill = ps === null || (prevPos !== null && Math.abs(ps - prevPos) < 0.01)
    if (vp !== null) prevVp = vp
    if (ps !== null) prevPos = ps
    if (r && r.info && p.recording) {
      const so = W.__sceneOcclusion
      const st = so && so.getStats ? so.getStats() : {}
      const api = c.wgpuSaw ? dW : dG
      if (api > 0) p.sawApiDraws = true
      p.samples.push({
        apiDraws: api,
        // The camera-motion witness: a frame whose view-projection is unchanged is a frame
        // the cull was not asked to re-decide anything for. null = the signal was absent,
        // which is NOT the same claim as "the camera was still".
        camMoved: vp === null ? null : (vpStill ? 0 : 1),
        posMoved: ps === null ? null : (posStill ? 0 : 1),
        vpNull: vp === null ? 1 : 0,
        posNull: ps === null ? 1 : 0,
        draws: dT,
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
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  W.__occAbReset = () => { p.samples.length = 0; p.sawApiDraws = false }
  W.__occAbRec = (on) => { p.recording = !!on }
  W.__occAbSaw = () => p.sawApiDraws
})()`

// Draws counted where the driver is actually talked to, not where three counts them:
// GPU* render-pass draw* on the WebGPU arm, GL draw* on the legacy arm. This is the same
// boundary perf-run.mjs reports as `wgpuDrawsPerFrame` / `glDrawCallsPerFrame` and picks
// between with `drawsInstrument.authoritativeField`, so the A/B delta is read off it.
const DRAW_API_HOOK = `(() => {
  const W = window
  if (W.__abDraws) return
  W.__abDraws = { wgpu: 0, gl: 0, three: 0, wgpuSaw: false }
  const c = W.__abDraws
  const WGPU_DRAWF = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
  const WGPU_PROTOS = ['GPUDevice', 'GPUQueue', 'GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder', 'GPUCanvasContext']
  const DRAWF = new Set(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'multiDrawElementsWEBGL', 'multiDrawArraysWEBGL'])
  const patchProto = (proto) => {
    if (!proto) return
    const names = Object.getOwnPropertyNames(proto)
    for (let i = 0; i < names.length; i++) {
      const k = names[i]
      if (k === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(proto, k)
      if (!d || typeof d.value !== 'function') continue
      const orig = d.value
      Object.defineProperty(proto, k, {
        value: function () { if (WGPU_DRAWF.has(k)) { c.wgpu++; c.wgpuSaw = true } return orig.apply(this, arguments) },
        writable: true, configurable: true,
      })
    }
  }
  for (let i = 0; i < WGPU_PROTOS.length; i++) if (W[WGPU_PROTOS[i]] && W[WGPU_PROTOS[i]].prototype) patchProto(W[WGPU_PROTOS[i]].prototype)
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__abWrapped) {
      ctx.__abWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      const names = Object.getOwnPropertyNames(proto)
      for (let i = 0; i < names.length; i++) {
        const k = names[i]
        if (k === 'constructor') continue
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () { if (DRAWF.has(k)) c.gl++; return orig.apply(this, arguments) },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
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

// Pixel classification of the per-arm screenshots, per depth band. A cull that blanks a
// band, or pops an object in and out of one, changes the band's luminance spread and its
// colour variety; a cull that removes only genuinely hidden far geometry leaves the near
// band alone. This is a classification, not an eye: say so when reporting it.
async function classifyShots() {
  let sharp
  try { sharp = (await import('sharp')).default } catch (e) { console.log(`[occ-ab] shot classify skipped: sharp unavailable (${e.message})`); return }
  const files = readdirSync(SHOT_DIR).filter(f => f.endsWith('.png')).sort()
  if (!files.length) { console.log('[occ-ab] shot classify skipped: no PNGs'); return }
  const BANDS = [['far', 0, 1 / 3], ['mid', 1 / 3, 2 / 3], ['near', 2 / 3, 1]]
  for (const f of files) {
    try {
      const img = sharp(join(SHOT_DIR, f))
      const meta = await img.metadata()
      const W = meta.width || 0, H = meta.height || 0
      const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
      const ch = info.channels
      const out = {}
      for (const [name, a, b] of BANDS) {
        const y0 = Math.floor(H * a), y1 = Math.floor(H * b)
        let n = 0, sl = 0, sl2 = 0, chroma = 0
        const colours = new Set()
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < W; x += 2) {
            const i = (y * W + x) * ch
            const r = data[i], g = data[i + 1], bl = data[i + 2]
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl
            n++; sl += l; sl2 += l * l
            const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl)
            if (mx - mn > 8) chroma++
            if (colours.size < 70000) colours.add((r >> 3 << 10) | (g >> 3 << 5) | (bl >> 3))
          }
        }
        const mean = n ? sl / n : 0
        const sd = n ? Math.sqrt(Math.max(0, sl2 / n - mean * mean)) : 0
        out[name] = { meanLum: +mean.toFixed(3), sdLum: +sd.toFixed(3), chromaFrac: n ? +(chroma / n).toFixed(6) : 0, distinctColours: colours.size, px: n }
      }
      console.log(`[occ-ab] shot ${f} ${W}x${H} ${JSON.stringify(out)}`)
    } catch (e) { console.log(`[occ-ab] shot ${f} classify failed: ${e.message}`) }
  }
}

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
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: DRAW_API_HOOK })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true })
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

    // A page that built zero vegetation is a different scene from the one the upper bound
    // was measured on, and it draws a third of the calls, so refuse it rather than report
    // a delta between two different worlds.
    const populous = `(() => { const v = window.__veg; const r = window.__rocks; return { veg: v ? (v.totalInstances || 0) : -1, rocks: r ? (r.totalInstances || 0) : -1 } })()`
    const tP = Date.now()
    let pop = { veg: -1, rocks: -1 }
    while (Date.now() - tP < TIMEOUT_MS) {
      pop = await page.evaluate(populous).catch(() => ({ veg: -1, rocks: -1 }))
      if (pop.veg > 1000) break
      await new Promise(r => setTimeout(r, 500))
    }
    console.log(`[occ-ab] population veg=${pop.veg} rocks=${pop.rocks} after ${Date.now() - tP}ms`)
    if (pop.veg <= 1000) {
      console.error(`[occ-ab] RESULT: FAIL -- vegetation built ${pop.veg} instances, so this page is not the scene the draw budget was measured on`)
      process.exit(1)
    }

    const CX = (DEFAULT_VIEWPORT.width || 1280) / 2, CY = (DEFAULT_VIEWPORT.height || 720) / 2
    if (ONLY) {
      const keep = ONLY.split(',').map(s => s.trim()).filter(Boolean)
      for (const name of tierInfo.subsystems || []) {
        if (keep.includes(name)) continue
        await page.evaluate(`(() => { window.__sceneOcclusion.unregister(${JSON.stringify(name)}); return true })()`).catch(() => {})
      }
      const left = await page.evaluate(`window.__sceneOcclusion.getCandidateCount()`).catch(() => null)
      console.log(`[occ-ab] --only=${ONLY}: kept ${JSON.stringify(keep)} of ${JSON.stringify(tierInfo.subsystems)}, candidates now ${left}`)
    }

    // Pointer lock, so the mouse sweeps actually rotate the camera. Without it a mouse
    // move is a cursor move and the view never changes, which leaves the cull's
    // camera-still gate closed and both arms issuing nothing.
    await page.mouse.move(CX, CY).catch(() => {})
    await page.mouse.down().catch(() => {})
    await page.mouse.up().catch(() => {})
    await page.evaluate(`(() => { const el = document.querySelector('canvas'); if (el && el.requestPointerLock) { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}) } return !!document.pointerLockElement })()`).catch(() => {})
    console.log(`[occ-ab] pointerLock=${await page.evaluate(`!!document.pointerLockElement`).catch(() => 'unknown')}`)

    const tierInfo = await page.evaluate(`(() => { const s = window.__sceneOcclusion.getStats(); return { tier: s.tier, kind: window.__sceneOcclusion.tierKind ? window.__sceneOcclusion.tierKind() : null, candidates: s.candidateCount, supported: window.__sceneOcclusion.supported(), subsystems: s.subsystems } })()`)
    console.log(`[occ-ab] sceneOcclusion tier=${tierInfo.tier} kind=${tierInfo.kind} supported=${tierInfo.supported} candidates=${tierInfo.candidates} subsystems=${JSON.stringify(tierInfo.subsystems)}`)
    if (BACKEND === 'webgpu' && tierInfo.kind !== 'webgpu-hiz') {
      console.error(`[occ-ab] RESULT: FAIL -- the retarget did not install: kind=${tierInfo.kind} tier=${tierInfo.tier}`)
      process.exit(1)
    }

    // The camera-still gate is what decides whether this system runs at all, so the walk
    // is not decoration: without it `maxQueriesPerFrame` is 0 and both arms are "off".
    if (WALK) {
      // page.keyboard, not a hand-rolled Input.dispatchKeyEvent: the library sends
      // nativeVirtualKeyCode too, and without it the game's input never sees the key and
      // the player stands still -- which makes both arms issue nothing and the A/B void.
      await page.keyboard.down('KeyW')
      console.log('[occ-ab] walking: KeyW down')
    }

    const arms = { on: [], off: [] }
    const windows = []
    const sweep = async (i) => {
      if (!TURN) return
      // A strafe too, so a player blocked forward still translates, and a mouse sweep so
      // the view rotates: the cull's gate is the camera, and either alone can be blocked.
      const x = CX + (((i % 24) - 12) * 14)
      await page.mouse.move(x, CY).catch(() => {})
    }
    for (let w = 0; w < WINDOWS; w++) {
      const strafe = w % 2 ? 'KeyA' : 'KeyD'
      if (WALK) await page.keyboard.down(strafe).catch(() => {})
      for (const arm of ['off', 'on']) {
        const set = await page.evaluate(SET_ARM(arm === 'on'))
        console.log(`[occ-ab]   arm=${arm} budget=${set.budget} realBudget=${set.realBudget} alloc=${JSON.stringify(set.alloc)}`)
        await page.evaluate(`(() => { window.__occAbReset(); window.__occAbRec(true); return true })()`)
        const tW = Date.now()
        let mi = 0
        while (Date.now() - tW < TIMEOUT_MS) {
          const n = await page.evaluate(`window.__occAbProbe.samples.length`).catch(() => 0)
          if (n >= WINDOW_FRAMES) break
          await sweep(mi++)
          await new Promise(r => setTimeout(r, 40))
        }
        const res = await page.evaluate(`(() => { const p = window.__occAbProbe; const s = p.samples.slice(); window.__occAbRec(false); return s })()`)
        const sawApi = await page.evaluate(`window.__occAbSaw()`).catch(() => false)
        const shot = SHOTS ? join(SHOT_DIR, `w${w}-${arm}.png`) : null
        if (shot) await page.screenshot({ path: shot }).catch(e => console.error(`[occ-ab] shot failed: ${e.message}`))
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
        windows.push({ w, arm, n: res.length, candidates: set.candidates, medianDraws: median(res.map(r => r.draws)), medianApiDraws: median(res.map(r => r.apiDraws)), sawApi, bands })
        console.log(`[occ-ab]   window ${w} arm=${arm} frames=${res.length} medianApiDraws=${median(res.map(r => r.apiDraws))} medianThreeDraws=${median(res.map(r => r.draws))} camMovedFrames=${sum(res, 'camMoved')}/${res.length} queriedSum=${sum(res, 'queried')} testedMax=${max(res, 'tested')} occludedMax=${max(res, 'occluded')} hiddenKeysMax=${max(res, 'hiddenKeys')} sliceMax=${max(res, 'slice')} reverifyMax=${max(res, 'reverify')} starved=${sum(res, 'starved')} anomaly=${sum(res, 'anomaly')} flips=${sum(res, 'flips')} failOpens=${sum(res, 'failOpens')} oldestPending=${max(res, 'oldestPending')}`)
        console.log(`[occ-ab]     bands arm=${arm}: ${JSON.stringify(bands)}`)
      }
    }

    if (WALK) {
      await page.keyboard.up(WINDOWS % 2 ? 'KeyA' : 'KeyD').catch(() => {})
      await page.keyboard.up('KeyW').catch(() => {})
    }

    const flat = (arm) => arms[arm].flat()
    const report = (arm) => {
      const rows = flat(arm)
      return {
        frames: rows.length,
        medianApiDraws: median(rows.map(r => r.apiDraws)),
        meanApiDraws: rows.length ? +(rows.reduce((a, r) => a + r.apiDraws, 0) / rows.length).toFixed(2) : null,
        medianThreeDraws: median(rows.map(r => r.draws)),
        meanThreeDraws: rows.length ? +(rows.reduce((a, r) => a + r.draws, 0) / rows.length).toFixed(2) : null,
        camMovedFrames: sum(rows, 'camMoved'),
        posMovedFrames: sum(rows, 'posMoved'),
        vpNullFrames: sum(rows, 'vpNull'),
        posNullFrames: sum(rows, 'posNull'),
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
    const sawApi = windows.every(x => x.sawApi)
    const delta = (on.medianApiDraws === null || off.medianApiDraws === null) ? null : on.medianApiDraws - off.medianApiDraws
    const threeDelta = (on.medianThreeDraws === null || off.medianThreeDraws === null) ? null : on.medianThreeDraws - off.medianThreeDraws
    console.log(`[occ-ab] draw delta (ON - OFF), authoritativeField=${sawApi ? 'wgpuDrawsPerFrame' : 'glDrawCallsPerFrame'}: ${delta === null ? 'n/a' : delta.toFixed(2)} draws/frame (median)`)
    console.log(`[occ-ab] draw delta (ON - OFF), three info.render summed per frame: ${threeDelta === null ? 'n/a' : threeDelta.toFixed(2)} draws/frame (median)`)
    console.log(`[occ-ab] cull actually ran: queriedSum=${on.queriedSum} testedMax=${on.testedMax} (a zero here means the arm is void, not a result)`)
    // The no-pop claim, as counted units: every frame in which the camera's view-projection
    // changed, against every hidden candidate forced back to visible in those frames.
    console.log(`[occ-ab] pop witness: camMoved ON=${on.camMovedFrames}/${on.frames} (vpNull ${on.vpNullFrames}) OFF=${off.camMovedFrames}/${off.frames} (vpNull ${off.vpNullFrames}) posMoved ON=${on.posMovedFrames}/${on.frames} (posNull ${on.posNullFrames}) failOpens ON=${on.failOpensSum} OFF=${off.failOpensSum} flips ON=${on.flipsSum} OFF=${off.flipsSum} oldestPendingMax ON=${on.oldestPendingMax}`)

    // Per-window medians, so a drift across the run is visible instead of hidden by a
    // single median over eight seconds of walking.
    console.log(`[occ-ab] per-window ON medians (api): ${JSON.stringify(windows.filter(x => x.arm === 'on').map(x => x.medianApiDraws))}`)
    console.log(`[occ-ab] per-window OFF medians (api): ${JSON.stringify(windows.filter(x => x.arm === 'off').map(x => x.medianApiDraws))}`)
    console.log(`[occ-ab] per-window ON medians (three): ${JSON.stringify(windows.filter(x => x.arm === 'on').map(x => x.medianDraws))}`)
    console.log(`[occ-ab] per-window OFF medians (three): ${JSON.stringify(windows.filter(x => x.arm === 'off').map(x => x.medianDraws))}`)

    if (SHOTS) await classifyShots()

    await browser.close().catch(() => {})
    server.stop()
    const ran = on.queriedSum > 0
    // A zero draw reading on BOTH arms is an instrument that never counted, not a cull that
    // saved nothing, so it fails rather than reporting a delta of 0.
    const counted = on.medianApiDraws > 0 && off.medianApiDraws > 0
    const moved = Math.max(on.camMovedFrames, on.posMovedFrames) > 0 && Math.max(off.camMovedFrames, off.posMovedFrames) > 0
    const ok = ran && counted && moved
    console.log(`[occ-ab] RESULT: ${ok ? 'PASS' : 'FAIL'} tier=${tierInfo.kind} candidates=${tierInfo.candidates} authoritativeField=${sawApi ? 'wgpuDrawsPerFrame' : 'glDrawCallsPerFrame'} offMedianApiDraws=${off.medianApiDraws} onMedianApiDraws=${on.medianApiDraws} delta=${delta === null ? 'n/a' : delta.toFixed(2)} threeDelta=${threeDelta === null ? 'n/a' : threeDelta.toFixed(2)} cullRan=${ran} instrumentCounted=${counted} cameraMoved=${moved} hiddenKeysMax=${on.hiddenKeysMax} occludedMax=${on.occludedMax} failOpensOn=${on.failOpensSum} camMovedFramesOn=${on.camMovedFrames} posMovedFramesOn=${on.posMovedFrames}`)
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('[occ-ab] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
