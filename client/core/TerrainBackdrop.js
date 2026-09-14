import * as THREE from 'three'
import { createPlanetFrame, elevationAtLocal, DEFAULT_PATCH_MAX_LEVEL } from '/src/terrain/PlanetFrame.js'
import { createTerrainOcclusion } from './TerrainOcclusion.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'

const _dbgTerrain = dbg('terrain')

function _createFallbackBackdrop() {
  const frame = {
    east: [1, 0, 0], up: [0, 1, 0], north: [0, 0, 1], anchorHeight: 0,
    groundHeightLocal: () => 0,
    localToWorld: (x, y, z) => [x, y, z],
    worldToLocal: (x, y, z) => [x, y, z],
  }
  const sampler = { heightAt: () => 0, anchorField: null }
  const planet = { frame: () => {}, clearCache: () => {} }
  return {
    planet, frame, sampler,
    renderPlanet() {},
    update() {},
    dispose() {},
    setSunLocal() {},
  }
}

export async function createTerrainBackdrop(renderer, scene, cfg = {}) {
  if (renderer && renderer.isWebGPURenderer) {
    console.warn('[terrain] WebGPURenderer active -> mapspinner has no WebGPU port yet, running without planet backdrop (see docs/webgpu-shader-audit.md)')
    return _createFallbackBackdrop()
  }
  const gl = renderer.getContext()
  const _terrainOcclusion = createTerrainOcclusion(gl, { minCandidates: cfg.occlusionMinCandidates ?? 32, maxElev: cfg.occlusionMaxElev ?? 200 })
  let initMapspinnerPlanet, createHeightSampler
  try {
    ;({ initMapspinnerPlanet } = await import('mapspinner/planet-orchestrator'))
    ;({ createHeightSampler } = await import('mapspinner/height-cpu'))
  } catch (e) {
    console.warn('[terrain] mapspinner import failed -> running without planet backdrop:', e?.message || e)
    return _createFallbackBackdrop()
  }
  const radius = cfg.radius || 6360000
  const _lightPlanet = typeof location !== 'undefined' && location.search.includes('lightplanet')
  let planet, sampler, frame
  async function _initPlanet() {
    if (_lightPlanet) return { frame: () => {}, clearCache: () => {} }
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await initMapspinnerPlanet(gl, { radius, gridMeshSize: 9, reliefScale: cfg.reliefScale, hpfSeed: cfg.seed, maxLevel: Number.isFinite(cfg.maxLevel) ? cfg.maxLevel : undefined, splitFactor: Number.isFinite(cfg.splitFactor) ? cfg.splitFactor : undefined, occlusionPredicate: cfg.occlusionCulling === false ? undefined : _terrainOcclusion.makePredicate(), geomorphLod: RenderControls.get('geomorphLod') !== false }) }
      catch (e) { lastErr = e; console.warn(`[terrain] planet init attempt ${attempt + 1}/3 failed:`, e?.message || e); await new Promise(r => setTimeout(r, 400 * (attempt + 1))) }
    }
    throw lastErr
  }
  if (typeof window !== 'undefined' && window.__planetDepthToCanvas === undefined) RenderControls.set('planetDepthToCanvas', true)
  if (typeof window !== 'undefined' && window.__planetDepthBias === undefined) RenderControls.set('planetDepthBias', 0.000002)
  try {
    planet = await _initPlanet()
    sampler = createHeightSampler({ radius, seed: cfg.seed, reliefScale: cfg.reliefScale })
    frame = createPlanetFrame({ sampler, anchorDir: cfg.anchorDir || [0, 1, 0], offsetY: cfg.offsetY || 0, reliefScale: cfg.reliefScale })
    if (cfg.gpuPatchCollider !== false) {
      try {
        const { createPatchBaker, createPatchHeightFn } = await import('/node_modules/mapspinner/src/patch-baker.js')
        const baker = await createPatchBaker({ radius, reliefScale: cfg.reliefScale, seed: cfg.seed }).catch(() => null)
        const fractalGHL = frame.groundHeightLocal
        const ph = baker && createPatchHeightFn({ baker, frame, maxLevel: Number.isFinite(cfg.maxLevel) ? cfg.maxLevel : DEFAULT_PATCH_MAX_LEVEL, offsetY: cfg.offsetY || 0, fallbackFn: fractalGHL, blocking: false })
        if (ph) {
          frame.groundHeightLocal = (x, z) => ph.heightFn(x, z)
          frame._fractalGroundHeightLocal = fractalGHL
          if (typeof ph.heightFnOrNull === 'function') frame._patchHeightOrNull = ph.heightFnOrNull
          if (typeof ph.prefetchAround === 'function') frame._patchPrefetch = ph.prefetchAround
          console.log(`[terrain] client placement height -> GPU PATCH lookup (${ph.spacing.toFixed(2)}m, finest-LOD density) -- matches server + render, no per-candidate fractal`)
        }
      } catch (e) { console.warn('[terrain] client patch-height override unavailable -> fractal placement:', e?.message || e) }
    }
    if (typeof window !== 'undefined' && RenderControls.get('vdrsScale') == null && cfg.renderScale != null) RenderControls.set('vdrsScale', cfg.renderScale)
  } catch (e) {
    console.warn('[terrain] planet init failed -> running without planet backdrop:', e?.message || e)
    return _createFallbackBackdrop()
  }

  if (typeof window !== 'undefined') window.__terrain = { heightAt: (d) => sampler.heightAt(d), groundHeightLocal: (x, z) => frame.groundHeightLocal(x, z), frame, planet, occlusionStats: () => _terrainOcclusion.getStats() }

  const _fwd = new THREE.Vector3(), _pos = new THREE.Vector3(), _eye = [0, 0, 0], _tgt = [0, 0, 0]
  const sunLocal = (() => { const s = cfg.sun || [0, 0.343, 0.939]; const l = Math.hypot(s[0], s[1], s[2]) || 1; return [s[0] / l, s[1] / l, s[2] / l] })()
  const _sunE = [0, 0, 0]
  function setSunLocal(dir) {
    if (!dir) return
    const l = Math.hypot(dir[0], dir[1], dir[2]) || 1
    sunLocal[0] = dir[0] / l; sunLocal[1] = dir[1] / l; sunLocal[2] = dir[2] / l
  }

  const _shadowMatrixArr = new Float32Array(16)
  let _worldToLocalM4 = null
  function _ensureWorldToLocalM4() {
    if (_worldToLocalM4) return _worldToLocalM4
    const [ex, ey, ez] = frame.east, [ux, uy, uz] = frame.up, [nx, ny, nz] = frame.north
    const t = radius + frame.anchorHeight
    const Tx = ux * t, Ty = uy * t, Tz = uz * t
    const m = new THREE.Matrix4()
    m.set(
      ex, ey, ez, -(ex * Tx + ey * Ty + ez * Tz),
      ux, uy, uz, -(ux * Tx + uy * Ty + uz * Tz),
      nx, ny, nz, -(nx * Tx + ny * Ty + nz * Tz),
      0, 0, 0, 1
    )
    _worldToLocalM4 = m
    return m
  }
  const _composedShadowM4 = new THREE.Matrix4()
  function _buildShadowInfo(sun) {
    if (!sun || !sun.castShadow || !sun.shadow || !sun.shadow.map) return undefined
    const tex = sun.shadow.map.depthTexture
    if (!tex) return undefined
    let glTex = null
    try {
      const props = renderer.properties.get(tex)
      glTex = props && props.__webglTexture
    } catch (_) { glTex = null }
    if (!glTex) return undefined
    _composedShadowM4.copy(sun.shadow.matrix).multiply(_ensureWorldToLocalM4())
    _composedShadowM4.toArray(_shadowMatrixArr)
    return {
      hasShadow: true,
      texture: glTex,
      matrix: _shadowMatrixArr,
      frameEast: frame.east, frameUp: frame.up, frameNorth: frame.north,
      frameAnchorHeight: frame.anchorHeight, frameRadius: radius,
      bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
      mapSize: sun.shadow.mapSize.x || 1024,
    }
  }
  let _lastPrefetchSec = -Infinity
  const RECONCILE_MOVE_M = 0.35
  let _lastSurfElevGh = null
  let _reconcileAccum = 0
  let _lastReconcilePos = null
  function _trackReconcileMovement(eyeW) {
    if (!_lastReconcilePos) { _lastReconcilePos = [eyeW[0], eyeW[1], eyeW[2]]; return }
    const dx = eyeW[0] - _lastReconcilePos[0], dy = eyeW[1] - _lastReconcilePos[1], dz = eyeW[2] - _lastReconcilePos[2]
    _lastReconcilePos[0] = eyeW[0]; _lastReconcilePos[1] = eyeW[1]; _lastReconcilePos[2] = eyeW[2]
    _reconcileAccum += Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (_reconcileAccum >= RECONCILE_MOVE_M) {
      _reconcileAccum = 0
      try { planet.clearCache && planet.clearCache() } catch (_) {}
    }
  }
  function renderPlanet(camera, elapsedSec, sun, toAuthoritative) {
    try {
      camera.getWorldPosition(_pos)
      const p = toAuthoritative ? toAuthoritative(_pos, _pos) : _pos
      if (frame._patchPrefetch && elapsedSec - _lastPrefetchSec > 0.25) {
        _lastPrefetchSec = elapsedSec
        try { frame._patchPrefetch(p.x, p.z) } catch (_) {}
      }
      const eyeW = frame.localToWorld(p.x, p.y, p.z)
      camera.getWorldDirection(_fwd)
      const fE = [
        frame.east[0] * _fwd.x + frame.up[0] * _fwd.y + frame.north[0] * _fwd.z,
        frame.east[1] * _fwd.x + frame.up[1] * _fwd.y + frame.north[1] * _fwd.z,
        frame.east[2] * _fwd.x + frame.up[2] * _fwd.y + frame.north[2] * _fwd.z,
      ]
      _eye[0] = eyeW[0]; _eye[1] = eyeW[1]; _eye[2] = eyeW[2]
      _trackReconcileMovement(eyeW)
      _tgt[0] = eyeW[0] + fE[0] * 1000; _tgt[1] = eyeW[1] + fE[1] * 1000; _tgt[2] = eyeW[2] + fE[2] * 1000
      const fovy = (camera.fov || 70) * Math.PI / 180
      _sunE[0] = frame.east[0] * sunLocal[0] + frame.up[0] * sunLocal[1] + frame.north[0] * sunLocal[2]
      _sunE[1] = frame.east[1] * sunLocal[0] + frame.up[1] * sunLocal[1] + frame.north[1] * sunLocal[2]
      _sunE[2] = frame.east[2] * sunLocal[0] + frame.up[2] * sunLocal[1] + frame.north[2] * sunLocal[2]
      renderer.resetState()
      let surfElev = frame.anchorHeight
      try {
        const hfn = frame._patchHeightOrNull
        let gh = hfn ? hfn(p.x, p.z) : frame.groundHeightLocal(p.x, p.z)
        if (gh === null) gh = (_lastSurfElevGh !== null) ? _lastSurfElevGh : frame.groundHeightLocal(p.x, p.z)
        if (Number.isFinite(gh)) { surfElev = elevationAtLocal(frame, p.x, gh, p.z); _lastSurfElevGh = gh }
      } catch (_) {}
      const shadowInfo = RenderControls.get('hostShadowOff') ? undefined : _buildShadowInfo(sun)
      const _res = planet.frame(_eye, _tgt, fovy, 0, _sunE, elapsedSec, frame.up, surfElev / radius, shadowInfo)
      if (_res && _res.cached === false && _res.quadCount === 0) {
        _dbgTerrain('zero-quad fail-safe triggered -> clearing occlusion verdicts + planet cache')
        try { _terrainOcclusion.clearVerdicts() } catch (e) { _dbgTerrain('clearVerdicts failed in zero-quad fail-safe:', e?.message || e) }
        try { planet.clearCache && planet.clearCache() } catch (e) { _dbgTerrain('planet.clearCache failed in zero-quad fail-safe:', e?.message || e) }
      }
      renderer.resetState()
      if (scene.background !== null) scene.background = null
    } catch (e) {
      const msg = String(e && e.message || e)
      if (msg !== _lastRenderPlanetErr) { _lastRenderPlanetErr = msg; console.warn('[terrain] renderPlanet threw, painting fallback sky this frame:', msg) }
      if (scene.background === null) scene.background = _fallbackSkyColor
      try { renderer.resetState() } catch (_) {}
    }
  }
  let _lastRenderPlanetErr = null
  const _fallbackSkyColor = new THREE.Color(0x87ceeb)
  let _lastFlips = 0
  function runOcclusionQueries() {
    try {
      _terrainOcclusion.runQueries((typeof window !== 'undefined') ? window.__lastVP : null)
      renderer.resetState()
      const flips = _terrainOcclusion.getStats().flips
      if (flips !== _lastFlips) { _lastFlips = flips; try { planet.clearCache && planet.clearCache() } catch (_) {} }
    } catch (_) {}
  }
  function update() {}
  function dispose() { try { planet.clearCache && planet.clearCache() } catch (e) { _dbgTerrain('planet.clearCache failed on dispose:', e?.message || e) }; try { _terrainOcclusion.dispose() } catch (e) { _dbgTerrain('terrainOcclusion dispose failed:', e?.message || e) }; if (typeof window !== 'undefined' && window.__terrain && window.__terrain.planet === planet) delete window.__terrain }
  function occlusionPredicateSnapshot() { return _terrainOcclusion.snapshotOccludedKeys() }
  function setOcclusionQueryBudget(n) { _terrainOcclusion.setMaxQueriesPerFrame(n) }
  function getOcclusionQueryBudget() { return _terrainOcclusion.getMaxQueriesPerFrame() }
  return { planet, frame, sampler, renderPlanet, runOcclusionQueries, update, dispose, getOcclusionStats: () => _terrainOcclusion.getStats(), getOcclusionCandidateCount: () => _terrainOcclusion.getCandidateCount(), occlusionPredicateSnapshot, setOcclusionQueryBudget, getOcclusionQueryBudget, setSunLocal }
}
