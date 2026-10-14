#!/usr/bin/env node
// PERF-fill-overdraw-deep-bucket-1013. Attribution, not aggregate: WHICH draws stack 33+ deep.
//
// The frame is fill-bound and the aggregate is already measured (scripts/terrain-overdraw-count-witness.mjs:
// pixels x2.25 -> wall x2.18 while draws moved x1.02; 18.375 fragments/screen px front, 20.807 back;
// 33+ bucket 550,158 / 816,279 px; terrain ~8% of the frame and single-siding it removed 0.2%, inside
// noise). So the money is in the deep bucket and the question this row answers is WHO puts it there.
//
// COUNTED WORK UNITS, not time. One unit = one fragment rasterized. The instrument is built PAGE-SIDE
// out of `window.__app.THREE` (client/app.js puts {scene, camera, renderer, THREE} there), so this
// witness adds NO client source: nothing in client/ has to be touched to attribute a frame. It is
// deliberately independent of client/core/OverdrawProbe.js, which is a sibling lane's in-flight
// instrument and is not landed on main.
//
// HOW A BAND IS SEPARATED. The accumulation pass sets scene.overrideMaterial to one additive
// (CustomBlending, One/One) white node material with depthTest and depthWrite OFF, so a surface's
// fragments are counted whether or not something occludes them -- the quantity a fill-bound frame
// pays for before early-Z. That makes the per-pixel stack ADDITIVE, so for a partition of the scene
// into bands the identity
//     stack(px) = SUM over bands of band(px)
// holds pixel by pixel. The witness ASSERTS it (L1 discrepancy over all pixels), which is what makes
// the partition complete rather than merely plausible.
//
// WHY TWO PASSES PER BAND. three's overrideMaterial forces ONE cull mode for a whole accumulation
// render (three.webgpu.js:62755 `materialSide = scene.overrideMaterial.side`); it keeps the original
// positionNode and alphaTest but not the side. So each band is rendered twice with a VISIBILITY
// FILTER on the object's own material.side: pass F keeps FrontSide+DoubleSide with cull=FrontSide,
// pass B keeps BackSide+DoubleSide with cull=BackSide. F+B is then each object's own-side fragment
// count, and it reproduces the two published whole-frame passes exactly (a BackSide-only surface
// rasterizes nothing under a FrontSide cull, so hiding it in pass F changes nothing).
//
// THE DEEP BUCKET is defined on the composite stack F+B per pixel, threshold >32, matching the
// published `33+` histogram bucket. A band's share is its fragments summed over exactly those masked
// pixels, so the shares sum to 100% of the deep bucket's fragments.
//
// KNOWN BIAS, STATED NOT HIDDEN: the override copies `alphaTest` onto the accumulation material but
// the accumulation alpha is always 1, so alpha-TESTED cutouts are counted as their whole quad. A
// transparent (blended) surface really does pay its whole quad, so grass cards are NOT overstated by
// this; an alphaTest > 0 material on the other hand is. The witness prints each band's alphaTest.
//
// NON-VACUOUS IN BOTH DIRECTIONS: (1) a fullscreen quad is ADDED and must read ~1 fragment per screen
// pixel, and the identity above must still hold with it in the scene; (2) the TOP band is HIDDEN and
// its share of the deep bucket must leave; (3) it is RESTORED and its share must come back. An
// attribution that never changes with the scene is an instrument gap and fails.
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

const PORT = flag('port', '3371')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const TIMEOUT_MS = flagNumber(flag, 'timeout', 420000, process.argv.slice(2))
const SETTLE_MS = flagNumber(flag, 'settle', 18000, process.argv.slice(2))
const VIEW_W = flagNumber(flag, 'w', DEFAULT_VIEWPORT.width, process.argv.slice(2))
const VIEW_H = flagNumber(flag, 'h', DEFAULT_VIEWPORT.height, process.argv.slice(2))
const DEEP = flagNumber(flag, 'deep', 33, process.argv.slice(2))
const GPU_MODE = gpuModeFlag('gpu', 'software')
const LAUNCH_ARGS = gpuLaunchArgs(GPU_MODE, GPU_MODE.accelerated ? vendorPinArgs(GPU_MODE.vendor) : [])

const LABEL = 'overdraw-deep'
// The page-side runner is installed as source text, so its deep-bucket threshold and arm budget are
// baked into that text at module init: they must be declared before INSTALL_RUNNER is built.
const DEEP_LO = DEEP - 1
const DEEP_ARM_BUDGET_MS = 900000
const r2 = (x) => +Number(x).toFixed(2)
const r3 = (x) => +Number(x).toFixed(3)

// ---- page-side instrument -------------------------------------------------------------------------
// Installed once. Builds its own RGBA16F additive accumulation target out of window.__app.THREE, so
// it owes nothing to client/core/OverdrawProbe.js.
const INSTALL = `(() => {
  window.__odBooted = false
  window.__odBootErr = null
  window.__odMeta = null
  window.__odBoot = async () => {
    try {
      // The app's own THREE is the CORE build (client/index.html maps bare 'three' to
      // three.module.js), while the renderer is the WEBGPU build. A node material has to come from
      // the same module instance the renderer came from, so import it the way the page's own import
      // map resolves it.
      let W = null
      try { W = await import('three/webgpu') } catch (e) { W = null }
      let TSL = null
      try { TSL = await import('three/tsl') } catch (e) { TSL = null }
      // The app ships as a PREBUILT BUNDLE with three inlined, so a three/webgpu loaded by a dynamic
      // import from the page is a SECOND module instance: a node material built from it carries node
      // objects the renderer's own node system does not recognise, its pipeline fails validation, and
      // a WebGPU pipeline that fails validation dispatches NOTHING and surfaces NOTHING -- which is
      // why the calibration below read 0 pixels covered out of 2,073,600. So when the page already
      // holds an overdraw instrument built from the renderer's own three, ADOPT its material and
      // target rather than building a foreign one; the self-built path is only the fallback.
      const probe = window.__overdrawProbe
      const adopted = !!(probe && probe.accumulateMaterial && probe.target)
      const C = (window.__app && window.__app.THREE) || null
      const M = adopted ? (C || W) : (W || C)
      if (!M) throw new Error('neither the three/webgpu module nor window.__app.THREE is reachable from the page')
      const renderer = window.__renderer, scene = window.__scene, camera = window.__camera
      if (!renderer || !scene || !camera) throw new Error('window.__renderer/window.__scene/window.__camera is absent')
      let mat = null
      let target = null
      if (adopted) {
        mat = probe.accumulateMaterial
        target = probe.target
        mat.forceSinglePass = true
        mat.depthTest = false
        mat.depthWrite = false
      } else {
        const NodeMat = M.MeshBasicNodeMaterial || M.MeshBasicMaterial
        if (!NodeMat) throw new Error('no basic material class is exported by ' + (W ? 'three/webgpu' : 'window.__app.THREE'))
        mat = new NodeMat({ depthTest: false, depthWrite: false, toneMapped: false })
      }
      if (mat.color && mat.color.setRGB) mat.color.setRGB(1, 1, 1)
      if (!adopted && TSL && TSL.vec4) mat.colorNode = TSL.vec4(1, 1, 1, 1)
      if (!adopted && TSL && TSL.float) mat.opacityNode = TSL.float(1)
      mat.opacity = 1
      mat.transparent = false
      mat.blending = M.CustomBlending
      mat.blendSrc = M.OneFactor
      mat.blendDst = M.OneFactor
      mat.blendEquation = M.AddEquation
      mat.blendSrcAlpha = M.OneFactor
      mat.blendDstAlpha = M.OneFactor
      mat.blendEquationAlpha = M.AddEquation
      mat.forceSinglePass = true
      mat.side = M.FrontSide
      if (!target) {
        const v = new M.Vector2()
        renderer.getDrawingBufferSize(v)
        const tw = Math.max(4, Math.floor(v.x)), th = Math.max(4, Math.floor(v.y))
        target = new M.RenderTarget(tw, th, {
          type: M.HalfFloatType, format: M.RGBAFormat,
          minFilter: M.NearestFilter, magFilter: M.NearestFilter, depthBuffer: false,
        })
      }
      const w = Math.max(4, Math.floor(target.width)), h = Math.max(4, Math.floor(target.height))
      window.__od = { M, renderer, scene, camera, target, mat, w, h, unit: null, runs: 0, adopted }
      window.__odMeta = { ok: true, w, h, mat: mat.constructor ? mat.constructor.name : 'material', adopted, from: adopted ? 'window.__overdrawProbe' : (W ? 'three/webgpu' : 'window.__app.THREE'), hasDataUtils: !!(M.DataUtils && M.DataUtils.fromHalfFloat), sameThreeAsRenderer: !!(M.WebGPURenderer && renderer.constructor && M.WebGPURenderer === renderer.constructor), viewport: [w, h] }
      window.__odBooted = true
    } catch (e) {
      window.__odBootErr = String((e && e.message) || e)
    }
  }
  window.__odBoot()
  return true
})()`

// The whole measurement. One call = one arm. It is async in the page (the readbacks are), so the node
// side kicks it off and polls window.__odResult / window.__odError.
const INSTALL_RUNNER = `(() => {
  window.__odRun = async (opts) => {
    const od = window.__od
    const THREE = od.M
    const M = od.M
    const { renderer, scene, camera, target, mat, w, h } = od
    const D = w * h
    const halfToFloat = (u) => {
      const s = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x03ff
      if (e === 0) return s * Math.pow(2, -14) * (f / 1024)
      if (e === 0x1f) return f ? NaN : s * Infinity
      return s * Math.pow(2, e - 15) * (1 + f / 1024)
    }
    const fh = (THREE.DataUtils && typeof THREE.DataUtils.fromHalfFloat === 'function')
      ? THREE.DataUtils.fromHalfFloat.bind(THREE.DataUtils)
      : halfToFloat
    const log = []
    od.runs++

    // Declared before the calibration, which drains the queue before it reads.
    const drainGpu = async () => {
      const q = renderer.backend && renderer.backend.device && renderer.backend.device.queue
      const fence = () => (q && typeof q.onSubmittedWorkDone === "function") ? q.onSubmittedWorkDone() : Promise.resolve()
      await fence()
      await new Promise(r => requestAnimationFrame(() => r()))
      await fence()
    }

    // ---------- calibration: one fullscreen triangle is one fragment per pixel ----------
    if (od.unit == null) {
      const pT = renderer.getRenderTarget(), pA = renderer.autoClear
      const pC = new THREE.Color(); renderer.getClearColor(pC); const pAl = renderer.getClearAlpha()
      renderer.setRenderTarget(target); renderer.autoClear = true; renderer.setClearColor(0x000000, 0)
      // The calibration primitive is a camera-facing quad INSIDE THE REAL SCENE, rendered by the
      // scene path the measurement itself uses. Both synthetic fullscreen primitives -- QuadMesh
      // and a throwaway ortho scene + plane -- rasterized nothing on this renderer, and a
      // calibration that silently draws nothing reads back as 0 fragments for one fragment and
      // would zero every figure below it, so the one primitive that shares the measured path is
      // the one that calibrates it.
      const d = Math.max(camera.near * 4, 1)
      const hh = 2 * d * Math.tan((camera.fov * Math.PI / 180) / 2)
      const qgeo = new THREE.PlaneGeometry(hh * camera.aspect * 1.05, hh * 1.05)
      const qmat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide, depthTest: false, depthWrite: false })
      const cq = new THREE.Mesh(qgeo, qmat)
      cq.frustumCulled = false
      const qdir = new THREE.Vector3(); camera.getWorldDirection(qdir)
      const qpos = new THREE.Vector3(); camera.getWorldPosition(qpos)
      cq.position.copy(qpos).addScaledVector(qdir, d)
      const qquat = new THREE.Quaternion(); camera.getWorldQuaternion(qquat)
      cq.quaternion.copy(qquat)
      scene.add(cq)
      const saved = []
      // The ROOT is deliberately left visible. three Renderer._projectObject is called with the
      // scene itself and returns early on object.visible === false (three.webgpu.js), so hiding
      // the root along with its children empties the render list: the calibration then draws
      // nothing at all and reads 0 covered pixels out of w*h, while a clear of the same target
      // still reads 1 -- which is exactly the shape of the failure this line removes.
      scene.traverse((o) => { if (o === scene) return; saved.push([o, o.visible]); o.visible = false })
      cq.visible = true
      // The renderer keeps the app's user viewport and scissor test, so an accumulation pass drawn
      // through them lands in a sub-rect of the target: the centre pixel then reads 0 while a clear
      // of the same target still reads 1 everywhere. Force the whole target for the read that has
      // to come back as one fragment per pixel.
      const pv = new THREE.Vector4(); renderer.getViewport(pv)
      const ps = renderer.getScissorTest()
      renderer.setViewport(0, 0, w, h)
      renderer.setScissorTest(false)
      renderer.setRenderTarget(target); renderer.autoClear = true; renderer.setClearColor(0x000000, 0)
      // DoubleSide for the calibration primitive only: whether the plane wound towards the camera
      // depends on the camera basis this frame, and a quad culled for facing away rasterizes
      // nothing, which reads as 0 covered pixels -- the same signature as a pipeline that never
      // dispatched. One quad still contributes exactly one fragment per pixel it covers.
      mat.side = THREE.DoubleSide
      scene.overrideMaterial = mat
      renderer.render(scene, camera)
      const calibDrawCalls = renderer.info && renderer.info.render ? renderer.info.render.calls : null
      scene.overrideMaterial = null
      // Read the WHOLE target, not one pixel: the max over every pixel is one fragment's worth, and
      // the count of covered pixel(s) says whether the quad really covered the screen.
      let buf = await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)
      let mx = 0, covered = 0
      const scanCalib = () => { mx = 0; covered = 0; for (let i = 0; i < D; i++) { const v = fh(buf[i * 4]); if (v > mx) mx = v; if (v > 0) covered++ } }
      scanCalib()
      // See drainGpu: a read issued straight after render() outran the work it was meant to
      // measure. Drain first, then re-read only while the target is still empty.
      for (let i = 0; i < 8 && covered === 0; i++) {
        await drainGpu()
        buf = await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)
        scanCalib()
      }
      od.unit = mx
      od.diag = { calibMax: mx, calibCoveredPx: covered, ofPixels: D, viewport: [renderer.getViewport(new THREE.Vector4()).toArray()], calibDrawCalls, sceneVisible: scene.visible, adopted: od.adopted, matClass: mat.constructor && mat.constructor.name, readbackLen: buf && buf.length, readbackCtor: buf && buf.constructor && buf.constructor.name, sameThreeAsRenderer: !!(M.WebGPURenderer && renderer.constructor && M.WebGPURenderer === renderer.constructor) }
      if (!(od.unit > 0)) {
        renderer.setClearColor(0xffffff, 1)
        renderer.render(new THREE.Scene(), camera)
        const wb = await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)
        let wm = 0
        for (let i = 0; i < D; i++) { const v = fh(wb[i * 4]); if (v > wm) wm = v }
        od.diag.clearWhiteMax = wm
      }
      renderer.setViewport(pv); renderer.setScissorTest(ps)
      for (const [o, v] of saved) o.visible = v
      scene.remove(cq)
      qgeo.dispose(); qmat.dispose()
      renderer.setRenderTarget(pT); renderer.autoClear = pA; renderer.setClearColor(pC, pAl)
      log.push('calibrated unitsPerFragment=' + od.unit)
    }
    const unit = od.unit
    if (!(unit > 0) || !Number.isFinite(unit)) throw new Error('the accumulation target never calibrated (unitsPerFragment=' + unit + '), so no fragment figure can be read' + (od.diag ? ' -- diag=' + JSON.stringify(od.diag) : ''))

    // ---------- collect + classify ----------
    const all = []
    scene.traverse((o) => all.push(o))
    const inScene = (o) => { let p = o; while (p) { if (p === scene) return true; p = p.parent } return false }
    const resolveRoot = (v) => {
      if (!v || typeof v !== 'object') return null
      if (v.isObject3D && inScene(v)) return v
      for (const k of Object.keys(v)) {
        const c = v[k]
        if (c && c.isObject3D && inScene(c)) return c
      }
      return null
    }
    const reg = [
      ['grass', resolveRoot(window.__app && window.__app.grass) || resolveRoot(window.__grass)],
      ['vegetation', resolveRoot(window.__app && window.__app.vegetation) || resolveRoot(window.__veg)],
      ['rocks', resolveRoot(window.__app && window.__app.rocks) || resolveRoot(window.__rocks)],
      ['caves', resolveRoot(window.__app && window.__app.caveMeshes)],
      ['terrain', resolveRoot(window.__terrain) || resolveRoot(window.__app && window.__app.terrain)],
    ]
    const rootOf = new Map()   // object -> band, by subsystem subtree
    for (const [name, root] of reg) {
      if (!root) continue
      root.traverse((o) => { if (!rootOf.has(o)) rootOf.set(o, name) })
    }
    const matName = (o) => {
      const m = Array.isArray(o.material) ? o.material[0] : o.material
      return m && m.name ? m.name : ''
    }
    const objSide = (o) => {
      const ms = Array.isArray(o.material) ? o.material : [o.material]
      let s = null
      for (const m of ms) { if (!m) continue; if (m.side === 2) return 2; s = s == null ? m.side : s }
      return s == null ? 0 : s
    }
    const topLevel = (o) => { let p = o; while (p.parent && p.parent !== scene) p = p.parent; return p }
    const bandOf = new Map()
    const renderables = []
    for (const o of all) {
      if (o.userData && o.userData.odBand) { bandOf.set(o, o.userData.odBand) }
      else if (rootOf.has(o)) bandOf.set(o, rootOf.get(o))
      else {
        const mn = matName(o)
        if (mn === 'mapspinner-terrain-tsl') bandOf.set(o, 'terrain')
        else if (mn === 'mapspinner-water-tsl') bandOf.set(o, 'water')
      }
      if (!o.material) continue
      const b = bandOf.get(o)
      if (b) { bandOf.set(o, b); renderables.push(o); continue }
      const t = topLevel(o)
      const label = (t.name && t.name !== '') ? ('scene:' + t.name) : ('scene:' + t.type + '#' + String(all.indexOf(t)))
      bandOf.set(o, label)
      renderables.push(o)
    }
    // every non-renderable object still needs a band for the ancestor-walk; it inherits nothing, it
    // just has to be in the object list for visibility restore, which is positional and needs no band.
    const names = []
    for (const o of renderables) { const b = bandOf.get(o); if (!names.includes(b)) names.push(b) }
    names.sort()

    // ---------- pass machinery ----------
    const readAllOnce = async () => {
      const buf = await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)
      const out = new Float32Array(D)
      for (let i = 0; i < D; i++) out[i] = fh(buf[i * 4])
      return out
    }
    // (drainGpu is declared above the calibration; see the comment there.)
    const readAll = async () => {
      await drainGpu()
      return await readAllOnce()
    }
    // A render target's own size is the region the instrument is counting over, so the renderer's
    // user viewport and scissor must not narrow it: the app leaves both set (VDRS / split view),
    // and an accumulation pass drawn into a sub-rect reads back as 0 at the centre while a clear
    // of the same target still reads 1 everywhere -- the exact shape of the failure this replaces.
    const fullViewport = (fn) => {
      const pv = new THREE.Vector4()
      renderer.getViewport(pv)
      const ps = renderer.getScissorTest()
      renderer.setViewport(0, 0, w, h)
      renderer.setScissorTest(false)
      try { return fn() } finally { renderer.setViewport(pv); renderer.setScissorTest(ps) }
    }
    const renderPass = (side, keep) => {
      const pT = renderer.getRenderTarget(), pA = renderer.autoClear
      const pC = new THREE.Color(); renderer.getClearColor(pC); const pAl = renderer.getClearAlpha()
      const pO = scene.overrideMaterial
      const saved = new Array(all.length)
      for (let i = 0; i < all.length; i++) saved[i] = all[i].visible
      for (const o of all) o.visible = keep.has(o)
      renderer.setRenderTarget(target)
      renderer.autoClear = true
      renderer.setClearColor(0x000000, 0)
      mat.side = side
      scene.overrideMaterial = mat
      try {
        fullViewport(() => renderer.render(scene, camera))
      } finally {
        scene.overrideMaterial = pO
        for (let i = 0; i < all.length; i++) all[i].visible = saved[i]
        renderer.setRenderTarget(pT)
        renderer.autoClear = pA
        renderer.setClearColor(pC, pAl)
      }
    }
    // keep-set: ancestors of the wanted renderables, so hiding a parent cannot hide a wanted child
    const keepFor = (pred) => {
      const keep = new Set([scene])
      for (const o of renderables) {
        if (!pred(o)) continue
        let p = o
        while (p) { keep.add(p); p = p.parent }
      }
      return keep
    }
    const bandPasses = async (pred) => {
      renderPass(THREE.FrontSide, keepFor((o) => pred(o) && objSide(o) !== 1))
      const f = await readAll()
      renderPass(THREE.BackSide, keepFor((o) => pred(o) && objSide(o) !== 0))
      const b = await readAll()
      return { f, b }
    }

    // ---------- full-scene composite ----------
    const wanted = opts.bands ? new Set(opts.bands) : null
    const hidden = opts.hideBand || null
    const sceneKeep = (o) => !hidden || bandOf.get(o) !== hidden
    const comp = await bandPasses(sceneKeep)
    const stack = new Float32Array(D)
    for (let i = 0; i < D; i++) stack[i] = (comp.f[i] + comp.b[i]) / unit

    let frontSum = 0, backSum = 0
    for (let i = 0; i < D; i++) { frontSum += comp.f[i] / unit; backSum += comp.b[i] / unit }
    const HIST = [[1, 0, 1], [2, 1, 2], [3, 2, 3], [4, 3, 4], ['5-8', 4, 8], ['9-16', 8, 16], ['17-32', 16, 32], ['33+', 32, Infinity]]
    const histOf = (arr, div) => {
      const out = {}
      for (const [n] of HIST) out[n] = 0
      for (let i = 0; i < D; i++) {
        const v = arr[i] / div
        if (!(v > 0)) continue
        for (const [n, lo, hi] of HIST) if (v > lo && v <= hi) { out[n]++; break }
      }
      return out
    }
    const mask = new Uint8Array(D)
    let deepPx = 0
    for (let i = 0; i < D; i++) if (stack[i] > ${DEEP_LO}) { mask[i] = 1; deepPx++ }

    // ---------- per-band ----------
    const doBands = (wanted ? [...names].filter(n => wanted.has(n)) : names)
    const bands = []
    const sum = new Float32Array(D)
    for (const name of doBands) {
      const p = await bandPasses((o) => bandOf.get(o) === name && sceneKeep(o))
      let totalFrags = 0, deepFrags = 0, maxAt = 0
      for (let i = 0; i < D; i++) {
        const v = (p.f[i] + p.b[i]) / unit
        sum[i] += v
        totalFrags += v
        if (mask[i]) { deepFrags += v; if (v > maxAt) maxAt = v }
      }
      let objects = 0, noOverride = 0, alphaTest = 0, transparent = 0, sideHist = { front: 0, back: 0, double: 0 }
      for (const o of renderables) {
        if (bandOf.get(o) !== name) continue
        objects++
        const ms = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of ms) { if (!m) continue; if (m.allowOverride !== true) noOverride++; if (m.alphaTest > 0) alphaTest++; if (m.transparent) transparent++ }
        const s = objSide(o)
        if (s === 0) sideHist.front++; else if (s === 1) sideHist.back++; else sideHist.double++
      }
      bands.push({ name, objects, totalFragments: Math.round(totalFrags), deepFragments: Math.round(deepFrags), maxFragmentsOnADeepPixel: Math.round(maxAt), noOverride, alphaTest, transparent, sides: sideHist })
    }
    // identity check: SUM bands == composite, pixel by pixel
    let l1 = 0, l1deep = 0
    for (let i = 0; i < D; i++) { const d = Math.abs(sum[i] - stack[i]); l1 += d; if (mask[i]) l1deep += d }
    const deepTotal = bands.reduce((a, b) => a + b.deepFragments, 0)
    const pct2 = (n, d) => d > 0 ? +Number((n / d) * 100).toFixed(2) : null
    const p3 = (n, d) => +Number(n / d).toFixed(3)
    for (const b of bands) b.sharePct = pct2(b.deepFragments, deepTotal)
    bands.sort((a, b) => b.deepFragments - a.deepFragments)

    return {
      ok: true,
      unit, pixels: D, viewport: w + 'x' + h,
      front: { total: Math.round(frontSum), perScreenPx: p3(frontSum, D), histogram: histOf(comp.f, unit) },
      back: { total: Math.round(backSum), perScreenPx: p3(backSum, D), histogram: histOf(comp.b, unit) },
      composite: { total: Math.round(frontSum + backSum), perScreenPx: p3(frontSum + backSum, D), histogram: histOf(stack, 1) },
      deep: { threshold: ${DEEP_LO} + 1, pixels: deepPx, pctOfScreen: pct2(deepPx, D), fragments: Math.round(deepTotal), minFragmentsOnADeepPixel: ${DEEP_LO} + 1 },
      identity: { l1AllPixels: Math.round(l1), l1DeepPixels: Math.round(l1deep), compositeFragments: Math.round(frontSum + backSum), bandSumFragments: Math.round(bands.reduce((a, b) => a + b.totalFragments, 0)) },
      bands,
      log,
      diag: od.diag || null,
    }
  }
  return true
})()`

// A fullscreen quad in the scene: the instrument must read ~1 fragment per screen pixel for it, and
// the additive identity must still hold with it in the scene.
const ADD_QUAD = `(() => {
  const od = window.__od
  if (!od) return { ok: false, why: 'no instrument installed' }
  const { THREE, scene, camera } = od
  if (od.quad) { od.quad.visible = true; return { ok: true, reused: true } }
  const d = Math.max(camera.near * 4, 1)
  const hh = 2 * d * Math.tan((camera.fov * Math.PI / 180) / 2)
  const geo = new THREE.PlaneGeometry(hh * camera.aspect * 1.05, hh * 1.05)
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide, depthTest: false, depthWrite: false })
  const q = new THREE.Mesh(geo, m)
  q.frustumCulled = false
  q.renderOrder = 9999
  const dir = new THREE.Vector3()
  camera.getWorldDirection(dir)
  const pos = new THREE.Vector3()
  camera.getWorldPosition(pos)
  q.position.copy(pos).addScaledVector(dir, d)
  const qq = new THREE.Quaternion()
  camera.getWorldQuaternion(qq)
  q.quaternion.copy(qq)
  q.userData.odBand = 'od-control-quad'
  scene.add(q)
  od.quad = q
  return { ok: true, dist: d, h: hh }
})()`

const REMOVE_QUAD = `(() => { if (window.__od && window.__od.quad) { window.__od.quad.parent && window.__od.quad.parent.remove(window.__od.quad); window.__od.quad = null } return true })()`

const RENDERER_INFO = `(() => {
  const ri = window.__rendererInfo
  const r = window.__renderer
  return { info: ri || null, isWebGPURenderer: !!(r && r.isWebGPURenderer), backend: r && r.backend ? (r.backend.isWebGPUBackend ? 'webgpu' : 'other') : null }
})()`

async function runArm(page, opts, budgetMs) {
  await page.evaluate(`(() => { window.__odResult = null; window.__odError = null; window.__odRun(${JSON.stringify(opts)}).then(r => { window.__odResult = r }).catch(e => { window.__odError = String((e && e.message) || e) }); return true })()`)
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    const s = await page.evaluate(`(() => ({ done: !!window.__odResult, err: window.__odError }))()`)
    if (s.done) return await page.evaluate(`(() => window.__odResult)()`)
    if (s.err) throw new Error(s.err)
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`the arm did not finish within ${budgetMs / 1000}s`)
}

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

    const READY = `window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__scene && window.__camera && window.__renderer && window.__app.THREE`
    const t0 = Date.now()
    let ready = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(`!!(${READY})`).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }
    if (!ready) {
      const why = await page.evaluate(`(() => ({ app: !!window.__app, machine: !!(window.__app && window.__app.loadingMachine), isReady: !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady), scene: !!window.__scene, camera: !!window.__camera, renderer: !!window.__renderer, three: !!(window.__app && window.__app.THREE) }))()`).catch(() => null)
      console.error(`[${LABEL}] RESULT: FAIL -- the page never became ready with scene/camera/renderer/THREE reachable (${JSON.stringify(why)})`)
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

    await page.evaluate(INSTALL)
    let inst = null
    const tb = Date.now()
    while (Date.now() - tb < 60000) {
      const s = await page.evaluate(`(() => ({ booted: !!window.__odBooted, err: window.__odBootErr, meta: window.__odMeta }))()`)
      if (s.booted) { inst = s.meta; break }
      if (s.err) { inst = { ok: false, why: s.err }; break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!inst) inst = { ok: false, why: 'the page-side instrument never finished booting within 60s' }
    console.log(`[${LABEL}] instrument ${JSON.stringify(inst)}`)
    if (!inst.ok) {
      console.error(`[${LABEL}] RESULT: FAIL -- ${inst.why}`)
      await browser.close().catch(() => {})
      server.stop()
      process.exit(1)
    }
    await page.evaluate(INSTALL_RUNNER)

    const pixels = inst.w * inst.h
    const budget = DEEP_ARM_BUDGET_MS
    const base = await runArm(page, {}, budget)
    console.log(`[${LABEL}] calibrated unitsPerFragment=${base.unit} viewport=${base.viewport} pixels=${base.pixels}`)
    console.log(`[${LABEL}] calibration ${JSON.stringify(base.diag || null)}`)
    console.log(`[${LABEL}] composite front ${base.front.total} (${base.front.perScreenPx}/screen px) back ${base.back.total} (${base.back.perScreenPx}/screen px) histogram front ${JSON.stringify(base.front.histogram)} back ${JSON.stringify(base.back.histogram)}`)
    console.log(`[${LABEL}] deep bucket (>${base.deep.threshold - 1}): ${base.deep.pixels} px = ${base.deep.pctOfScreen}% of the screen, ${base.deep.fragments} fragment(s)`)
    for (const b of base.bands) {
      console.log(`[${LABEL}] band ${b.name}: deep ${b.deepFragments} fragment(s) = ${b.sharePct}% of the deep bucket | whole screen ${b.totalFragments} | objects=${b.objects} alphaTest=${b.alphaTest} transparent=${b.transparent} sides=${JSON.stringify(b.sides)}`)
    }
    console.log(`[${LABEL}] identity: sum of bands ${base.identity.bandSumFragments} vs composite ${base.identity.compositeFragments}, L1 all px ${base.identity.l1AllPixels}, L1 on deep px ${base.identity.l1DeepPixels}`)

    const top = base.bands[0]
    if (!top) {
      console.error(`[${LABEL}] RESULT: FAIL -- no band was classified, so the deep bucket has no attribution`)
      await browser.close().catch(() => {})
      server.stop()
      process.exit(1)
    }

    // ---- direction 1: hide the top band, its share must leave -------------------------------
    const hidden = await runArm(page, { hideBand: top.name, bands: [top.name] }, budget)
    const hiddenTop = hidden.bands.find(b => b.name === top.name)
    const hiddenTopDeep = hiddenTop ? hiddenTop.deepFragments : 0
    const restored = await runArm(page, { bands: [top.name] }, budget)
    const restoredTop = restored.bands.find(b => b.name === top.name)
    const restoredTopDeep = restoredTop ? restoredTop.deepFragments : 0

    // ---- direction 2: add a fullscreen quad, the instrument must read one fragment per pixel --
    const quad = await page.evaluate(ADD_QUAD)
    await new Promise(r => setTimeout(r, 800))
    const withQuad = quad.ok ? await runArm(page, { bands: ['od-control-quad'] }, budget) : null
    const quadBand = withQuad ? withQuad.bands.find(b => b.name === 'od-control-quad') : null
    await page.evaluate(REMOVE_QUAD)

    await browser.close().catch(() => {})
    server.stop()

    const failures = []
    if (!isWebGPU) failures.push(`renderer is not WebGPU (${JSON.stringify(info)}); a WebGL fallback cannot be quoted here`)
    if (!(base.unit > 0)) failures.push(`unitsPerFragment is ${base.unit}, so no fragment figure was calibrated`)
    if (!(base.deep.pixels > 0)) failures.push(`the deep bucket is ${base.deep.pixels} px, so there is nothing to attribute`)
    if (!(top.deepFragments > 0)) failures.push(`the top band ${top.name} carries ${top.deepFragments} deep fragment(s), so the attribution measured nothing`)
    // The additive identity is what makes the partition complete rather than merely plausible.
    const l1Frac = base.identity.compositeFragments > 0 ? base.identity.l1AllPixels / base.identity.compositeFragments : 1
    if (!(l1Frac < 0.02)) failures.push(`sum of bands differs from the composite by ${(l1Frac * 100).toFixed(2)}% of all fragments (L1 ${base.identity.l1AllPixels}), so the band partition is not complete and the shares are not a decomposition`)
    if (!(hiddenTopDeep <= top.deepFragments * 0.05)) failures.push(`hiding ${top.name} left it with ${hiddenTopDeep} deep fragment(s) against ${top.deepFragments} before, so its share did not leave the bucket: the attribution does not move with the scene`)
    if (!(restoredTopDeep >= top.deepFragments * 0.8)) failures.push(`restoring ${top.name} brought back only ${restoredTopDeep} deep fragment(s) against ${top.deepFragments}, so its share did not return`)
    if (!(hidden.deep.pixels < base.deep.pixels * 0.95)) failures.push(`hiding ${top.name} left the deep bucket at ${hidden.deep.pixels} px against ${base.deep.pixels}, so the bucket does not depend on its top contributor`)
    if (!quad.ok) failures.push(`the fullscreen control quad was not added (${quad.why})`)
    else if (!quadBand) failures.push('the control quad was never classified into a band, so the positive control measured nothing')
    else if (!(quadBand.totalFragments > pixels * 0.9)) failures.push(`the fullscreen control quad rasterized ${quadBand.totalFragments} fragment(s) against ${pixels} screen pixel(s), so the instrument cannot see one fragment per pixel`)
    if (pageErrors.length) failures.push(`${pageErrors.length} page error(s): ${String(pageErrors[0]).slice(0, 160)}`)

    console.log(`[${LABEL}] TOP ${top.name}: ${top.deepFragments} deep fragment(s) = ${top.sharePct}% of the ${base.deep.pixels} px deep bucket (${base.deep.fragments} fragment(s)); whole screen ${top.totalFragments} fragment(s)`)
    console.log(`[${LABEL}] MEASURED hide ${top.name}: its deep share ${top.deepFragments} -> ${hiddenTopDeep}, deep bucket ${base.deep.pixels} -> ${hidden.deep.pixels} px`)
    console.log(`[${LABEL}] MEASURED restore ${top.name}: its deep share ${hiddenTopDeep} -> ${restoredTopDeep}, deep bucket ${hidden.deep.pixels} -> ${restored.deep.pixels} px`)
    if (quadBand) console.log(`[${LABEL}] MEASURED control (fullscreen quad): ${quadBand.totalFragments} fragment(s) against ${pixels} screen pixel(s)`)
    console.log(`[${LABEL}] viewport ${VIEW_W}x${VIEW_H} pixels=${pixels} rasterizer=${gpu.rasterizer} deep>${base.deep.threshold - 1}`)

    if (failures.length) {
      console.error(`[${LABEL}] RESULT: FAIL -- ${failures.join('; ')}`)
      process.exit(1)
    }
    console.log(`[${LABEL}] RESULT: PASS overdraw-deep-bucket-attribution top=${top.name} share=${top.sharePct}% deepFragments=${top.deepFragments} deepPx=${base.deep.pixels} identityL1=${base.identity.l1AllPixels} control=${quadBand ? quadBand.totalFragments : 0}/${pixels} viewport=${VIEW_W}x${VIEW_H} rasterizer=${gpu.rasterizer}`)
    process.exit(0)
  } catch (e) {
    console.error(`[${LABEL}] FAILED: ${e && e.stack || e.message}`)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    process.exit(1)
  }
}

main()
