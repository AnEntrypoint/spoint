import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { placementsForGrassChunk, createGrassChunkCursor, GRASS } from '/src/terrain/GrassPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createModelExclusionField } from '/src/terrain/ModelExclusionField.js'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import { dbg } from './debug-log.js'
import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeBladeGeo, makeWind, makeGrassMaterial } from './GrassMaterial.js'
import { makeGrassMaterialTSL, syncGrassMaterialTSL } from './GrassTSL.js'
import { createStreamingInstancer } from './WebGPUInstancing.js'

const GRASS_ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'float', instShadow: 'float' }

export { MAX_BENDERS, MAX_DECALS }

const _dbgGrass = dbg('grass')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 16
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
  const geoNear = makeBladeGeo(5)
  const geoMid = makeBladeGeo(1)

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
  let _occCands = null
  let totalInstances = 0
  const profile = { totalInstances: 0, loads: 0, unloads: 0, updateMs: 0, grassDrawCalls: 2, ringScans: 0, cullMs: 0, chunksCulled: 0 }
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  function commitChunk(key, list, px, pz) {
    const ci2 = key.indexOf(','); const kcx = +key.slice(0, ci2), kcz = +key.slice(ci2 + 1)
    const minX = kcx * CH, maxX = minX + CH, minZ = kcz * CH, maxZ = minZ + CH
    const centerX = minX + CH * 0.5, centerZ = minZ + CH * 0.5
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
        e.scale.set(1, p.scale, 1)
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
    const _aabbMin = [kcx * CH, _minY, kcz * CH], _aabbMax = [(kcx + 1) * CH, _maxY, (kcz + 1) * CH]
    loaded.set(key, { entries, mesh: targetMesh, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false, inFrustum: true })
    _occCands = null
    profile.loads++
  }

  function loadChunk(cx, cz, px, pz) {
    const key = cx + ',' + cz
    if (loaded.has(key)) return
    let list; try { list = placementsForGrassChunk(cx, cz, frame, anchorField, worldSeed) } catch (_) { list = null }
    commitChunk(key, list, px, pz)
  }

  function unloadChunk(key) {
    const cell = loaded.get(key); if (!cell) return
    const mesh = cell.mesh || im
    for (const en of cell.entries) { try { mesh.removeInstances(en.id); totalInstances-- } catch (_) {} }
    loaded.delete(key); _occCands = null; profile.unloads++
  }

  const CH = GRASS.CHUNK
  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  function _spiralOffsets(span) {
    const out = []
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dz) <= span) out.push([dx, dz])
    out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
    return out
  }
  let _spiral = null, _spiralSpan = -1
  const LOAD_BUDGET = Number.isFinite(cfg.grassLoadBudgetMs) ? cfg.grassLoadBudgetMs : 4
  let _inflight = null
  function streamRing(px, pz) {
    if (_inflight) {
      if (_inflight.cursor.step(LOAD_BUDGET)) { commitChunk(_inflight.key, _inflight.cursor.blades, _inflight.px, _inflight.pz); _inflight = null }
      else { _ringClean = false; return }
    }
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return
    profile.ringScans++
    const span = Math.ceil(ringRadius / CH)
    if (span !== _spiralSpan) { _spiral = _spiralOffsets(span); _spiralSpan = span }
    let didLoad = false, didDrop = false
    if (totalInstances < MAX_INSTANCES) {
      for (const [dx, dz] of _spiral) {
        const cx = cCx + dx, cz = cCz + dz
        const key = cx + ',' + cz
        const ddx = cx * CH + CH * 0.5 - px, ddz = cz * CH + CH * 0.5 - pz
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(key)) continue
        loaded.set(key, { entries: [], pending: true })
        _inflight = { key, cursor: createGrassChunkCursor(cx, cz, frame, anchorField, worldSeed), px, pz }
        if (_inflight.cursor.step(LOAD_BUDGET)) { loaded.delete(key); commitChunk(key, _inflight.cursor.blades, px, pz); _inflight = null }
        didLoad = true; break
      }
    }
    for (const key of loaded.keys()) {
      if (_inflight && key === _inflight.key) continue
      const ci = key.indexOf(','); const kx = +key.slice(0, ci), kz = +key.slice(ci + 1)
      const ddx = kx * CH + CH * 0.5 - px, ddz = kz * CH + CH * 0.5 - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) { unloadChunk(key); didDrop = true; break }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop && !_inflight
  }

  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985
  const _cullQ = new THREE.Quaternion()

  function setBenders(list) {
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
    if (typeof window !== 'undefined' && window.__grassBend === false) setBenders(null)
    else setBenders(benders)
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (camera) { camera.getWorldPosition(_camPos); px = _camPos.x; pz = _camPos.z }
    let cameraStill = false, _streamMutated = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastPx, mdz = pz - _lastPz
      cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleFrames = cameraStill ? _idleFrames + 1 : 0
      _lastPx = px; _lastPz = pz
      const _beforeInflight = !!_inflight, _beforeLoaded = loaded.size
      streamRing(px, pz)
      _streamMutated = (!!_inflight !== _beforeInflight) || (loaded.size !== _beforeLoaded)
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
    let rotationStill = true
    if (camera) {
      camera.getWorldQuaternion(_cullQ)
      if (Number.isFinite(_lastQw)) {
        const dot = _cullQ.x * _lastQx + _cullQ.y * _lastQy + _cullQ.z * _lastQz + _cullQ.w * _lastQw
        rotationStill = Math.abs(dot) >= ROT_COS_EPS
      } else rotationStill = false
      _lastQx = _cullQ.x; _lastQy = _cullQ.y; _lastQz = _cullQ.z; _lastQw = _cullQ.w
    }
    const wantFrozen = cameraStill && rotationStill && _idleFrames > 0 && !_streamMutated
    if (wantFrozen !== _cullFrozen) {
      _cullFrozen = wantFrozen
      im.autoUpdate = !wantFrozen; imMid.autoUpdate = !wantFrozen
      profile.cullFrozen = wantFrozen
    }
    wind.uGrassRing.value = ringRadius
    if (!wantFrozen && camera) {
      const tc0 = (typeof performance !== 'undefined') ? performance.now() : 0
      _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projMat)
      let culledCount = 0
      for (const [key, cell] of loaded) {
        if (cell.pending) continue
        _cullBox.min.set(cell.aabbMin[0], cell.aabbMin[1], cell.aabbMin[2])
        _cullBox.max.set(cell.aabbMax[0], cell.aabbMax[1], cell.aabbMax[2])
        const inFrustum = _frustum.intersectsBox(_cullBox)
        if (inFrustum === cell.inFrustum) { if (!inFrustum) culledCount++; continue }
        cell.inFrustum = inFrustum
        if (!inFrustum) culledCount++
        if (cell.occluded) continue
        const mesh = cell.mesh || im
        for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, inFrustum) } catch (_) {} }
      }
      profile.chunksCulled = culledCount
      profile.cullMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - tc0
    }
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
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _spiralSpan) { _spiral = _spiralOffsets(span); _spiralSpan = span }
    let n = 0
    for (const [dx, dz] of _spiral) {
      if (totalInstances >= MAX_INSTANCES) break
      if (((typeof performance !== 'undefined') ? performance.now() : 0) - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH + CH * 0.5 - px, ddz = cz * CH + CH * 0.5 - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
      loadChunk(cx, cz, px, pz); n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  function rebuildPlacement() { _inflight = null; for (const key of [...loaded.keys()]) unloadChunk(key); _ringClean = false; _scanCx = NaN; _scanCz = NaN }
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, tickWind, prewarm, warmShaders, dispose, _im: im, _imMid: imMid, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, setBenders, get benderCount() { return wind.uBenderCount.value }, get benderPosXZ() { return wind.uBenderPosXZ.value }, markScorched, decalStore, get decalCount() { return wind.uDecalCount.value }, get decalPosXZRS() { return wind.uDecalPosXZRS.value }, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__grass = api
  return api
}
