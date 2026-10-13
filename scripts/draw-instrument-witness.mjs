#!/usr/bin/env node
// PERF-authoritative-draw-count-1013: the authoritative per-frame draw and instance inventory of a
// shipped world, split by draw band.
//
// Counted work units only. One unit = one draw submitted at the API boundary
// (`GPURenderPassEncoder.draw*`, or `gl.draw*` on the WebGL fallback), attributed to a band by the
// object three is drawing at that moment. A counter that never moved is reported as a zero with a
// reason, never as a measured number.
//
// The authoritative field is `drawsInstrument.authoritativeField` -- `wgpuDrawsPerFrame` when the
// WebGPU encoder hook saw draws, else `glDrawCallsPerFrame`. If neither moved, this witness FAILS
// and names what is missing instead of reporting a zero.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { assertGpu, gpuLaunchArgs, gpuModeFlag } from './lib/gpu-probe.mjs'
import { vendorPinArgs } from './lib/witness-gpu.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'
import { flagNumber } from './lib/witness-args.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const has = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3137')
const BACKEND = flag('backend', 'webgpu')
const FRAMES = flagNumber(flag, 'frames', 40, process.argv.slice(2))
const PARAMS = flag('params', 'singleplayer')
const TIMEOUT_MS = flagNumber(flag, 'timeout', 300000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 12000, process.argv.slice(2))
const WORLD = flag('world', 'tps-game')
const VIEW_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, process.argv.slice(2))
const VIEW_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, process.argv.slice(2))
// Second viewport of the bound test: the same scene, the same camera, a different pixel count. 0
// disables the second arm.
const VIEW_W2 = flagNumber(flag, 'w2', 0, process.argv.slice(2))
const VIEW_H2 = flagNumber(flag, 'h2', 0, process.argv.slice(2))
const URL_EXTRA = flag('url-extra', '')
const REQUIRE_ACCELERATED = has('require-accelerated')
const EXPECT_VENDOR = flag('expect-vendor', null)
const ALLOWED_CONSOLE_ERROR_TEXTS = [
  // A species that fails to build leaves the veg band empty, which is a real fact about the frame
  // and is reported as a zero with its reason. It is foreign to the draw inventory, so it is
  // counted and printed here instead of failing the arm.
  '[veg]', '[veg-cap]',
  ...process.argv.filter((a) => a.startsWith('--allow-console-error=')).map((a) => a.slice('--allow-console-error='.length)),
]

const GPU_MODE = gpuModeFlag('gpu', 'software')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const PROBE = `(() => {
  const W = window
  if (W.__drawProbe) return
  const BANDS = ['terrain','veg','veg-impostor','grass','rocks','water','weather','players','shadow','post','decal-blend','veg-or-players','other','offhook']
  const probe = { samples: [], hooked: false, rendererKind: null, bands: BANDS.slice(), hookKind: null, ident: null, shadowCams: 0, hookError: null, rocksMainMultiDraw: null, rocksPassMultiDraw: null, rocksHook: null }
  W.__drawProbe = probe
  const zero = () => { const o = {}; for (const b of BANDS) o[b] = 0; return o }
  const tot = { draws: zero(), instances: zero(), objects: zero(), renderObjects: 0, apiDraws: 0, glDraws: 0, wgpuDraws: 0 }
  W.__dpTot = tot
  let cur = null
  let identMap = new Map()
  let instMap = new Map()
  let shadowSet = new Set()
  W.__dpOn = false

  const GL_DRAW = ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced','drawRangeElements','multiDrawElementsWEBGL','multiDrawArraysWEBGL','multiDrawElementsInstancedWEBGL','multiDrawArraysInstancedWEBGL']
  const WGPU_DRAW = ['draw','drawIndexed','drawIndirect','drawIndexedIndirect']

  function countDraw(kind) {
    if (!W.__dpOn) return
    tot.apiDraws++
    if (kind === 'gl') tot.glDraws++
    if (kind === 'wgpu') tot.wgpuDraws++
    const b = cur || 'offhook'
    tot.draws[b] = (tot.draws[b] || 0) + 1
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__dpWrapped) {
      ctx.__dpWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      for (const k of GL_DRAW) {
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () { countDraw('gl'); return orig.apply(this, arguments) },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
  for (const n of ['GPURenderPassEncoder', 'GPURenderBundleEncoder']) {
    const C = W[n]
    if (!C || !C.prototype) continue
    const proto = C.prototype
    for (const k of WGPU_DRAW) {
      const d = Object.getOwnPropertyDescriptor(proto, k)
      if (!d || typeof d.value !== 'function') continue
      const orig = d.value
      Object.defineProperty(proto, k, {
        value: function () { countDraw('wgpu'); return orig.apply(this, arguments) },
        writable: true, configurable: true,
      })
    }
  }

  function meshesOf(h, out) {
    if (!h || typeof h !== 'object') return out
    out.push(h)
    if (h.mesh) out.push(h.mesh)
    for (const key of ['tiers', 'pools', 'levels']) {
      const arr = h[key]
      if (!Array.isArray(arr)) continue
      for (const p of arr) { if (!p) continue; out.push(p); if (p.mesh) out.push(p.mesh) }
    }
    return out
  }
  function addHandle(h, band) {
    const list = meshesOf(h, [])
    for (const m of list) {
      if (!m) continue
      if (m.userData && m.userData.lodInstancer) instMap.set(m.userData.lodInstancer, band)
      identMap.set(m, band)
    }
  }
  function total(h) { try { return (h && typeof h.totalInstances === 'number') ? h.totalInstances : 0 } catch (_) { return 0 } }

  W.__dpBuildIdent = function () {
    identMap = new Map()
    instMap = new Map()
    const veg = W.__veg, grass = W.__grass, rocks = W.__rocks
    if (veg) {
      if (Array.isArray(veg._meshes)) for (const rec of veg._meshes) { addHandle(rec && rec.branch, 'veg'); addHandle(rec && rec.leaf, 'veg') }
      let imp = null
      try { imp = veg.sharedImpostor } catch (_) {}
      addHandle(imp, 'veg-impostor')
    }
    if (grass) { addHandle(grass._im, 'grass'); addHandle(grass._imMid, 'grass') }
    if (rocks) { addHandle(rocks._bm, 'rocks'); if (Array.isArray(rocks._meshes)) for (const r of rocks._meshes) addHandle(r && r.im, 'rocks') }
    shadowSet = new Set()
    try {
      const scene = W.__scene
      if (scene && scene.traverse) scene.traverse((o) => { if (o.isLight && o.shadow && o.shadow.camera) shadowSet.add(o.shadow.camera) })
    } catch (_) {}
    probe.shadowCams = shadowSet.size
    probe.ident = {
      objects: identMap.size, instancers: instMap.size, shadowCams: shadowSet.size,
      vegInstances: total(veg), grassInstances: total(grass), rocksInstances: total(rocks),
      vegHandles: veg ? (Array.isArray(veg._meshes) ? veg._meshes.length : 0) : 0,
    }
    return probe.ident
  }

  // PERF-rocks-batch-draw-attribution-1013: a BatchedMesh draw is issued by three's WebGPU backend
  // as one passEncoderGPU.drawIndexed call per entry of object._multiDrawCount, inside
  // Renderer.renderObject (node_modules/three/src/renderers/webgpu/WebGPUBackend.js:1806, reached
  // from Renderer.renderObject -> object.onBeforeRender -> _renderObjectDirect). So the band's own
  // count and the batch's own _multiDrawCount are the same work unit, and a zero in one without a
  // zero in the other is an instrument gap rather than an empty batch. Reading the batch's own count
  // is what turns a 0-draw band from a shrug into a fact.
  W.__dpRocksBatch = function () {
    const bm = W.__rocks && W.__rocks._bm
    if (!bm) return null
    let active = 0, visible = 0, activeVisible = 0
    const inf = bm._instanceInfo
    if (Array.isArray(inf)) for (const i of inf) { if (!i) continue; if (i.active) active++; if (i.visible) visible++; if (i.active && i.visible) activeVisible++ }
    return {
      multiDrawCount: bm._multiDrawCount === undefined ? null : bm._multiDrawCount,
      instanceCount: bm.instanceCount === undefined ? null : bm.instanceCount,
      instanceInfoLen: Array.isArray(inf) ? inf.length : null,
      active, visible, activeVisible,
      geometries: Array.isArray(bm._geometryInfo) ? bm._geometryInfo.length : null,
      visibilityChanged: bm._visibilityChanged === undefined ? null : bm._visibilityChanged,
      perObjectFrustumCulled: bm.perObjectFrustumCulled === undefined ? null : bm.perObjectFrustumCulled,
      sortObjects: bm.sortObjects === undefined ? null : bm.sortObjects,
      frustumCulled: bm.frustumCulled === undefined ? null : bm.frustumCulled,
      objectVisible: bm.visible === undefined ? null : bm.visible,
      renderOrder: bm.renderOrder === undefined ? null : bm.renderOrder,
      parented: !!bm.parent,
      castShadow: bm.castShadow === undefined ? null : bm.castShadow,
    }
  }
  // _multiDrawCount is recomputed per pass, so the value left standing after a frame is the LAST
  // pass's. Capture the main pass and the last non-main (shadow) pass separately.
  W.__dpRocksHook = function () {
    const bm = W.__rocks && W.__rocks._bm
    if (!bm) { probe.rocksHook = 'no window.__rocks._bm'; return false }
    if (bm.__dpObr) return probe.rocksHook
    const orig = bm.onBeforeRender
    if (typeof orig !== 'function') { probe.rocksHook = 'bm.onBeforeRender is not a function'; return false }
    bm.__dpObr = true
    bm.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
      const r = orig.call(this, renderer, scene, camera, geometry, material, group)
      try {
        const n = this._multiDrawCount
        if (camera && camera === W.__camera) probe.rocksMainMultiDraw = n
        else probe.rocksPassMultiDraw = n
      } catch (_) {}
      return r
    }
    probe.rocksHook = 'hooked'
    return true
  }

  function classify(object, camera) {
    if (camera) {
      if (shadowSet.has(camera)) return 'shadow'
      const main = W.__camera
      if (main && camera !== main) return 'post'
    }
    if (!object) return 'other'
    if (object.userData && object.userData.lodInstancer && instMap.has(object.userData.lodInstancer)) return instMap.get(object.userData.lodInstancer)
    if (identMap.has(object)) return identMap.get(object)
    const n = object.name || ''
    if (n === 'mapspinner-terrain-tsl' || /terrain/i.test(n)) return 'terrain'
    if (/water/i.test(n)) return 'water'
    switch (object.renderOrder) {
      case -1: return 'water'
      case 1: return 'rocks'
      case 2: return 'grass'
      case 3: return probe.ident && probe.ident.vegHandles > 0 ? 'players' : 'veg-or-players'
      case 4: return 'veg-impostor'
      case 5: return 'weather'
      case 10: return 'terrain'
      case 11: return 'decal-blend'
    }
    return 'other'
  }
  function instancesOf(o) {
    if (!o) return 0
    if (typeof o.count === 'number' && Number.isFinite(o.count)) return o.count
    if (typeof o.instancesCount === 'number' && Number.isFinite(o.instancesCount)) return o.instancesCount
    return 1
  }

  function installObjectHook(renderer) {
    let owner = null, name = null
    for (let p = Object.getPrototypeOf(renderer); p; p = Object.getPrototypeOf(p)) {
      if (typeof p.renderObject === 'function') { owner = p; name = 'renderObject'; break }
      if (typeof p.renderBufferDirect === 'function') { owner = p; name = 'renderBufferDirect'; break }
    }
    if (!owner) { probe.hookError = 'no renderObject/renderBufferDirect on the renderer prototype chain'; return false }
    const orig = owner[name]
    const wrap = (object, scene, camera) => {
      const band = classify(object, camera)
      const prev = cur
      cur = band
      tot.renderObjects++
      tot.objects[band] = (tot.objects[band] || 0) + 1
      tot.instances[band] = (tot.instances[band] || 0) + instancesOf(object)
      return { prev, band }
    }
    if (name === 'renderObject') {
      owner[name] = function (object, scene, camera, geometry, material, group) {
        const st = wrap(object, scene, camera)
        try { return orig.apply(this, arguments) } finally { cur = st.prev }
      }
    } else {
      owner[name] = function (camera, scene, geometry, material, object, group) {
        const st = wrap(object, scene, camera)
        try { return orig.apply(this, arguments) } finally { cur = st.prev }
      }
    }
    probe.hookKind = name
    return true
  }

  const hookInfo = (renderer) => {
    const info = renderer.info
    if (!info || info.__dpHooked) return
    info.__dpHooked = true
    probe.rendererKind = renderer.isWebGPURenderer ? 'webgpu' : (renderer.isWebGLRenderer ? 'webgl' : (renderer.constructor && renderer.constructor.name))
  }

  function snap(info) {
    return {
      t: +performance.now().toFixed(2),
      apiDraws: tot.apiDraws, glDraws: tot.glDraws, wgpuDraws: tot.wgpuDraws,
      renderObjects: tot.renderObjects,
      draws: Object.assign({}, tot.draws),
      instances: Object.assign({}, tot.instances),
      objects: Object.assign({}, tot.objects),
      infoCalls: info ? (info.render.calls === undefined ? null : info.render.calls) : null,
      infoDrawCalls: info ? (info.render.drawCalls === undefined ? null : info.render.drawCalls) : null,
      infoTriangles: info ? (info.render.triangles === undefined ? null : info.render.triangles) : null,
      rocksMainMultiDraw: probe.rocksMainMultiDraw, rocksPassMultiDraw: probe.rocksPassMultiDraw,
    }
  }
  // window.__renderer is the handle client/app.js publishes; window.__app.renderer is not set.
  const rendererOf = (W) => W.__renderer || (W.__app && W.__app.renderer) || null
  function tick() {
    const renderer = rendererOf(W)
    if (renderer) {
      hookInfo(renderer)
      if (!probe.hooked) probe.hooked = installObjectHook(renderer)
      W.__dpOn = true
      if (probe.samples.length < 4000) probe.samples.push(snap(renderer.info))
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__drawProbe && window.__drawProbe.hooked && window.__drawProbe.hookKind !== null`

const BAND_ORDER = ['terrain', 'veg', 'veg-impostor', 'grass', 'rocks', 'water', 'weather', 'players', 'shadow', 'post', 'decal-blend', 'veg-or-players', 'other', 'offhook']

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const r2 = (x) => +Number(x).toFixed(2)

async function main() {
  if (has('skip-prewarm')) process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[draw-instrument] booting real server on ${PORT} (world=${process.env.WORLD}) ...`)
  rebuildIfRequested('draw-instrument')
  const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS })
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
    const pageErrors = []
    const consoleEntries = []
    const textOfConsole = (p) => (p?.args || []).map((a) => (a?.value !== undefined ? String(a.value) : (a?.description || a?.unserializableValue || ''))).join(' ')
    page.on('pageerror', e => pageErrors.push(String(e)))
    page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOfConsole(p) }))
    page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
    const query = BACKEND === 'webgpu' ? `${PARAMS}&webgpu=1` : PARAMS
    const url = `http://localhost:${PORT}/?${query}&world=${WORLD}&v=${Date.now()}${URL_EXTRA}`
    console.log(`[draw-instrument] navigating ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      const why = await page.evaluate(`JSON.stringify({
        probe: !!window.__drawProbe,
        hooked: window.__drawProbe ? window.__drawProbe.hooked : null,
        hookKind: window.__drawProbe ? window.__drawProbe.hookKind : null,
        hookError: window.__drawProbe ? window.__drawProbe.hookError : null,
        hasRenderer: !!window.__renderer,
        hasAppRenderer: !!(window.__app && window.__app.renderer),
        isReady: !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady),
        hasApp: !!window.__app
      })`).catch((e) => 'unreadable: ' + (e.message || e))
      console.error(`[draw-instrument] not-ready state after ${Date.now() - t0}ms: ${why}`)
      for (const e of consoleEntries.filter((x) => x.level === 'error' || x.level === 'exception').slice(0, 10)) console.error(`  [console-error] ${e.text.slice(0, 300)}`)
      for (const e of pageErrors.slice(0, 10)) console.error(`  [pageerror] ${e.slice(0, 300)}`)
      console.error(`[draw-instrument] RESULT: FAIL -- page never became ready with the object hook installed`)
      process.exit(1)
    }
    console.log(`[draw-instrument] ready @ ${Date.now() - t0}ms`)

    const servedRoot = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: 'draw-instrument' })
    console.log(`[draw-instrument] served ${clientRootTag(servedRoot)} required=${CLIENT_ROOT_BUNDLE}`)

    const gpu = await assertGpu(page, { requireAccelerated: REQUIRE_ACCELERATED || GPU_MODE.accelerated, expectVendor: EXPECT_VENDOR || GPU_MODE.vendor })
    console.log(`[draw-instrument] rasterizer=${gpu.rasterizer} gpuMode=${GPU_MODE.mode} renderer=${gpu.renderer || 'none'} webgpu=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor || 'yes') : 'none'}`)

    const built = `performance.getEntriesByType('mark').some(m => m.name === 'boot:scenery-built')`
    let scenery = false
    const tScenery = Date.now()
    while (Date.now() - tScenery < TIMEOUT_MS) {
      scenery = await page.evaluate(built).catch(() => false)
      if (scenery) break
      await new Promise(r => setTimeout(r, 250))
    }
    console.log(`[draw-instrument] boot:scenery-built ${scenery ? 'reached' : 'UNREACHED'} @ ${Date.now() - tScenery}ms`)
    await new Promise(r => setTimeout(r, SETTLE_MS))

    const ident = await page.evaluate(`window.__dpBuildIdent()`)
    console.log(`[draw-instrument] settled ${SETTLE_MS}ms; band identity ${JSON.stringify(ident)}`)

    const rocksHook = await page.evaluate(`window.__dpRocksHook()`)
    const rocksBatch = await page.evaluate(`window.__dpRocksBatch()`)
    console.log(`[draw-instrument] rocks batch at settle: hook=${JSON.stringify(rocksHook)} ${JSON.stringify(rocksBatch)}`)

    // The governor is live by default and sheds a tier on a hitch, which would move the very
    // numbers this row is measuring (and would move them differently on a contended box). Pin it
    // off for the window and publish the tier the inventory belongs to.
    const gov = await page.evaluate(`(() => {
      try { if (window.__renderControls) window.__renderControls.set('qualityGovernorOff', true) } catch (_) {}
      const api = window.__qualityGovernorApi
      return {
        pinnedOff: !!(window.__renderControls && window.__renderControls.get('qualityGovernorOff') === true),
        tier: api ? api.tier : null,
        state: window.__qualityGovernorState || null,
      }
    })()`)
    console.log(`[draw-instrument] governor pinned off=${gov.pinnedOff} tier=${gov.tier} state=${JSON.stringify(gov.state)}`)

    const wanted = FRAMES + 1

    async function sampleWindow(label, w, h, nFrames = FRAMES) {
      const need = nFrames + 1
      await page.evaluate(`(() => { window.__drawProbe.samples.length = 0; return true })()`)
      const t1 = Date.now()
      while (Date.now() - t1 < TIMEOUT_MS) {
        const n = await page.evaluate(`window.__drawProbe.samples.length`).catch(() => 0)
        if (n >= need) break
        await new Promise(r => setTimeout(r, 50))
      }
      const out = await page.evaluate(`(() => {
        const p = window.__drawProbe
        const r = window.__renderer || window.__app.renderer
        const b = r.backend || {}
        return {
          rendererKind: p.rendererKind, hookKind: p.hookKind, hookError: p.hookError, shadowCams: p.shadowCams,
          autoReset: r.info.autoReset,
          hasDrawCallsField: r.info.render.drawCalls !== undefined,
          backendCtor: b.constructor && b.constructor.name,
          backendIsWebGL: !!b.isWebGLBackend, backendIsWebGPU: !!b.isWebGPUBackend,
          populationPlayers: (window.__pm && window.__pm.playerMeshes) ? window.__pm.playerMeshes.size : null,
          governorTier: window.__qualityGovernorApi ? window.__qualityGovernorApi.tier : null,
          samples: p.samples.slice(0, ${wanted}),
          rocksMainMultiDraw: p.rocksMainMultiDraw, rocksPassMultiDraw: p.rocksPassMultiDraw,
        }
      })()`)
      const s = out.samples
      if (s.length < 2) return { label, w, h, out, s, frames: s.length - 1, empty: true }
      const frames = s.length - 1
      const delta = (key) => { const a = []; for (let i = 1; i < s.length; i++) a.push(s[i][key] - s[i - 1][key]); return a }
      const bandDelta = (table, band) => { const a = []; for (let i = 1; i < s.length; i++) a.push((s[i][table][band] || 0) - (s[i - 1][table][band] || 0)); return a }
      const perBand = {}
      for (const b of BAND_ORDER) perBand[b] = { draws: avg(bandDelta('draws', b)), instances: avg(bandDelta('instances', b)), objects: avg(bandDelta('objects', b)) }
      const dApi = delta('apiDraws'), dGl = delta('glDraws'), dWgpu = delta('wgpuDraws'), dObj = delta('renderObjects')
      const dWall = delta('t').slice().sort((a, b) => a - b)
      const sumBandDraws = BAND_ORDER.reduce((a, b) => a + perBand[b].draws, 0)
      const sumBandInstances = BAND_ORDER.reduce((a, b) => a + perBand[b].instances, 0)
      const infoCalls = s.map((x) => x.infoCalls).filter((x) => x !== null)
      const infoMoved = infoCalls.length > 1 && infoCalls[infoCalls.length - 1] > infoCalls[0]
      const authoritative = avg(dWgpu) > 0 ? 'wgpuDrawsPerFrame' : (avg(dGl) > 0 ? 'glDrawCallsPerFrame' : null)
      const authoritativeValue = authoritative === 'wgpuDrawsPerFrame' ? avg(dWgpu) : (authoritative === 'glDrawCallsPerFrame' ? avg(dGl) : 0)
      return {
        label, w, h, out, s, frames, perBand, dApi, dGl, dWgpu, dObj, sumBandDraws, sumBandInstances,
        infoCalls, infoMoved, authoritative, authoritativeValue,
        frameMsP50: dWall.length ? dWall[Math.floor(dWall.length / 2)] : null,
        empty: false,
      }
    }

    function reportWindow(win) {
      const { out, s, perBand, authoritative, authoritativeValue } = win
      const gpuTag = gpu.rasterizer
      console.log(`[draw-instrument] window ${win.label}: renderer=${out.rendererKind} hook=${out.hookKind} rasterizer=${gpuTag} backend=${out.backendCtor} isWebGL=${out.backendIsWebGL} isWebGPU=${out.backendIsWebGPU} shadowCams=${out.shadowCams} autoReset=${out.autoReset} hasDrawCallsField=${out.hasDrawCallsField} samples=${s.length} frameWallP50=${win.frameMsP50 === null ? 'n/a' : r2(win.frameMsP50) + 'ms'}`)
      console.log(`[draw-instrument] MEASURED authoritative-draw-count: ${JSON.stringify({
        world: WORLD, population: out.populationPlayers === null ? 1 : out.populationPlayers,
        params: PARAMS, viewport: win.w + 'x' + win.h, backend: BACKEND, rasterizer: gpuTag,
        frames: win.frames, authoritativeField: authoritative,
        drawsPerFrame: r2(authoritativeValue), instancesPerFrame: Math.round(win.sumBandInstances),
        objectsRenderedPerFrame: r2(avg(win.dObj)), frameWallP50Ms: win.frameMsP50 === null ? null : r2(win.frameMsP50),
        vegPlacedInstances: ident.vegInstances, grassPlacedInstances: ident.grassInstances, rocksPlacedInstances: ident.rocksInstances,
      })}`)
      console.log(`[draw-instrument] band draws/frame: ${BAND_ORDER.map((b) => b + '=' + r2(perBand[b].draws)).join(' ')}`)
      console.log(`[draw-instrument] band instances/frame: ${BAND_ORDER.map((b) => b + '=' + Math.round(perBand[b].instances)).join(' ')}`)
      console.log(`[draw-instrument] band objects/frame: ${BAND_ORDER.map((b) => b + '=' + r2(perBand[b].objects)).join(' ')}`)
      console.log(`[draw-instrument] api boundary: wgpuDraws/frame=${r2(avg(win.dWgpu))} glDraws/frame=${r2(avg(win.dGl))} apiDraws/frame=${r2(avg(win.dApi))} sumOfBands/frame=${r2(win.sumBandDraws)} offhook/frame=${r2(perBand.offhook.draws)}`)
      console.log(`[draw-instrument] liveness: info.render.calls ${win.infoCalls[0]} -> ${win.infoCalls[win.infoCalls.length - 1]} (moved=${win.infoMoved}) renderObjects/frame=${r2(avg(win.dObj))}`)
      console.log(`[draw-instrument] ui: 0 draw(s)/frame -- the HUD is DOM (client/AppModuleSystem.js renderAppUI, webjsx applyDiff at 4 Hz); the renderer issues no draw for it`)
      for (let i = 1; i < s.length && i <= 12; i++) {
        const cur = s[i], prev = s[i - 1]
        const parts = BAND_ORDER.filter((b) => (cur.draws[b] || 0) - (prev.draws[b] || 0) > 0)
          .map((b) => b + '=' + ((cur.draws[b] || 0) - (prev.draws[b] || 0)))
        console.log(`  frame ${i - 1}: api=${cur.apiDraws - prev.apiDraws} objects=${cur.renderObjects - prev.renderObjects} ${parts.join(' ')}`)
      }
      if (perBand.shadow.draws <= 0) console.log(`[draw-instrument] NOTE: the shadow band drew 0 draw(s)/frame in window ${win.label} (shadow cameras known: ${out.shadowCams}) -- reported, not failed: ShadowPipeline only dirties a cascade when a caster in its band moves`)
      if (perBand.offhook.draws > 0) console.log(`[draw-instrument] NOTE: ${r2(perBand.offhook.draws)} draw(s)/frame hit the API boundary outside any renderObject call (mipmap/copy passes) and are unattributed`)
      if (perBand['veg-or-players'].draws > 0) console.log(`[draw-instrument] NOTE: ${r2(perBand['veg-or-players'].draws)} draw(s)/frame have renderOrder 3 and no veg identity, so foliage and PlayerLOD are not separable on this run`)
    }

    const winA = await sampleWindow(VIEW_W + 'x' + VIEW_H, VIEW_W, VIEW_H)
    if (winA.empty) {
      console.error(`[draw-instrument] RESULT: FAIL -- only ${winA.frames + 1} sample(s) in the window, so no per-frame delta exists`)
      process.exit(1)
    }
    reportWindow(winA)

    // The draw-bound / fill-bound question, answered without a GPU timer: hold the scene and the
    // camera, change only the pixel count. A frame whose cost is per-draw does not move; one whose
    // cost is per-pixel does.
    let winB = null
    if (VIEW_W2 > 0 && VIEW_H2 > 0 && (VIEW_W2 !== VIEW_W || VIEW_H2 !== VIEW_H)) {
      await page._send('Emulation.setDeviceMetricsOverride', { width: VIEW_W2, height: VIEW_H2, deviceScaleFactor: 1, mobile: false })
      await new Promise(r => setTimeout(r, 4000))
      winB = await sampleWindow(VIEW_W2 + 'x' + VIEW_H2, VIEW_W2, VIEW_H2)
      if (winB.empty) console.log(`[draw-instrument] NOTE: the second viewport window produced no samples, so the bound test has no second arm`)
      else {
        reportWindow(winB)
        const pxRatio = (winB.w * winB.h) / (winA.w * winA.h)
        const dRatio = winA.authoritativeValue > 0 ? winB.authoritativeValue / winA.authoritativeValue : null
        const tRatio = winA.frameMsP50 > 0 ? winB.frameMsP50 / winA.frameMsP50 : null
        const drawsHeld = dRatio !== null && dRatio > 0.95 && dRatio < 1.05
        const wallMoved = tRatio !== null && (tRatio > 1.15 || tRatio < 0.87)
        const verdict = drawsHeld && wallMoved
          ? 'FILL-BOUND: the draw count holds while the frame wall follows the pixel count, so the frame is paying per pixel, not per draw'
          : (drawsHeld && !wallMoved ? 'NOT FILL-BOUND BY THIS TEST: the pixel count moved and the frame wall did not' : 'INCONCLUSIVE: the draw count and the frame wall did not separate cleanly')
        console.log(`[draw-instrument] bound test: pixels x${r2(pxRatio)}, draws/frame ${r2(winA.authoritativeValue)} -> ${r2(winB.authoritativeValue)} (x${dRatio === null ? 'n/a' : r2(dRatio)}), frame wall p50 ${r2(winA.frameMsP50)} -> ${r2(winB.frameMsP50)} ms (x${tRatio === null ? 'n/a' : r2(tRatio)}) -- ${verdict}`)
      }
    }

    // PERF-rocks-batch-draw-attribution-1013: an ambiguous zero is not acceptable, so the rocks
    // number is made non-vacuous by moving it in both directions. Arm 1 puts rocks where they must
    // render (per-instance culling off, and a rock placed 8 m along the camera forward if the batch
    // holds no active instance at all) so the band MUST leave zero; arm 2 removes the batch
    // (bm.visible = false) so the number MUST return to zero. A number that survives both is a real
    // count; one that moves in neither is an instrument gap and fails.
    const ROCKS_MUT_FRAMES = 12
    async function rocksAttributionMutation() {
      const prep = await page.evaluate(`(() => {
        const bm = window.__rocks && window.__rocks._bm
        if (!bm) return { ok: false, why: 'window.__rocks._bm is absent' }
        let activeVisible = 0
        const inf = bm._instanceInfo
        if (Array.isArray(inf)) for (const i of inf) if (i && i.active && i.visible) activeVisible++
        bm.perObjectFrustumCulled = false
        bm._visibilityChanged = true
        let added = -1
        if (activeVisible === 0) {
          const cam = window.__camera
          if (!cam) return { ok: false, why: 'no window.__camera to place a rock in front of' }
          if (!Array.isArray(bm._geometryInfo) || bm._geometryInfo.length === 0) return { ok: false, why: 'the batch holds no geometry to instance' }
          cam.updateWorldMatrix(true, false)
          const e = cam.matrixWorld.elements
          let fx = -e[8], fy = -e[9], fz = -e[10]
          const len = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
          fx /= len; fy /= len; fz /= len
          const m4 = cam.matrixWorld.clone()
          const m = m4.elements
          const s = 2
          m[0] = s; m[1] = 0; m[2] = 0; m[3] = 0
          m[4] = 0; m[5] = s; m[6] = 0; m[7] = 0
          m[8] = 0; m[9] = 0; m[10] = s; m[11] = 0
          m[12] = e[12] + fx * 8; m[13] = e[13] + fy * 8; m[14] = e[14] + fz * 8; m[15] = 1
          try {
            const id = bm.addInstance(0)
            if (id < 0) return { ok: false, why: 'bm.addInstance(0) returned ' + id }
            bm.setMatrixAt(id, m4)
            bm.setVisibleAt(id, true)
            added = id
          } catch (err) { return { ok: false, why: 'place-a-rock failed: ' + (err && err.message) } }
        }
        return { ok: true, added, activeVisible }
      })()`)
      if (!prep || prep.ok !== true) return { ok: false, why: prep && prep.why }
      const onWin = await sampleWindow('rocks-placed-in-view', VIEW_W, VIEW_H, ROCKS_MUT_FRAMES)
      if (onWin.empty) return { ok: false, why: 'the rocks-placed-in-view window produced no samples' }
      const onBatch = await page.evaluate(`window.__dpRocksBatch()`)
      await page.evaluate(`(() => { const bm = window.__rocks && window.__rocks._bm; if (bm) bm.visible = false; return true })()`)
      const offWin = await sampleWindow('rocks-batch-removed', VIEW_W, VIEW_H, ROCKS_MUT_FRAMES)
      if (offWin.empty) return { ok: false, why: 'the rocks-batch-removed window produced no samples' }
      return { ok: true, prep, onWin, offWin, onBatch }
    }
    const rocksMut = await rocksAttributionMutation()

    const s = winA.s
    const perBand = winA.perBand
    const dApi = winA.dApi
    const dObj = winA.dObj
    const frames = winA.frames
    const authoritative = winA.authoritative
    const authoritativeValue = winA.authoritativeValue
    const sumBandInstances = winA.sumBandInstances
    const infoMoved = winA.infoMoved
    const out = winA.out

    const failures = []
    if (authoritative === null) failures.push('no API-boundary draw counter moved on either backend (wgpuDrawsPerFrame=0 and glDrawCallsPerFrame=0): the instrument cannot see draws, so this is NOT a measured zero -- required: GPURenderPassEncoder.draw*/gl.draw* recorded inside three renderObject')
    if (authoritativeValue <= 0) failures.push('authoritative draw count per frame is 0')
    if (!infoMoved) failures.push('renderer.info.render.calls never moved, so the frame loop is not running')
    if (avg(dObj) <= 0) failures.push('renderObject/renderBufferDirect was never called, so no draw is attributed to any band')
    if (Math.abs(winA.sumBandDraws - avg(dApi)) > 0.5) failures.push(`band draws (${r2(winA.sumBandDraws)}) do not sum to the api boundary (${r2(avg(dApi))})`)
    if (s.length < wanted) failures.push(`only ${frames} frame(s) of the ${FRAMES} requested were sampled`)
    if (perBand.terrain.draws <= 0) failures.push('terrain drew 0 draws/frame: the terrain band is not being rendered')
    if (BAND_ORDER.every((b) => perBand[b].draws <= 0)) failures.push('no band drew anything, so the instrument saw no work at all')

    // PERF-rocks-batch-draw-attribution-1013: the rocks band is the one band whose object count and
    // draw count disagreed, and "either empty or unattributed" is not a verdict. The batch's own
    // `_multiDrawCount` IS the number of draws three will issue for it, so the two can no longer be
    // told apart only when they disagree with each other.
    const rocksBase = perBand.rocks.draws
    const rocksBatchMdc = rocksBatch ? rocksBatch.multiDrawCount : null
    const rocksActiveVisible = rocksBatch ? rocksBatch.activeVisible : null
    const rocksMainMdc = out.rocksMainMultiDraw === undefined ? null : out.rocksMainMultiDraw
    const rocksPlacedDraws = rocksMut.ok ? rocksMut.onWin.perBand.rocks.draws : null
    const rocksRemovedDraws = rocksMut.ok ? rocksMut.offWin.perBand.rocks.draws : null
    const rocksReason = rocksBase > 0
      ? 'measured'
      : (rocksActiveVisible === 0 && rocksBatchMdc === 0 ? 'proven-empty'
        : (rocksActiveVisible > 0 && rocksBatchMdc === 0 ? 'proven-zero-batch-count' : 'instrument-gap'))
    if (rocksReason === 'instrument-gap') failures.push(`rocks: ${ident.rocksInstances} placed, ${rocksActiveVisible} active/visible in the batch, the batch's own _multiDrawCount=${rocksBatchMdc}, yet the band recorded ${r2(rocksBase)} draw(s)/frame -- the BatchedMesh draw escapes the renderObject attribution, so this IS an instrument gap`)
    else if (!rocksMut.ok) failures.push(`rocks attribution mutation could not run: ${rocksMut.why}`)
    else {
      if (rocksPlacedDraws <= 0) failures.push(`rocks: with per-instance culling off${rocksMut.prep.added >= 0 ? ' and a rock placed 8 m in front of the camera' : ''} the band still recorded ${r2(rocksPlacedDraws)} draw(s)/frame, so the instrument cannot see the BatchedMesh draw at all -- an instrument gap, not an empty batch`)
      if (rocksRemovedDraws > 0) failures.push(`rocks: removing the batch (bm.visible=false) left ${r2(rocksRemovedDraws)} draw(s)/frame in the band, so the number is not the rocks batch's`)
    }

    // A band whose placement knows instances but which drew nothing is a fact about the frame, not a
    // silent pass: it is named here, in the RESULT line and in the row, never rounded to a zero.
    const zeroBands = []
    if (ident.vegInstances > 0 && perBand.veg.draws <= 0 && perBand['veg-impostor'].draws <= 0) zeroBands.push(`veg(${ident.vegInstances} placed, 0 draw(s))`)
    if (ident.grassInstances > 0 && perBand.grass.draws <= 0) zeroBands.push(`grass(${ident.grassInstances} placed, 0 draw(s))`)
    if (ident.rocksInstances > 0 && perBand.rocks.draws <= 0) {
      zeroBands.push(rocksReason === 'proven-empty'
        ? `rocks(${ident.rocksInstances} placed, 0 active/visible instance(s) in the BatchedMesh and its own _multiDrawCount=0, so three issues no draw for it -- proven empty, not an instrument gap)`
        : rocksReason === 'proven-zero-batch-count'
          ? `rocks(${ident.rocksInstances} placed, ${rocksActiveVisible} active/visible in the batch (so it is NOT empty), and three's own _multiDrawCount for it is ${rocksBatchMdc} -- with perObjectFrustumCulled=${rocksBatch ? rocksBatch.perObjectFrustumCulled : null}, sortObjects=${rocksBatch ? rocksBatch.sortObjects : null} and _visibilityChanged=${rocksBatch ? rocksBatch.visibilityChanged : null}, BatchedMesh.onBeforeRender returns early and never recomputes that count, so three issues no draw at this pose -- a measured zero, not an instrument gap: forcing one recompute moves the band to ${rocksPlacedDraws === null ? 'n/a' : r2(rocksPlacedDraws)} draw(s)/frame)`
          : `rocks(${ident.rocksInstances} placed, ${rocksActiveVisible} active/visible, _multiDrawCount=${rocksBatchMdc}, ${r2(perBand.rocks.draws)} draw(s)/frame -- INSTRUMENT GAP, the batch wants draws the band does not record)`)
    }
    if (ident.vegInstances === 0 && perBand.veg.draws <= 0) zeroBands.push('veg(0 placed: no species built, so the band is empty rather than unmeasured)')
    if (perBand.players.draws <= 0) zeroBands.push('players(0 -- singleplayer draws the local player through the entity/other path at this spawn)')
    if (perBand.water.draws <= 0) zeroBands.push('water(0)')
    if (perBand['decal-blend'].draws <= 0) zeroBands.push('decal-blend(0 -- no decals in this world)')
    if (zeroBands.length) console.log(`[draw-instrument] zero-with-reason band(s): ${zeroBands.join('; ')}`)
    console.log(`[draw-instrument] MEASURED rocks-batch-attribution: ${JSON.stringify({
      placed: ident.rocksInstances, activeVisible: rocksActiveVisible,
      batchMultiDrawCount: rocksBatchMdc, mainPassMultiDrawCount: rocksMainMdc,
      perObjectFrustumCulled: rocksBatch ? rocksBatch.perObjectFrustumCulled : null,
      sortObjects: rocksBatch ? rocksBatch.sortObjects : null,
      visibilityChanged: rocksBatch ? rocksBatch.visibilityChanged : null,
      rocksDrawsPerFrame: r2(rocksBase),
      placedInViewDrawsPerFrame: rocksPlacedDraws === null ? null : r2(rocksPlacedDraws),
      placedInViewMultiDrawCount: rocksMut.ok && rocksMut.onBatch ? rocksMut.onBatch.multiDrawCount : null,
      batchRemovedDrawsPerFrame: rocksRemovedDraws === null ? null : r2(rocksRemovedDraws),
      rockPlacedInFrontOfCamera: rocksMut.ok ? rocksMut.prep.added >= 0 : null,
      reason: rocksReason,
    })}`)
    const consoleErrorEntries = consoleEntries.filter((e) => e.level === 'error' || e.level === 'exception')
    const unallowedConsoleErrors = consoleErrorEntries.filter((e) => !ALLOWED_CONSOLE_ERROR_TEXTS.some((t) => e.text.includes(t)))
    const consoleLevelCounts = consoleEntries.reduce((acc, e) => { acc[e.level] = (acc[e.level] || 0) + 1; return acc }, {})
    console.log(`[draw-instrument] console entries=${consoleEntries.length} levels=${JSON.stringify(consoleLevelCounts)} consoleErrors=${consoleErrorEntries.length} tolerated=${consoleErrorEntries.length - unallowedConsoleErrors.length} unallowed=${unallowedConsoleErrors.length}`)
    for (const e of unallowedConsoleErrors.slice(0, 10)) console.log(`  [console-error] ${e.text.slice(0, 240)}`)
    console.log(`[draw-instrument] pageErrors=${pageErrors.length}` + (pageErrors.length ? ' first=' + pageErrors[0].slice(0, 200) : ''))
    if (unallowedConsoleErrors.length) failures.push(`${unallowedConsoleErrors.length} console error(s)/exception(s): ${unallowedConsoleErrors[0].text.slice(0, 160)}`)

    await browser.close().catch(() => {})
    server.stop()
    if (failures.length) {
      console.error(`[draw-instrument] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[draw-instrument] RESULT: PASS arm=draw-instrument world=${WORLD} population=${out.populationPlayers === null ? 1 : out.populationPlayers} viewport=${VIEW_W}x${VIEW_H} rasterizer=${gpu.rasterizer} governorTier=${out.governorTier} authoritative=${authoritative} draws/frame=${r2(authoritativeValue)} instances/frame=${Math.round(sumBandInstances)} bands=${BAND_ORDER.filter((b) => perBand[b].draws > 0).length}/${BAND_ORDER.length} zero-with-reason=${zeroBands.length} rocksAttribution=${rocksReason} frames=${frames}`)
    process.exit(0)
  } catch (e) {
    console.error('[draw-instrument] FAILED: ' + (e.stack || e.message))
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
