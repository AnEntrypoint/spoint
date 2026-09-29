import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createExactPatchFrame } from './ExactPatchFrame.js'
import { createCullFreeze } from './CullFreeze.js'
import { createPlacementRing } from './PlacementRing.js'
import { placementsForGrassChunk, createGrassChunkCursor, GRASS } from '/src/terrain/GrassPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createModelExclusionField } from '/src/terrain/ModelExclusionField.js'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import { dbg } from './debug-log.js'
import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeWind, makeGrassMaterial } from './GrassMaterial.js'
import { makeClumpGeo } from './GrassClump.js'
import { makeGrassMaterialTSL, syncGrassMaterialTSL } from './GrassTSL.js'
import { createStreamingInstancer } from './WebGPUInstancing.js'

const GRASS_ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'float', instShadow: 'float' }

export { MAX_BENDERS, MAX_DECALS }

const _dbgGrass = dbg('grass')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 16
const CLUMP_WIDTH_MIN = 1.35
const CLUMP_WIDTH_SPAN = 0.7
const CLUMP_HEIGHT_SCALE = 0.75
const REGROWTH_DISABLED_HALF_LIFE_S = 1e12
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()

export async function createGrass(opts = {}) {
  const { renderer, scene, frame } = opts
  const biomeOverride = createBiomeOverride()
  const modelExclusion = createModelExclusionField(opts.placedModels)
  const anchorField = modelExclusion.wrapClimateField(biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame)))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createGrass: renderer/scene/frame required')
  if (cfg.grass === false) return null

  const renderDistance = Number.isFinite(cfg.grassRenderDistance) ? cfg.grassRenderDistance : 44
  const ringRadius = renderDistance, dropRadius = ringRadius + DROP_MARGIN
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.grassMaxInstances) ? cfg.grassMaxInstances : 40000
  const INIT_CAP = Math.min(MAX_INSTANCES, 4096)

  const wind = makeWind()
  const isWebGPU = !!renderer.isWebGPURenderer

  const LOD_NEAR_DIST = Number.isFinite(cfg.grassLodNearDistance) ? cfg.grassLodNearDistance : 8
  const geoNear = makeClumpGeo(3, 4)
  const geoMid = makeClumpGeo(1, 2)

  let mat, im, imMid, grassNodes = null
  if (isWebGPU) {
    const built = makeGrassMaterialTSL(wind)
    mat = built.material
    grassNodes = built.nodes
    im = createStreamingInstancer(scene, geoNear, mat, INIT_CAP, GRASS_ATTRIBUTE_SCHEMA)
    imMid = createStreamingInstancer(scene, geoMid, mat, Math.min(INIT_CAP, 2048), GRASS_ATTRIBUTE_SCHEMA)
  } else {
    mat = makeGrassMaterial(wind)
    im = new InstancedMesh2(geoNear, mat, { capacity: INIT_CAP, renderer })
    imMid = new InstancedMesh2(geoMid, mat, { capacity: Math.min(INIT_CAP, 2048), renderer })
    for (const m of [im, imMid]) {
      m.initUniformsPerInstance({ vertex: { windPhase: 'float', instShadow: 'float' }, fragment: { tint: 'float' } })
      m.perObjectFrustumCulled = false
      m.frustumCulled = false
    }
    scene.add(im); scene.add(imMid)
  }
  im.updateMatrix(); im.matrixAutoUpdate = false
  imMid.updateMatrix(); imMid.matrixAutoUpdate = false
  im.renderOrder = 2; imMid.renderOrder = 2

  const loaded = new Map()
  const deferredChunks = new Set()
  const exactFrame = createExactPatchFrame(frame)
  const placementRing = createPlacementRing(frame, GRASS, ringRadius)
  let _occCands = null
  let totalInstances = 0
  const profile = { totalInstances: 0, loads: 0, unloads: 0, updateMs: 0, grassDrawCalls: 2, ringScans: 0, cullMs: 0, chunksCulled: 0 }
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  function commitChunk(key, list, px, pz) {
    const [minX, minZ, maxX, maxZ] = placementRing.bounds(key, list)
    const [centerX, centerZ] = placementRing.centre(key)
    let useMid = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const nearestX = px < minX ? minX : (px > maxX ? maxX : px)
      const nearestZ = pz < minZ ? minZ : (pz > maxZ ? maxZ : pz)
      const ddx = nearestX - px, ddz = nearestZ - pz
      useMid = (ddx * ddx + ddz * ddz) > LOD_NEAR_DIST * LOD_NEAR_DIST
    }
    const targetMesh = useMid ? imMid : im
    const entries = []
    let _minY = Infinity, _maxY = -Infinity
    if (list) {
      const batch = Math.min(list.length, MAX_INSTANCES - totalInstances)
      for (let i = 0; i < batch; i++) {
        const p = list[i]
        if (p.y < _minY) _minY = p.y
        if (p.y + p.scale > _maxY) _maxY = p.y + p.scale
      }
      let _ci = 0
      targetMesh.addInstances(batch, (e, id) => {
        const p = list[_ci++]
        e.position.set(p.x, p.y, p.z)
        _q.setFromAxisAngle(_v.set(0, 1, 0), p.yaw)
        e.quaternion.copy(_q)
        const width = CLUMP_WIDTH_MIN + CLUMP_WIDTH_SPAN * p.tint
        e.scale.set(width, p.scale * CLUMP_HEIGHT_SCALE, width)
        entries.push({ id, windPhase: p.windPhase, tint: p.tint, shadow: Number.isFinite(p.shadow) ? p.shadow : 1 })
      })
      totalInstances += batch
      for (const en of entries) { try { targetMesh.setUniformAt(en.id, 'windPhase', en.windPhase); targetMesh.setUniformAt(en.id, 'tint', en.tint); targetMesh.setUniformAt(en.id, 'instShadow', en.shadow) } catch (_) {} }
    }
    if (_minY === Infinity) {
      let gh = 0
      try { gh = frame.groundHeightLocal(centerX, centerZ) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 1; _maxY = gh + 1
    }
    const _aabbMin = [minX, _minY, minZ], _aabbMax = [maxX, _maxY, maxZ]
    loaded.set(key, { entries, mesh: targetMesh, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false, inFrustum: true })
    _occCands = null
    profile.loads++
  }

  function loadChunk(key, px, pz) {
    if (loaded.has(key)) return
    exactFrame.beginChunk()
    let list; try { list = placementsForGrassChunk(key, exactFrame.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    if (exactFrame.missing) { deferGrassChunk(key); return }
    commitChunk(key, list, px, pz)
  }

  function deferGrassChunk(key) {
    deferredChunks.add(key)
    const c = placementRing.centre(key)
    exactFrame.prefetchChunk(c[0], c[1])
  }

  function unloadChunk(key) {
    const cell = loaded.get(key); if (!cell) return
    const mesh = cell.mesh || im
    for (const en of cell.entries) { try { mesh.removeInstances(en.id); totalInstances-- } catch (_) {} }
    loaded.delete(key); _occCands = null; profile.unloads++
  }

  let _ringClean = false, _scanKey = NaN
  const LOAD_BUDGET = Number.isFinite(cfg.grassLoadBudgetMs) ? cfg.grassLoadBudgetMs : 4
  let _inflight = null
  function streamRing(px, pz) {
    if (_inflight) {
      if (stepInflight()) finishInflight()
      else { _ringClean = false; return }
    }
    const cKey = placementRing.focusKeyAt(px, pz)
    if (_ringClean && cKey === _scanKey) return
    profile.ringScans++
    const ring = placementRing.ringAt(px, pz, cKey)
    let didLoad = false, didDrop = false
    if (totalInstances < MAX_INSTANCES) {
      for (const key of deferredChunks) {
        deferredChunks.delete(key)
        if (placementRing.distSq(key, px, pz) > dropRadiusSq) continue
        startInflight(key, px, pz)
        didLoad = true; break
      }
    }
    if (totalInstances < MAX_INSTANCES && !_inflight) {
      for (const key of ring) {
        if (placementRing.distSq(key, px, pz) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
        startInflight(key, px, pz)
        didLoad = true; break
      }
    }
    for (const key of loaded.keys()) {
      if (_inflight && key === _inflight.key) continue
      if (placementRing.distSq(key, px, pz) > dropRadiusSq) { unloadChunk(key); didDrop = true; break }
    }
    _scanKey = cKey; _ringClean = !didLoad && !didDrop && !_inflight && deferredChunks.size === 0
    profile.deferredChunks = deferredChunks.size
  }

  function stepInflight() {
    exactFrame.beginChunk()
    const done = _inflight.cursor.step(LOAD_BUDGET)
    if (exactFrame.missing) _inflight.missing = true
    return done
  }

  function finishInflight() {
    const { key, cursor, px, pz, missing } = _inflight
    _inflight = null
    loaded.delete(key)
    if (missing) { deferGrassChunk(key); return }
    commitChunk(key, cursor.blades, px, pz)
  }

  function startInflight(key, px, pz) {
    loaded.set(key, { entries: [], pending: true })
    exactFrame.beginChunk()
    _inflight = { key, cursor: createGrassChunkCursor(key, exactFrame.placementFrame, anchorField, worldSeed), px, pz, missing: false }
    if (stepInflight()) finishInflight()
  }

  let _lastPx = NaN, _lastPz = NaN
  const IDLE_EPS = 0.05
  const cullFreeze = createCullFreeze((auto) => { im.autoUpdate = auto; imMid.autoUpdate = auto; profile.cullFrozen = !auto })
  let _cullDirty = true

  function cullChunksToFrustum(camera) {
    const tc0 = (typeof performance !== 'undefined') ? performance.now() : 0
    camera.updateMatrixWorld()
    _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_projMat)
    let culledCount = 0
    for (const [, cell] of loaded) {
      if (cell.pending) continue
      _cullBox.min.set(cell.aabbMin[0], cell.aabbMin[1], cell.aabbMin[2])
      _cullBox.max.set(cell.aabbMax[0], cell.aabbMax[1], cell.aabbMax[2])
      const inFrustum = _frustum.intersectsBox(_cullBox)
      if (!inFrustum) culledCount++
      if (inFrustum === cell.inFrustum) continue
      cell.inFrustum = inFrustum
      if (cell.occluded) continue
      const mesh = cell.mesh || im
      for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, inFrustum) } catch (_) {} }
    }
    profile.chunksCulled = culledCount
    profile.cullMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - tc0
  }

  function updateVisibility(camera, pose) {
    if (!camera) return
    const live = _cullDirty
    _cullDirty = false
    if (!cullFreeze.step(camera, pose, live)) cullChunksToFrustum(camera)
  }

  function setBenders(list) {
    if (typeof window !== 'undefined' && window.__grassBend === false) list = null
    const arr = wind.uBenderPosXZ.value
    let n = 0
    if (list) {
      for (let i = 0; i < list.length && n < MAX_BENDERS; i++) {
        const b = list[i]
        let bx, bz
        if (b && Array.isArray(b.position)) { bx = b.position[0]; bz = b.position[2] }
        else if (b && Number.isFinite(b.x)) { bx = b.x; bz = b.z }
        if (Number.isFinite(bx) && Number.isFinite(bz)) { arr[n * 2] = bx; arr[n * 2 + 1] = bz; n++ }
      }
    }
    for (let i = n; i < MAX_BENDERS; i++) { arr[i * 2] = UNUSED_BENDER_SLOT_XZ; arr[i * 2 + 1] = UNUSED_BENDER_SLOT_XZ }
    wind.uBenderCount.value = n
  }
  if (Number.isFinite(cfg.grassBendRadius)) wind.uGrassBendRadius.value = cfg.grassBendRadius
  if (Number.isFinite(cfg.grassBendStrength)) wind.uGrassBendStrength.value = cfg.grassBendStrength

  const decalHalfLifeS = (cfg.grassDecalRegrowth === false) ? REGROWTH_DISABLED_HALF_LIFE_S : (Number.isFinite(cfg.grassDecalHalfLifeS) && cfg.grassDecalHalfLifeS > 0 ? cfg.grassDecalHalfLifeS : undefined)
  const decalStore = createGrassDecal(null, { halfLifeS: decalHalfLifeS })
  let _decalVersion = -1

  function _refreshDecalUniforms(px, pz) {
    const arr = wind.uDecalPosXZRS.value
    const near = decalStore.nearestStamps(px, pz, MAX_DECALS, ringRadius + DROP_MARGIN)
    let n = 0
    for (; n < near.length; n++) {
      const s = near[n]
      arr[n * 4] = s.x; arr[n * 4 + 1] = s.z; arr[n * 4 + 2] = s.radius; arr[n * 4 + 3] = Number.isFinite(s.strength) ? s.strength : 1
    }
    for (let i = n; i < MAX_DECALS; i++) { arr[i * 4] = 0; arr[i * 4 + 1] = 0; arr[i * 4 + 2] = 0; arr[i * 4 + 3] = 0 }
    wind.uDecalCount.value = n
  }

  function markScorched(worldX, worldZ, radius, strength) {
    const r = decalStore.markScorched(worldX, worldZ, radius, strength)
    _decalVersion = -1
    return r
  }

  const DECAL_REFRESH_MS = 2000
  let _lastDecalRefreshMs = -Infinity

  function tickWind(dt) {
    wind.uGrassTime.value += dt
    if (typeof window !== 'undefined' && window.__grassWind != null) wind.uGrassWind.value = +window.__grassWind
  }

  function update(dt, camera, playerPos, benders) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    if (benders !== undefined) setBenders(benders)
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (camera) { camera.getWorldPosition(_camPos); px = _camPos.x; pz = _camPos.z }
    let cameraStill = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastPx, mdz = pz - _lastPz
      cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _lastPx = px; _lastPz = pz
      const _beforeInflight = !!_inflight, _beforeLoaded = loaded.size
      streamRing(px, pz)
      if ((!!_inflight !== _beforeInflight) || (loaded.size !== _beforeLoaded)) _cullDirty = true
      wind.uCamPosXZ.value.set(px, pz)
      const decalOff = (typeof window !== 'undefined' && window.__grassDecal === false)
      const nowMs = t0 || ((typeof performance !== 'undefined') ? performance.now() : Date.now())
      const decalTimeDue = (nowMs - _lastDecalRefreshMs) >= DECAL_REFRESH_MS
      if (decalOff) {
        if (wind.uDecalCount.value !== 0) wind.uDecalCount.value = 0
      } else if (decalStore.stampCount > 0 && (_decalVersion !== decalStore.version || !cameraStill || decalTimeDue)) {
        _refreshDecalUniforms(px, pz)
        _decalVersion = decalStore.version
        _lastDecalRefreshMs = nowMs
      } else if (decalStore.stampCount === 0 && wind.uDecalCount.value !== 0) {
        wind.uDecalCount.value = 0
      }
    }
    wind.uGrassRing.value = ringRadius
    profile.totalInstances = totalInstances
    profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    if (typeof window !== 'undefined') window.__grassProfile = profile
    if (grassNodes) syncGrassMaterialTSL(grassNodes, wind)
  }

  function warmShaders(camera) { if (!camera) return 0; try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {} return 1 }

  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (cell.pending) continue
      if (!cell._occProxy) {
        const root = new THREE.Object3D()
        const perProxyOccBoxGeo = _occBoxGeo.clone()
        const boxMesh = new THREE.Mesh(perProxyOccBoxGeo, _occBoxMat)
        boxMesh.visible = false
        boxMesh.raycast = () => {}
        root.add(boxMesh)
        const rawH = cell.aabbMax[1] - cell.aabbMin[1]
        const MARGIN = 2, LIFT = Math.max(1, rawH * 0.5)
        const size = [cell.aabbMax[0] - cell.aabbMin[0] + MARGIN * 2, rawH + MARGIN * 2, cell.aabbMax[2] - cell.aabbMin[2] + MARGIN * 2]
        root.position.set((cell.aabbMin[0] + cell.aabbMax[0]) / 2, (cell.aabbMin[1] + cell.aabbMax[1]) / 2 + LIFT, (cell.aabbMin[2] + cell.aabbMax[2]) / 2)
        root.scale.set(Math.max(size[0], 1e-3), Math.max(size[1], 1e-3), Math.max(size[2], 1e-3))
        root.updateMatrixWorld(true)
        cell._occProxy = { root, key }
      }
      cell._occProxy.instanceCount = cell.entries.length
      out.push(cell._occProxy)
    }
    _occCands = out
    return out
  }
  function applyOcclusion(occludedKeys) {
    for (const [key, cell] of loaded) {
      if (cell.pending) continue
      const shouldHide = occludedKeys.has(key)
      if (shouldHide === cell.occluded) continue
      cell.occluded = shouldHide
      if (!cell.inFrustum) continue
      const mesh = cell.mesh || im
      for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, !shouldHide) } catch (_) {} }
    }
  }

  function dispose() {
    try { scene.remove(im.mesh || im); scene.remove(imMid.mesh || imMid) } catch (e) { _dbgGrass('scene.remove failed on dispose:', e?.message || e) }
    try { geoNear.dispose(); geoMid.dispose(); mat.dispose(); im.dispose && im.dispose(); imMid.dispose && imMid.dispose() } catch (e) { _dbgGrass('geo/mat/im dispose failed:', e?.message || e) }
    loaded.clear(); totalInstances = 0; _inflight = null; _occCands = null
    if (typeof window !== 'undefined' && window.__grass && window.__grass._im === im) delete window.__grass
  }

  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  async function prewarm(px, pz, budgetMs = 60000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    const ring = placementRing.ringAt(px, pz, placementRing.focusKeyAt(px, pz))
    let n = 0
    for (const key of ring) {
      if (totalInstances >= MAX_INSTANCES) break
      if (((typeof performance !== 'undefined') ? performance.now() : 0) - t0 > budgetMs) break
      if (placementRing.distSq(key, px, pz) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
      loadChunk(key, px, pz); if (!deferredChunks.has(key)) n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  function rebuildPlacement() { _inflight = null; deferredChunks.clear(); for (const key of [...loaded.keys()]) unloadChunk(key); _ringClean = false; _scanKey = NaN }
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, updateVisibility, tickWind, prewarm, warmShaders, dispose, _im: im, _imMid: imMid, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, setBenders, get benderCount() { return wind.uBenderCount.value }, get benderPosXZ() { return wind.uBenderPosXZ.value }, markScorched, decalStore, get decalCount() { return wind.uDecalCount.value }, get decalPosXZRS() { return wind.uDecalPosXZRS.value }, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__grass = api
  return api
}
