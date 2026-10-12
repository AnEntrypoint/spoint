#!/usr/bin/env node
// Rain/weather shadow-caster and splash-visibility instrument.
//
// THREE measured questions, all in a real accelerated browser on the shipped rain world
// apps/world/tps-game.js (weather: type 'rain', intensity 0.6, particleCount 3000):
//
//   1. CASTER REGISTRATION. Are the four weather instancers (rain streaks, splashes, snow flakes,
//      far sheet) shadow CASERS? Measured two ways that must agree:
//        (a) the castShadow flag as the scene actually carries it, and
//        (b) onBeforeShadow SUBMISSIONS. three's shadow pass calls object.onBeforeShadow on exactly
//            the objects it is about to draw into the shadow map, gated on castShadow === true and
//            after the shadow camera's layer test and frustum test. Read with a positive control
//            (a plain box caster hung next to the camera, plus real scene casters) so a zero on
//            weather is a measurement and not a hook that never fires.
//   2. WHAT CASTING WOULD COST. Force weather castShadow = true in the page (a live measurement,
//      never a code change) and re-count submissions and shadow-map re-renders per frame. That is
//      the number the removal is worth, and it is also the arm that shows whether the frame changes
//      AT ALL when weather casts -- which is the visual proof, not an assertion.
//   3. SPLASH VISIBILITY. Hide the rain streaks (so the frame stops moving) and A/B the splash mesh
//      alone: diff(shown, hidden) counted per pixel and then classified by which region of the frame
//      each changed pixel sits in (grass / terrain / water / sky, from regionMasks). That answers
//      "are splashes actually visible, and where" by counting pixels, not by reading draw order.
//      Run again with ?nograss: the change in that count is how much the grass canopy was hiding.
//
// GPU witness: launches real accelerated headful Chrome through the project's shared browser lease
// (scripts/lib/cdp-browser.mjs) and boots a real WebGPURenderer page. It CANNOT live in the gpu-free
// arm of scripts/check.mjs and is NOT wired into it: it runs only when SPOINT_GPU_WITNESS=1, which
// no CI job sets.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//          node scripts/weather-shadow-caster-witness.mjs [--gpu=amd] \
//          [--out=.gm/pool/weather-shadow-r270-74] [--qs=nograss] [--label=before]

import fs from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('weather-shadow-caster-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
  process.exit(0)
}

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

const GPU = String(flag('gpu', 'amd'))
const OUT = resolve(ROOT, String(flag('out', '.gm/pool/weather-shadow-r270-74')))
const LABEL = String(flag('label', 'before'))
const WORLD = String(flag('world', 'tps-game'))
const SETTLE_MS = Number(flag('settle', '12000'))
const FRAME_MS = Number(flag('frame-ms', '400'))
const QUIET_MAX_MS = Number(flag('quiet-max', '120000'))
const COUNT_FRAMES = Number(flag('count-frames', '90'))
const FRAMES_PER_ARM = Number(flag('frames', '3'))
const DIFF_THRESHOLD = Number(flag('threshold', '8'))
const SPREAD_TOL = Number(flag('spread-tol', '4'))
const QS = String(flag('qs', ''))
const PORT = String(flag('port', String(20000 + Math.floor(Math.random() * 20000))))
// The world's own weather cycle is server-authoritative and only rains for half of its 240 s period,
// so the shipped weather type at any instant is a coin flip. The rain is forced by pinning the
// client-side overrides every frame; this is the dwell before the first measurement arm.
const RAIN_FORCE_MS = Number(flag('rain-force', '8000'))

const { vendorPinArgs } = await import(pathToFileURL(resolve(HERE, 'lib', 'witness-gpu.mjs')).href)
const { gpuArgs, assertGpu } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)
const { decodePng, regionMasks } = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'png.mjs')).href)

fs.mkdirSync(OUT, { recursive: true })

process.env.WORLD = process.env.WORLD || WORLD
process.env.PORT = PORT
process.env.SPOINT_NO_WATCH = '1'
const { boot } = await import(pathToFileURL(resolve(ROOT, 'src', 'sdk', 'server.js')).href)
const server = await boot()
const port = (server && server.port) || Number(PORT)
console.log('[weather-shadow] server on http://localhost:' + port + ' world=' + process.env.WORLD)

const LAUNCH_ARGS = [...gpuArgs({ accelerated: true }), ...vendorPinArgs(GPU)]
console.log('[weather-shadow] gpu=' + GPU + ' adapterArgs=' + JSON.stringify(LAUNCH_ARGS.filter(a => a.includes('luid'))))

const browser = await chromium.launch({
  root: ROOT,
  owner: 'weather-shadow-caster',
  args: LAUNCH_ARGS,
  leaseWaitMs: 240000,
  leaseTtlMs: 20 * 60 * 1000,
})

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// ---------------------------------------------------------------- page-side instruments

// Pin the rain on. The server owns the weather cycle; the client's own override slot is read by the
// app's weather-update tick, so overwriting it every frame wins the race for as long as we need.
const FORCE_RAIN = () => {
  const w = window
  w.__weatherType = 'rain'
  w.__weatherIntensity = 0.6
  if (!w.__wRainPinned) {
    w.__wRainPinned = true
    const tick = () => {
      w.__weatherType = 'rain'
      w.__weatherIntensity = 0.6
      w.__wFrames = (w.__wFrames || 0) + 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  return { pinned: true, frames: w.__wFrames || 0 }
}

const WEATHER_STATE = () => {
  const d = window.debug || {}
  const app = window.__app || {}
  const wt = app.weather
  return {
    hasWeather: !!wt,
    type: wt && typeof wt.getType === 'function' ? wt.getType() : null,
    intensity: wt && typeof wt.getIntensity === 'function' ? wt.getIntensity() : null,
    wetness: wt && typeof wt.getWetness === 'function' ? wt.getWetness() : null,
    revealedAt: app.revealedAt || 0,
    renderer: d.renderer ? { isWebGPURenderer: !!d.renderer.isWebGPURenderer, isWebGLRenderer: !!d.renderer.isWebGLRenderer } : null,
    shadowMapEnabled: d.renderer && d.renderer.shadowMap ? !!d.renderer.shadowMap.enabled : null,
    sunCastShadow: d.sun ? !!d.sun.castShadow : null,
    frames: window.__wFrames || 0,
  }
}

// The four weather instancers are the ONLY drawables on the weather draw band (drawBands.js
// WEATHER_DRAWS_OVER_FOLIAGE_BAND = 5; water is -1, rocks 1, grass 2, foliage 3/4, terrain 10/11),
// so the band is the identification and the vertex/instance counts tell them apart.
const FIND_WEATHER = () => {
  // A page-side function is serialised and evaluated in the page, where this module's scope does
  // not exist -- the band constants and the two helpers have to be restated inside every function
  // that reads them. (The sibling player-shadow witness does the same.)
  const BAND = 5
  const isDrawable = (o) => !!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh)
  const desc = (o) => {
    if (!o) return null
    const g = o.geometry
    return {
      ctr: o.constructor ? o.constructor.name : null,
      name: o.name || '',
      visible: !!o.visible,
      castShadow: !!o.castShadow,
      receiveShadow: !!o.receiveShadow,
      renderOrder: o.renderOrder,
      frustumCulled: !!o.frustumCulled,
      perObjectFrustumCulled: !!o.perObjectFrustumCulled,
      count: o.count != null ? o.count : null,
      capacity: o.instanceMatrix && o.instanceMatrix.count ? o.instanceMatrix.count : null,
      verts: g && g.attributes && g.attributes.position ? g.attributes.position.count : null,
      mat: o.material ? (Array.isArray(o.material) ? o.material.map((m) => m && m.type).join('+') : (o.material.type || null)) : null,
    }
  }
  const d = window.debug || {}
  const out = { band: BAND, weather: [], bandIntruders: [], casters: [], receiverCount: 0 }
  const band = []
  try {
    d.scene.traverse((o) => {
      if (!isDrawable(o)) return
      if (o.renderOrder !== BAND) return
      band.push(o)
    })
  } catch (e) { out.error = String(e && e.message) }
  out.weather = band.map(desc)
  window.__wxWeather = band
  // Anything else on the same band would falsify the identification; name it if it exists.
  out.bandIntruders = out.weather.filter((r) => !(r.frustumCulled === false)).map((r) => r.name + '/' + r.ctr)
  let n = 0
  try {
    d.scene.traverse((o) => {
      if (!isDrawable(o)) return
      if (o.receiveShadow) out.receiverCount++
      if (!o.castShadow) return
      if (n >= 40) return
      const r = desc(o)
      r.onWeatherBand = o.renderOrder === BAND
      out.casters.push(r)
      n++
    })
  } catch (_) {}
  out.casterTotal = (() => { let c = 0; try { d.scene.traverse((o) => { if (isDrawable(o) && o.castShadow) c++ }) } catch (_) {} return c })()
  out.shadowCost = window.__shadowCost ? window.__shadowCost.stats() : null
  out.pipeline = (window.__shadowPipeline && window.__shadowPipeline.debug) ? window.__shadowPipeline.debug() : null
  return out
}

// Hook the counters. onBeforeShadow fires only inside the shadow pass, onBeforeRender in every pass
// that draws the object -- so the pair separates "drawn into the shadow map" from "drawn at all".
const HOOK = () => {
  const isDrawable = (o) => !!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh)
  const d = window.debug || {}
  const w = window
  if (!w.__wx) w.__wx = { shadow: {}, render: {} }
  const bump = (bucket, tag) => { const b = w.__wx[bucket]; b[tag] = (b[tag] || 0) + 1 }
  const hook = (o, tag) => {
    if (o.__wxTag === tag) return
    o.__wxTag = tag
    o.onBeforeShadow = function () { bump('shadow', tag) }
    o.onBeforeRender = function () { bump('render', tag) }
  }
  const out = { hooked: [] }
  const band = w.__wxWeather || []
  for (let i = 0; i < band.length; i++) {
    const tag = 'weather' + i + ':' + (band[i].name || band[i].type || '?')
    hook(band[i], tag)
    out.hooked.push(tag)
  }
  // Controls: real scene casters that are NOT weather. If these climb while weather stays at zero,
  // the shadow pass IS rendering and weather specifically is absent from it.
  let n = 0
  try {
    d.scene.traverse((o) => {
      if (n >= 6) return
      if (!isDrawable(o) || !o.castShadow || o.renderOrder === BAND) return
      const tag = 'ctl' + n + ':' + (o.name || o.type)
      hook(o, tag)
      out.hooked.push(tag)
      n++
    })
  } catch (_) {}
  // (the positive-control box is built by ENSURE_BOX, which borrows three's own constructors)
  return out
}

// A box built from three's own classes, placed in front of the camera, castShadow on. Built once and
// left in place: an object that first appears mid-arm lands one frame late and reads as drift.
const ENSURE_BOX = () => {
  const isDrawable = (o) => !!(o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh)
  const d = window.debug || {}
  const w = window
  if (w.__wxBox) return { made: false, at: w.__wxBoxAt || null }
  let Mes = null, Mat = null, Geo = null, Attr = null
  try {
    d.scene.traverse((it) => {
      if (Mes) return
      if (it.isMesh && !it.isSkinnedMesh && !it.isInstancedMesh && !it.isBatchedMesh && it.geometry && it.material) {
        Mes = Object.getPrototypeOf(it).constructor
        Mat = Object.getPrototypeOf(it.material).constructor
        // Every three geometry extends BufferGeometry, so the constructor two links up the prototype
        // chain is BufferGeometry whatever concrete geometry this mesh happens to carry. There is no
        // module scope in the page, so this is how a geometry is built without importing three.
        Geo = Object.getPrototypeOf(Object.getPrototypeOf(it.geometry)).constructor
        Attr = Object.getPrototypeOf(it.geometry.attributes.position).constructor
      }
    })
  } catch (_) {}
  if (!Mes) return { made: false, reason: 'no plain Mesh in scene to borrow constructors from' }
  const g = new Geo()
  const s = 0.5
  g.setAttribute('position', new Attr([
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
    -s, -s, -s, -s, s, -s, s, s, -s, s, -s, -s,
  ], 3))
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0])
  try { g.computeVertexNormals() } catch (_) {}
  try { g.computeBoundingSphere() } catch (_) {}
  const box = new Mes(g, new Mat({ color: 0x884422 }))
  box.name = 'wx-box-control'
  box.castShadow = true
  box.receiveShadow = false
  box.frustumCulled = false
  const cam = d.camera
  cam.updateMatrixWorld(true)
  const dir = new (Object.getPrototypeOf(cam.position).constructor)(0, 0, -1).applyQuaternion(cam.quaternion)
  const at = cam.position.clone().addScaledVector(dir, 6)
  box.position.copy(at)
  box.updateMatrixWorld(true)
  d.scene.add(box)
  const tag = 'box:positive-control'
  box.__wxTag = tag
  box.onBeforeShadow = function () { const b = (w.__wx || (w.__wx = { shadow: {}, render: {} })).shadow; b[tag] = (b[tag] || 0) + 1 }
  box.onBeforeRender = function () { const b = (w.__wx || (w.__wx = { shadow: {}, render: {} })).render; b[tag] = (b[tag] || 0) + 1 }
  w.__wxBox = box
  w.__wxBoxAt = [+at.x.toFixed(2), +at.y.toFixed(2), +at.z.toFixed(2)]
  return { made: true, at: w.__wxBoxAt }
}

const READ = () => {
  const d = window.debug || {}
  const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
  const versions = []
  for (const l of lights) {
    if (!l || !l.shadow) continue
    const seen = {}
    const scan = (obj, prefix, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 3) return
      if (typeof obj.version === 'number') seen[prefix] = obj.version
      for (const k of ['map', 'mapPass', 'renderTarget', 'depthTexture', 'texture']) {
        if (obj[k] && typeof obj[k] === 'object') scan(obj[k], prefix + '.' + k, depth + 1)
      }
    }
    try { scan(l.shadow, 'shadow', 0) } catch (_) {}
    versions.push({ name: l.name || 'sun', castShadow: !!l.castShadow, versions: seen })
  }
  return {
    frames: window.__wFrames || 0,
    draws: window.__wx ? { shadow: { ...window.__wx.shadow }, render: { ...window.__wx.render } } : null,
    versions,
    shadowCost: window.__shadowCost ? window.__shadowCost.stats() : null,
    weatherType: (window.__app && window.__app.weather && window.__app.weather.getType) ? window.__app.weather.getType() : null,
    band: (window.__wxWeather || []).map((o) => ({ visible: !!o.visible, castShadow: !!o.castShadow, count: o.count != null ? o.count : null })),
    rendererInfo: d.renderer && d.renderer.info ? { calls: d.renderer.info.render.calls, triangles: d.renderer.info.render.triangles, frame: d.renderer.info.render.frame } : null,
  }
}

// Arms. Every flag flip is a live in-page measurement; nothing here edits a source file.
const APPLY = (mode) => {
  const BAND = 5
  const GRASS = 2
  const d = window.debug || {}
  const w = window
  const out = { mode, touched: 0 }
  const band = w.__wxWeather || []
  const dirty = () => {
    const lights = (window.__shadowPipeline && window.__shadowPipeline.lights) || []
    for (const l of lights) if (l && l.shadow) l.shadow.needsUpdate = true
    if (d.renderer && d.renderer.shadowMap) d.renderer.shadowMap.needsUpdate = true
  }
  // visible is re-asserted by weather.update() every frame, so a plain `o.visible = false` is undone
  // before the next draw. A no-op setter pins the read instead.
  const pinVisible = (o, value) => {
    if (!o) return
    try {
      Object.defineProperty(o, 'visible', { configurable: true, get() { return value }, set() {} })
      out.touched++
    } catch (_) {}
  }
  const unpinVisible = (o) => {
    if (!o) return
    try { delete o.visible; out.touched++ } catch (_) {}
  }
  if (mode === 'weather-cast-on' || mode === 'weather-cast-off') {
    const on = mode === 'weather-cast-on'
    for (const o of band) { if (o.castShadow !== on) { o.castShadow = on; out.touched++ } }
    out.bandCast = band.map((o) => !!o.castShadow)
    dirty()
  } else if (mode === 'rain-hide' || mode === 'rain-show') {
    // Index 0 is the rain streak instancer and index 3 the far sheet (creation order in
    // createWeather); both are the moving parts, so both are pinned for the splash A/B. Index 1 is
    // the splash instancer and is what the arms below toggle.
    for (const i of [0, 3]) {
      const o = band[i]
      if (!o) continue
      if (mode === 'rain-hide') pinVisible(o, false)
      else unpinVisible(o)
    }
    out.bandVisible = band.map((o) => !!o.visible)
  } else if (mode === 'splash-hide' || mode === 'splash-show') {
    const o = band[1]
    if (o) { if (mode === 'splash-hide') pinVisible(o, false); else unpinVisible(o) }
    out.bandVisible = band.map((o) => !!o.visible)
  } else if (mode === 'grass-hide' || mode === 'grass-show') {
    // The grass band (drawBands GRASS_TRANSPARENT_DRAW_BAND = 2, applied as a literal in
    // Grass.js) is the canopy the owner's claim is about. Hiding it in-page is the same experiment
    // as a ?nograss page load without spending a second boot and a second turn of the GPU lock:
    // the splash pixel count with the canopy up against the count with it down is how much of the
    // splash pass the grass was hiding.
    const list = w.__wxGrass || (w.__wxGrass = (() => {
      const g = []
      try { d.scene.traverse((o) => { if (isDrawable(o) && o.renderOrder === GRASS) g.push(o) }) } catch (_) {}
      return g
    })())
    for (const o of list) {
      if (mode === 'grass-hide') pinVisible(o, false)
      else unpinVisible(o)
    }
    out.grassCount = list.length
    out.grassVisible = list.slice(0, 8).map((o) => !!o.visible)
  } else if (mode === 'snow-probe') {
    // Identification only: under type 'snow' the snow instancer is the one that turns on.
    const wt = w.__app && w.__app.weather
    if (wt && wt.setType) { wt.setType('snow'); out.touched++ }
  } else if (mode === 'rain-restore') {
    const wt = w.__app && w.__app.weather
    if (wt && wt.setType) { wt.setType('rain'); out.touched++ }
  }
  return out
}

// ---------------------------------------------------------------- pixel maths

function diffStats(a, b, threshold) {
  const n = Math.min(a.rgb.length, b.rgb.length)
  let count = 0, sum = 0, max = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const w = a.w
  for (let i = 0; i < n; i += 3) {
    const dr = Math.abs(a.rgb[i] - b.rgb[i])
    const dg = Math.abs(a.rgb[i + 1] - b.rgb[i + 1])
    const db = Math.abs(a.rgb[i + 2] - b.rgb[i + 2])
    const d = Math.max(dr, dg, db)
    if (d > max) max = d
    sum += d
    if (d >= threshold) {
      count++
      const p = i / 3, x = p % w, y = (p - x) / w
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  const px = n / 3
  return {
    changedPixels: count,
    changedFraction: +(count / px).toFixed(6),
    meanAbs: +(sum / px).toFixed(3),
    maxAbs: max,
    box: count ? [minX, minY, maxX, maxY] : null,
  }
}

// Per-pixel MINIMUM across an arm's frames. Rain that is still moving differs frame to frame, so an
// average of arm A against an average of arm B would charge every moving streak to the arm. Taking
// the per-pixel minimum across each arm first removes anything that is not present in EVERY frame of
// that arm -- the standing parts of the frame survive, the transient ones do not.
function perPixelMin(frames) {
  const w = frames[0].w, h = frames[0].h, n = w * h * 3
  const out = new Uint8Array(n)
  out.set(frames[0].rgb)
  for (let f = 1; f < frames.length; f++) {
    const src = frames[f].rgb
    for (let i = 0; i < n; i++) if (src[i] < out[i]) out[i] = src[i]
  }
  return { w, h, rgb: out }
}

function perPixelMax(frames) {
  const w = frames[0].w, h = frames[0].h, n = w * h * 3
  const out = new Uint8Array(n)
  out.set(frames[0].rgb)
  for (let f = 1; f < frames.length; f++) {
    const src = frames[f].rgb
    for (let i = 0; i < n; i++) if (src[i] > out[i]) out[i] = src[i]
  }
  return { w, h, rgb: out }
}

// Where the changed pixels ARE. regionMasks classifies each pixel of the reference frame into
// grass / terrain / water / sky, so "the splash pass is visible" becomes "N of its visible pixels sit
// in grass and M sit on bare terrain".
function classify(ref, a, b, threshold) {
  const { masks, horizon } = regionMasks(ref)
  const counts = {}
  for (const k of Object.keys(masks)) counts[k] = { total: masks[k].length, changed: 0 }
  const setOf = {}
  for (const k of Object.keys(masks)) setOf[k] = new Set(masks[k])
  const px = ref.w * ref.h
  let outside = 0
  for (let p = 0; p < px; p++) {
    const i = p * 3
    const d = Math.max(Math.abs(a.rgb[i] - b.rgb[i]), Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), Math.abs(a.rgb[i + 2] - b.rgb[i + 2]))
    if (d < threshold) continue
    let hit = null
    for (const k of Object.keys(setOf)) if (setOf[k].has(p)) { hit = k; break }
    if (hit) counts[hit].changed++
    else outside++
  }
  const out = { horizon }
  for (const k of Object.keys(counts)) out[k] = { pixels: counts[k].total, changed: counts[k].changed, changedFraction: counts[k].total ? +(counts[k].changed / counts[k].total).toFixed(6) : null }
  out.unclassifiedChanged = outside
  return out
}

function drawsDelta(a, b) {
  const da = (a && a.draws) || {}
  const db = (b && b.draws) || {}
  const out = {}
  const buckets = ['shadow', 'render']
  for (const bk of buckets) {
    const x = da[bk] || {}, y = db[bk] || {}
    const keys = new Set([...Object.keys(x), ...Object.keys(y)])
    out[bk] = {}
    for (const k of keys) out[bk][k] = (y[k] || 0) - (x[k] || 0)
  }
  const fa = (a && a.frames) || 0, fb = (b && b.frames) || 0
  const df = fb - fa
  out.frames = df
  out.perFrame = {}
  for (const bk of buckets) {
    out.perFrame[bk] = {}
    for (const k of Object.keys(out[bk])) out.perFrame[bk][k] = df > 0 ? +(out[bk][k] / df).toFixed(3) : null
  }
  return out
}

function versionsDelta(a, b) {
  const la = (a && a.versions) || [], lb = (b && b.versions) || []
  const out = []
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    const va = (la[i] && la[i].versions) || {}
    const vb = (lb[i] && lb[i].versions) || {}
    const keys = new Set([...Object.keys(va), ...Object.keys(vb)])
    const row = {}
    let any = false
    for (const k of keys) { row[k] = (vb[k] || 0) - (va[k] || 0); if (row[k] > 0) any = true }
    out.push({ index: i, name: (lb[i] || la[i] || {}).name, castShadow: (lb[i] || la[i] || {}).castShadow, versionDelta: row, redrew: any })
  }
  return out
}

// ---------------------------------------------------------------- run

let exitCode = 1
const report = { label: LABEL, world: WORLD, qs: QS, gpu: GPU, threshold: DIFF_THRESHOLD, framesPerArm: FRAMES_PER_ARM }
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String((e && e.stack) || (e && e.message) || e)))
  const url = `http://localhost:${port}/?v=${Date.now()}` + (QS ? '&' + QS.replace(/^[?&]/, '') : '')
  report.url = url
  console.log('[weather-shadow] ' + url)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

  const gpu = await assertGpu(page, { requireAccelerated: true, expectVendor: GPU })
  report.adapter = gpu
  console.log('[weather-shadow] gpu ' + JSON.stringify({ rasterizer: gpu.rasterizer, renderer: gpu.renderer, vendor: gpu.adapter }))

  await page.evaluate(FORCE_RAIN)
  // Two predicates, timed separately. "the page booted" and "rain is falling" are different facts
  // and collapsing them into one loop is how a boot that succeeded is reported as a boot that
  // failed: the world's weather cycle is server-authoritative and only rains for half of its 240 s
  // period, so type === 'rain' can legitimately be false for minutes after a perfectly good boot.
  const t0 = Date.now()
  let booted = false, lastR = null
  while (Date.now() - t0 < 300000) {
    const r = await page.evaluate(WEATHER_STATE).catch(() => null)
    lastR = r
    if (r && r.frames > 30 && r.hasWeather) { booted = true; break }
    if ((Date.now() - t0) % 15000 < 600) console.log('[weather-shadow] booting: ' + JSON.stringify(r))
    await wait(1000)
  }
  if (!booted) throw new Error('page never produced a live weather module: last=' + JSON.stringify(lastR) + ' after ' + (Date.now() - t0) + 'ms')
  report.boot = { bootedInMs: Date.now() - t0, state: lastR }
  console.log('[weather-shadow] booted in ' + (Date.now() - t0) + 'ms ' + JSON.stringify(lastR))

  const t1 = Date.now()
  let raining = false
  while (Date.now() - t1 < 180000) {
    const r = await page.evaluate(WEATHER_STATE).catch(() => null)
    lastR = r
    if (r && r.type === 'rain' && r.intensity > 0) { raining = true; break }
    if ((Date.now() - t1) % 15000 < 600) console.log('[weather-shadow] waiting for rain: ' + JSON.stringify(r))
    await wait(1000)
  }
  report.rain = { raining, waitedMs: Date.now() - t1, state: lastR }
  console.log('[weather-shadow] raining=' + raining + ' after ' + (Date.now() - t1) + 'ms ' + JSON.stringify(lastR))
  if (!raining) console.log('[weather-shadow] RAIN NEVER ACTIVATED: the shadow arms still measure caster registration (which needs no rain); the splash arms will read zero and must be re-run')
  await wait(SETTLE_MS)
  await wait(RAIN_FORCE_MS)

  // Identification: which band member is which. Under type 'snow' only the snow instancer turns on.
  const bandRain = await page.evaluate(FIND_WEATHER)
  await page.evaluate(APPLY, 'snow-probe')
  await wait(2500)
  const bandSnow = await page.evaluate(() => (window.__wxWeather || []).map((o) => ({ visible: !!o.visible, count: o.count != null ? o.count : null })))
  await page.evaluate(APPLY, 'rain-restore')
  await wait(4000)
  const bandBack = await page.evaluate(() => (window.__wxWeather || []).map((o) => ({ visible: !!o.visible, count: o.count != null ? o.count : null })))
  report.identification = { underRain: bandRain.weather.map((r) => ({ visible: r.visible, count: r.count, verts: r.verts })), underSnow: bandSnow, backToRain: bandBack }

  const instrument = await page.evaluate(FIND_WEATHER)
  report.instrument = instrument
  fs.writeFileSync(resolve(OUT, 'instrument-' + LABEL + '.json'), JSON.stringify(instrument, null, 2))
  console.log('[weather-shadow] band members=' + instrument.weather.length + ' bandIntruders=' + JSON.stringify(instrument.bandIntruders))
  console.log('[weather-shadow] weather flags: ' + JSON.stringify(instrument.weather.map((r) => ({ ctr: r.ctr, count: r.count, cast: r.castShadow, recv: r.receiveShadow, vis: r.visible, verts: r.verts, mat: r.mat }))))
  console.log('[weather-shadow] scene casterTotal=' + instrument.casterTotal + ' receiverCount=' + instrument.receiverCount + ' shadowCost=' + JSON.stringify(instrument.shadowCost))

  const hooked = await page.evaluate(HOOK)
  const box = await page.evaluate(ENSURE_BOX)
  report.hooks = { hooked, box }
  console.log('[weather-shadow] hooks=' + JSON.stringify(hooked) + ' box=' + JSON.stringify(box))
  await wait(FRAME_MS)

  // ---- counted arm 1: SHIPPED state (weather carries whatever castShadow it boots with)
  const r0 = await page.evaluate(READ)
  await wait(2000)
  const r1 = await page.evaluate(READ)
  report.countsShipped = drawsDelta(r0, r1)
  report.versionsShipped = versionsDelta(r0, r1)
  report.framesShipped = r1.frames - r0.frames
  console.log('[weather-shadow] SHIPPED per-frame ' + JSON.stringify(report.countsShipped.perFrame))

  // ---- counted arm 2: weather FORCED to cast (live measurement of what casting would cost)
  await page.evaluate(FORCE_RAIN)
  const appliedOn = await page.evaluate(APPLY, 'weather-cast-on')
  await wait(1500)
  const r2 = await page.evaluate(READ)
  await wait(2000)
  const r3 = await page.evaluate(READ)
  report.countsForcedCast = drawsDelta(r2, r3)
  report.versionsForcedCast = versionsDelta(r2, r3)
  report.forcedCastApplied = appliedOn
  console.log('[weather-shadow] FORCED-CAST per-frame ' + JSON.stringify(report.countsForcedCast.perFrame))

  // ---- quiet window before any pixel arm: the environment bake repaints the frame once ~20 s in.
  {
    const tq = Date.now()
    let prev = null, quiet = 0, i = 0, settled = false
    while (Date.now() - tq < QUIET_MAX_MS) {
      const buf = await page.screenshot({ path: resolve(OUT, `shot-${LABEL}-quiet${i++}.png`) })
      const im = decodePng(buf.toString('base64'))
      if (prev) {
        const s = diffStats(prev, im, 8)
        if (s.changedFraction < 0.05 && s.meanAbs < 4) { if (++quiet >= 3) { settled = true; break } } else quiet = 0
      }
      prev = im
      await wait(900)
    }
    report.quiet = { settled, captures: i, ms: Date.now() - tq }
    console.log('[weather-shadow] quiet settled=' + settled + ' captures=' + i + ' ms=' + (Date.now() - tq))
    // ADVISORY, never a gate. A frame carrying falling rain with vegetation still streaming in does
    // not reach a pair of captures that agree, and refusing to measure is worse than measuring with
    // a stated noise floor: every pixel arm below carries its own within-arm control pair (shown vs
    // shown) and its own raw within-arm noise, and the counted onBeforeShadow units above do not
    // depend on the frame being still at all.
    if (!settled) console.log('[weather-shadow] WARNING: frame never settled (' + i + ' captures); pixel arms carry their own control pairs')
  }

  const shots = {}
  const takeShot = async (name) => {
    const buf = await page.screenshot({ path: resolve(OUT, `shot-${LABEL}-${name}.png`) })
    return decodePng(buf.toString('base64'))
  }

  // ---- pixel arm: does weather CASTING change the frame at all?
  await page.evaluate(FORCE_RAIN)
  await page.evaluate(APPLY, 'weather-cast-off')
  await wait(FRAME_MS * 3)
  const castOff = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { castOff.push(await takeShot(`castOff${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'weather-cast-on')
  await wait(FRAME_MS * 3)
  const castOn = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { castOn.push(await takeShot(`castOn${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'weather-cast-off')
  await wait(FRAME_MS * 3)
  const castOff2 = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { castOff2.push(await takeShot(`castOff2-${k}`)); await wait(FRAME_MS) }

  report.castVisual = {
    signal_offVsOn: diffStats(perPixelMin(castOff), perPixelMin(castOn), DIFF_THRESHOLD),
    control_offVsOff: diffStats(perPixelMin(castOff), perPixelMin(castOff2), DIFF_THRESHOLD),
    raw_lastOffVsLastOn: diffStats(castOff[castOff.length - 1], castOn[castOn.length - 1], DIFF_THRESHOLD),
    raw_noiseWithinOff: diffStats(castOff[0], castOff[castOff.length - 1], DIFF_THRESHOLD),
    classified: classify(castOff[0], perPixelMin(castOff), perPixelMin(castOn), DIFF_THRESHOLD),
  }
  console.log('[weather-shadow] castVisual signal=' + JSON.stringify(report.castVisual.signal_offVsOn) + ' control=' + JSON.stringify(report.castVisual.control_offVsOff))

  // ---- pixel arm: how many pixels does the SPLASH pass actually put on screen, and where?
  // Rain streaks and the far sheet are pinned off first so the frame stops moving.
  await page.evaluate(FORCE_RAIN)
  await page.evaluate(APPLY, 'weather-cast-off')
  await page.evaluate(APPLY, 'rain-hide')
  await wait(FRAME_MS * 4)
  const rainState = await page.evaluate(() => (window.__wxWeather || []).map((o) => !!o.visible))
  await page.evaluate(APPLY, 'splash-show')
  await wait(FRAME_MS * 3)
  const spOn = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { spOn.push(await takeShot(`splashOn${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'splash-hide')
  await wait(FRAME_MS * 3)
  const spOff = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { spOff.push(await takeShot(`splashOff${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'splash-show')
  await wait(FRAME_MS * 3)
  const spOn2 = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { spOn2.push(await takeShot(`splashOn2-${k}`)); await wait(FRAME_MS) }

  report.splashVisual = {
    bandVisibleWithRainHidden: rainState,
    signal_shownVsHidden: diffStats(perPixelMax(spOn), perPixelMax(spOff), DIFF_THRESHOLD),
    control_shownVsShown: diffStats(perPixelMax(spOn), perPixelMax(spOn2), DIFF_THRESHOLD),
    raw_lastShownVsLastHidden: diffStats(spOn[spOn.length - 1], spOff[spOff.length - 1], DIFF_THRESHOLD),
    raw_noiseWithinShown: diffStats(spOn[0], spOn[spOn.length - 1], DIFF_THRESHOLD),
    classified: classify(spOn[0], perPixelMax(spOn), perPixelMax(spOff), DIFF_THRESHOLD),
  }
  console.log('[weather-shadow] splashVisual signal=' + JSON.stringify(report.splashVisual.signal_shownVsHidden) + ' control=' + JSON.stringify(report.splashVisual.control_shownVsShown))
  console.log('[weather-shadow] splash classified=' + JSON.stringify(report.splashVisual.classified))

  // ---- the same A/B with the grass canopy HIDDEN. The ratio is the owner's claim measured.
  await page.evaluate(FORCE_RAIN)
  const grassOff = await page.evaluate(APPLY, 'grass-hide')
  await wait(FRAME_MS * 4)
  await page.evaluate(APPLY, 'splash-show')
  await wait(FRAME_MS * 3)
  const ngOn = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { ngOn.push(await takeShot(`noGrassSplashOn${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'splash-hide')
  await wait(FRAME_MS * 3)
  const ngOff = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { ngOff.push(await takeShot(`noGrassSplashOff${k}`)); await wait(FRAME_MS) }
  await page.evaluate(APPLY, 'splash-show')
  await wait(FRAME_MS * 3)
  const ngOn2 = []
  for (let k = 1; k <= FRAMES_PER_ARM; k++) { ngOn2.push(await takeShot(`noGrassSplashOn2-${k}`)); await wait(FRAME_MS) }
  const ngSignal = diffStats(perPixelMax(ngOn), perPixelMax(ngOff), DIFF_THRESHOLD)
  report.splashNoGrass = {
    grassMeshesHidden: grassOff,
    signal_shownVsHidden: ngSignal,
    control_shownVsShown: diffStats(perPixelMax(ngOn), perPixelMax(ngOn2), DIFF_THRESHOLD),
    raw_noiseWithinShown: diffStats(ngOn[0], ngOn[ngOn.length - 1], DIFF_THRESHOLD),
  }
  const withGrass = report.splashVisual.signal_shownVsHidden.changedPixels
  report.splashOccludedByGrass = {
    visiblePixelsWithGrass: withGrass,
    visiblePixelsGrassHidden: ngSignal.changedPixels,
    hiddenFraction: ngSignal.changedPixels > 0 ? +(1 - withGrass / ngSignal.changedPixels).toFixed(4) : null,
  }
  console.log('[weather-shadow] splashNoGrass signal=' + JSON.stringify(ngSignal) + ' occlusion=' + JSON.stringify(report.splashOccludedByGrass))
  await page.evaluate(APPLY, 'grass-show')

  await page.evaluate(APPLY, 'rain-show')
  await page.evaluate(APPLY, 'weather-cast-off')
  await wait(FRAME_MS * 2)

  report.errors = errors.slice(0, 10)
  fs.writeFileSync(resolve(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2))
  console.log('[weather-shadow] report written to ' + resolve(OUT, `report-${LABEL}.json`))
  exitCode = 0
} catch (e) {
  report.fatal = String((e && e.stack) || e)
  try { fs.writeFileSync(resolve(OUT, `report-${LABEL}.json`), JSON.stringify(report, null, 2)) } catch (_) {}
  console.error('[weather-shadow] FAILED ' + report.fatal)
  exitCode = 1
} finally {
  try { await browser.close() } catch (_) {}
  try { if (server && server.stop) await server.stop() } catch (_) {}
}

process.exit(exitCode)
