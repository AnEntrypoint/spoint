import * as THREE from 'three'
import { guardedGroundHeight } from '/src/terrain/PlanetFrame.js'
import { makeRockSDF, marchRockSurface, ROCK_MESH_RES } from '/src/terrain/RockShapes.js'
import { placementsForRockChunk, ROCK } from '/src/terrain/RockPlacement.js'
import { createExactPatchFrame } from './ExactPatchFrame.js'
import { createCullFreeze } from './CullFreeze.js'
import { createPlacementRing } from './PlacementRing.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { makeRocksMaterialTSL } from './RocksTSL.js'

const _dbgRocks = dbg('rocks')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 64
const ROCK_BASE_SEED = 1337
const ROCKS_OPAQUE_DRAW_BAND = 1

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _yawQ = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _m4 = new THREE.Matrix4(), _s = new THREE.Vector3(), _col = new THREE.Color()

function buildRockGeo(typeIndex, res) {
  const sdf = makeRockSDF(ROCK_BASE_SEED + typeIndex * 7919)
  const { positions, indices } = marchRockSurface(res, sdf)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3))
  g.setIndex(new THREE.BufferAttribute(indices.slice(), 1))
  g.computeVertexNormals()
  g.computeBoundingBox(); g.computeBoundingSphere()
  return g
}

function applyRockTexture(material) {
  material.flatShading = false
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vLocalPos;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocalPos = position;')
    shader.fragmentShader =
      'varying vec3 vLocalPos;\n' +
      'float rkHash(vec3 p){ p=fract(p*0.3183099+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n' +
      'float rkNoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);\n' +
      ' return mix(mix(mix(rkHash(i+vec3(0.,0.,0.)),rkHash(i+vec3(1.,0.,0.)),f.x),mix(rkHash(i+vec3(0.,1.,0.)),rkHash(i+vec3(1.,1.,0.)),f.x),f.y),\n' +
      '            mix(mix(rkHash(i+vec3(0.,0.,1.)),rkHash(i+vec3(1.,0.,1.)),f.x),mix(rkHash(i+vec3(0.,1.,1.)),rkHash(i+vec3(1.,1.,1.)),f.x),f.y),f.z); }\n' +
      shader.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n' +
        '  float rkN = rkNoise(vLocalPos*1.7)*0.6 + rkNoise(vLocalPos*6.5)*0.3 + rkNoise(vLocalPos*23.0)*0.1;\n' +
        '  vec3 rkLo=vec3(0.30,0.28,0.25), rkHi=vec3(0.66,0.62,0.56);\n' +
        '  diffuseColor.rgb *= mix(rkLo,rkHi,clamp(rkN,0.0,1.0))*2.05;')
  }
  material.customProgramCacheKey = () => 'rockproc-batched'
  return material
}

function skipUnchangedIndirectTextureUploads(bm, maxInstances) {
  const origOBR = bm.onBeforeRender
  let prevN = -1
  const prevStarts = new Int32Array(maxInstances)
  const prevCounts = new Int32Array(maxInstances)
  const prevIndirect = new Uint32Array(maxInstances)
  bm.onBeforeRender = function (renderer, sc, camera, geometry, material, group) {
    const tex = this._indirectTexture
    const vBefore = tex ? tex.version : 0
    origOBR.call(this, renderer, sc, camera, geometry, material, group)
    if (!tex) return
    const n = this._multiDrawCount
    const starts = this._multiDrawStarts, counts = this._multiDrawCounts, ind = tex.image.data
    let same = n === prevN
    if (same) for (let i = 0; i < n; i++) {
      if (starts[i] !== prevStarts[i] || counts[i] !== prevCounts[i] || ind[i] !== prevIndirect[i]) { same = false; break }
    }
    if (same) { tex.version = vBefore; return }
    prevN = n
    for (let i = 0; i < n; i++) { prevStarts[i] = starts[i]; prevCounts[i] = counts[i]; prevIndirect[i] = ind[i] }
  }
}

export async function createRocks(opts = {}) {
  const { renderer, scene, frame } = opts
  const biomeOverride = createBiomeOverride()
  const anchorField = biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createRocks: renderer/scene/frame required')

  const renderDistance = Number.isFinite(cfg.rockRenderDistance) ? cfg.rockRenderDistance : (cfg.renderDistance || 320)
  const ringRadius = renderDistance + 40
  const dropRadius = ringRadius + DROP_MARGIN
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.rockMaxInstances) ? cfg.rockMaxInstances : 12000

  const geos = []
  let buildErr = 0
  for (let t = 0; t < ROCK.TYPES; t++) {
    try { geos.push(buildRockGeo(t, ROCK_MESH_RES)) } catch (e) { buildErr++; geos.push(null); console.error('[rocks] geo build failed:', t, e?.message || e) }
  }
  let maxVerts = 0, maxIdx = 0
  for (const g of geos) { if (!g) continue; maxVerts += g.attributes.position.count; maxIdx += g.index ? g.index.count : 0 }
  maxVerts += 64; maxIdx += 64

  const mat = renderer.isWebGPURenderer
    ? makeRocksMaterialTSL()
    : applyRockTexture(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 }))
  const bm = new THREE.BatchedMesh(MAX_INSTANCES, maxVerts, maxIdx, mat)
  bm.frustumCulled = false
  bm.sortObjects = false
  skipUnchangedIndirectTextureUploads(bm, MAX_INSTANCES)
  const geomIds = []
  for (let t = 0; t < ROCK.TYPES; t++) {
    if (!geos[t]) { geomIds.push(-1); continue }
    try { geomIds.push(bm.addGeometry(geos[t])) } catch (e) { buildErr++; geomIds.push(-1); console.error('[rocks] addGeometry failed:', t, e?.message || e) }
  }
  scene.add(bm)
  bm.updateMatrix(); bm.matrixAutoUpdate = false
  bm.renderOrder = ROCKS_OPAQUE_DRAW_BAND
  const meshes = [{ im: bm, count: 0 }]

  const loaded = new Map()
  const deferredChunks = new Set()
  const exactFrame = createExactPatchFrame(frame)
  const placementRing = createPlacementRing(frame, ROCK, ringRadius)
  let _occCands = null
  let curSuper = null, totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, types: ROCK.TYPES, buildErrors: buildErr, batched: true }

  function loadChunk(key) {
    if (loaded.has(key)) return true
    const ids = []
    exactFrame.beginChunk()
    let list; try { list = placementsForRockChunk(key, exactFrame.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    if (exactFrame.missing) {
      deferredChunks.add(key)
      const c = placementRing.centre(key)
      exactFrame.prefetchChunk(c[0], c[1])
      return false
    }
    deferredChunks.delete(key)
    let _minY = Infinity, _maxY = -Infinity
    if (list) for (let i = 0; i < list.length; i++) {
      if (totalInstances >= MAX_INSTANCES) break
      const p = list[i]
      const gid = geomIds[p.type]
      if (gid < 0) continue
      _q.set(p.tiltQuat[0], p.tiltQuat[1], p.tiltQuat[2], p.tiltQuat[3])
      _yawQ.setFromAxisAngle(_v.set(0, 1, 0), p.yaw)
      _q.multiply(_yawQ)
      _s.set(p.scale, p.scale * p.squash, p.scale)
      _m4.compose(_v.set(p.x, p.y, p.z), _q, _s)
      let id = -1
      try { id = bm.addInstance(gid); bm.setMatrixAt(id, _m4) } catch (_) { continue }
      if (id < 0) continue
      const tint = 0.78 + p.variant * 0.4
      try { bm.setColorAt(id, _col.setScalar(Math.min(1, tint))) } catch (_) {}
      ids.push(id)
      totalInstances++
      const halfH = p.scale * p.squash
      if (p.y - halfH < _minY) _minY = p.y - halfH
      if (p.y + halfH > _maxY) _maxY = p.y + halfH
    }
    if (_minY === Infinity) {
      const c = placementRing.centre(key)
      let gh = guardedGroundHeight('rocks tile ground height', (x, z) => frame.groundHeightLocal(x, z), 0)(c[0], c[1])
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 2; _maxY = gh + 2
    }
    const b = placementRing.bounds(key, list)
    const _aabbMin = [b[0], _minY, b[1]], _aabbMax = [b[2], _maxY, b[3]]
    loaded.set(key, { ids, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false })
    _occCands = null
    meshes[0].count = totalInstances
    profile.loads++
    return true
  }

  function unloadChunk(key) {
    const cell = loaded.get(key); if (!cell) return
    for (const id of cell.ids) { try { bm.deleteInstance(id); totalInstances-- } catch (_) {} }
    loaded.delete(key); _occCands = null; meshes[0].count = totalInstances; profile.unloads++
  }

  const LOAD_BUDGET_MS = Number.isFinite(cfg.rockLoadBudgetMs) ? cfg.rockLoadBudgetMs : 2
  const DEFERRED_RETRIES_PER_FRAME = 4
  const _retryKeys = []
  let _ringClean = false, _scanKey = NaN
  let _rockSpiralCursor = 0
  const streamFocus = [NaN, NaN]
  function streamRing(px, pz) {
    streamFocus[0] = px; streamFocus[1] = pz
    const cKey = placementRing.focusKeyAt(px, pz)
    curSuper = cKey
    if (_ringClean && cKey === _scanKey) return
    profile.ringScans = (profile.ringScans || 0) + 1
    const ring = placementRing.ringAt(px, pz, cKey)
    if (cKey !== _scanKey) _rockSpiralCursor = 0
    let didLoad = false
    const loadT0 = performance.now()
    let attempts = 0
    _retryKeys.length = 0
    for (const key of deferredChunks) { if (_retryKeys.length >= DEFERRED_RETRIES_PER_FRAME) break; _retryKeys.push(key) }
    for (const key of _retryKeys) {
      if (attempts > 0 && performance.now() - loadT0 >= LOAD_BUDGET_MS) break
      deferredChunks.delete(key)
      if (placementRing.distSqFromFocus(key) > dropRadiusSq) continue
      attempts++
      if (loadChunk(key)) didLoad = true
    }
    for (let ringAttempts = 0; totalInstances < MAX_INSTANCES && (ringAttempts === 0 || performance.now() - loadT0 < LOAD_BUDGET_MS); ringAttempts++) {
      let found = false
      for (; _rockSpiralCursor < ring.length; _rockSpiralCursor++) {
        const key = ring[_rockSpiralCursor]
        if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
        if (loadChunk(key)) didLoad = true
        found = true; break
      }
      if (!found) break
    }
    let didDrop = false
    for (const key of loaded.keys()) {
      if (placementRing.distSqFromFocus(key) <= dropRadiusSq) continue
      if (didDrop && performance.now() - loadT0 >= LOAD_BUDGET_MS) break
      unloadChunk(key); didDrop = true
    }
    _scanKey = cKey; _ringClean = !didLoad && !didDrop && deferredChunks.size === 0
    profile.deferredChunks = deferredChunks.size
  }

  const cullFreeze = createCullFreeze((auto) => { bm.perObjectFrustumCulled = auto; profile.cullFrozen = !auto })
  let _cullDirty = true

  function update(dt, camera, playerPos) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (camera) { camera.getWorldPosition(_camPos); px = _camPos.x; pz = _camPos.z }
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const _beforeLoaded = loaded.size
      streamRing(px, pz)
      if (loaded.size !== _beforeLoaded) _cullDirty = true
    }
    profile.totalInstances = totalInstances; profile.visibleInstances = bm.instanceCount || totalInstances
    try { profile.drawCalls = renderer.info.render.calls } catch (_) {}
    profile.rockDrawCalls = 1
    profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    if (typeof window !== 'undefined') window.__rocksProfile = profile
  }

  function updateVisibility(camera, pose) {
    const live = _cullDirty
    _cullDirty = false
    cullFreeze.step(camera, pose, live)
  }

  function warmShaders(camera) {
    if (!camera) return 0
    try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {}
    return 1
  }

  function dispose() {
    try { scene.remove(bm) } catch (e) { _dbgRocks('scene.remove(bm) failed on dispose:', e?.message || e) }
    try { bm.dispose && bm.dispose() } catch (e) { _dbgRocks('BatchedMesh dispose failed:', e?.message || e) }
    try { mat.dispose() } catch (e) { _dbgRocks('material dispose failed:', e?.message || e) }
    for (const g of geos) { try { g && g.dispose() } catch (e) { _dbgRocks('rock geometry dispose failed:', e?.message || e) } }
    loaded.clear(); _occCands = null; totalInstances = 0; meshes.length = 0
    if (typeof window !== 'undefined' && window.__rocks && window.__rocks._bm === bm) delete window.__rocks
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
      if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key)) continue
      if (loadChunk(key)) n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (!cell._occProxy) {
        const root = new THREE.Object3D()
        const perProxyOccBoxGeo = _occBoxGeo.clone()
        const boxMesh = new THREE.Mesh(perProxyOccBoxGeo, _occBoxMat)
        boxMesh.visible = false
        boxMesh.raycast = () => {}
        root.add(boxMesh)
        const rawH = cell.aabbMax[1] - cell.aabbMin[1]
        const MARGIN = 2, LIFT = Math.max(2, rawH * 0.5)
        const size = [cell.aabbMax[0] - cell.aabbMin[0] + MARGIN * 2, rawH + MARGIN * 2, cell.aabbMax[2] - cell.aabbMin[2] + MARGIN * 2]
        root.position.set((cell.aabbMin[0] + cell.aabbMax[0]) / 2, (cell.aabbMin[1] + cell.aabbMax[1]) / 2 + LIFT, (cell.aabbMin[2] + cell.aabbMax[2]) / 2)
        root.scale.set(Math.max(size[0], 1e-3), Math.max(size[1], 1e-3), Math.max(size[2], 1e-3))
        root.updateMatrixWorld(true)
        cell._occProxy = { root, key }
      }
      cell._occProxy.instanceCount = cell.ids.length
      out.push(cell._occProxy)
    }
    _occCands = out
    return out
  }
  function applyOcclusion(occludedKeys) {
    for (const [key, cell] of loaded) {
      const shouldHide = occludedKeys.has(key)
      if (shouldHide === cell.occluded) continue
      cell.occluded = shouldHide
      for (const id of cell.ids) { try { bm.setVisibleAt(id, !shouldHide) } catch (_) {} }
    }
  }

  function rebuildPlacement() { for (const key of [...loaded.keys()]) unloadChunk(key); deferredChunks.clear(); curSuper = null; _ringClean = false; _scanKey = NaN }
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, streamState: () => placementRing.streamState(loaded, deferredChunks, streamFocus, ringRadiusSq, dropRadiusSq), updateVisibility, prewarm, warmShaders, dispose, _meshes: meshes, _bm: bm, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__rocks = api
  return api
}
