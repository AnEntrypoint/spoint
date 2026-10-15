import * as THREE from 'three'
import { RenderControls } from './RenderControls.js'
import { commitTileExtent } from './TileExtent.js'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createExactPatchFrame } from './ExactPatchFrame.js'
import { createCullFreeze, setInstancedCullAuto } from './CullFreeze.js'
import { createPlacementRing } from './PlacementRing.js'
import { placementsForGrassChunk, createGrassChunkCursor, GRASS, GRASS_DENSITY, grassBladeEdgeM } from '/src/terrain/GrassPlacement.js'
import { createGrassChunkLod } from '/src/terrain/GrassPlacementLod.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createModelExclusionField } from '/src/terrain/ModelExclusionField.js'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import { dbg } from './debug-log.js'
import { MAX_BENDERS, MAX_DECALS, UNUSED_BENDER_SLOT_XZ, makeWind, makeGrassMaterial, setGrassSun } from './GrassMaterial.js'
import { makeClumpGeo } from './GrassClump.js'
import { makeGrassMaterialTSL, syncGrassMaterialTSL } from './GrassTSL.js'
import { positionWorld, vec4, mix, float, uniform } from 'three/tsl'
import { contactOcclusionFactorAt } from '/node_modules/mapspinner/src/tsl/contact-occlusion-tsl.js'
import { createStreamingInstancer } from './WebGPUInstancing.js'
import { runWarmPasses } from './ProgramReadiness.js'
import { macrotaskYield } from './macrotaskYield.js'

const GRASS_ATTRIBUTE_SCHEMA = { windShadow: 'vec2', groundTint: 'vec4', clumpRank: 'float' }
const _windShadowArr = [0, 0], _groundTintArr = [0, 0, 0, 0]
const _windShadowVec = new THREE.Vector2(), _groundTintVec = new THREE.Vector4()

export { MAX_BENDERS, MAX_DECALS }

const _dbgGrass = dbg('grass')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 16
const CLUMP_WIDTH_MIN = 2.268
const CLUMP_WIDTH_SPAN = 1.176
const CLUMP_HEIGHT_SCALE = 0.75
const GRASS_ANIM_SPEED = 0.25
const REGROWTH_DISABLED_HALF_LIFE_S = 1e12
const CULL_ENTRY_BUDGET = 8192
const XF_FLOATS = 9
const PF_FLOATS = 7
const LOD_REVISIT_STEP_M = 4
const LOD_REVISIT_BUDGET = 2048
const _up = new THREE.Vector3(0, 1, 0), _nrm = new THREE.Vector3(), _q = new THREE.Quaternion(), _qTilt = new THREE.Quaternion(), _camPos = new THREE.Vector3()

export async function createGrass(opts = {}) {
  const { renderer, scene, frame } = opts
  const biomeOverride = createBiomeOverride()
  const modelExclusion = createModelExclusionField(opts.placedModels)
  const anchorField = modelExclusion.wrapClimateField(biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame)))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createGrass: renderer/scene/frame required')
  if (cfg.grass === false) return null

  const renderDistance = Number.isFinite(cfg.grassRenderDistance) ? cfg.grassRenderDistance : 88
  const ringRadius = renderDistance, dropRadius = ringRadius + DROP_MARGIN
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.grassMaxInstances) ? cfg.grassMaxInstances : 540000
  const INIT_CAP = Math.min(MAX_INSTANCES, 4096)

  const wind = makeWind()
  const isWebGPU = !!renderer.isWebGPURenderer

  const LOD_NEAR_DIST = Number.isFinite(cfg.grassLodNearDistance) ? cfg.grassLodNearDistance : 8

  // A blade's edge radius is at least FULL_R, so inside FULL_R the law keeps everything and the
  // population is the one the near-LOD pin already measures. Everything the law removes is beyond.
  const FULL_R = Number.isFinite(cfg.grassDensityFullR) ? cfg.grassDensityFullR : GRASS_DENSITY.FULL_R
  const DENSITY_LEAD_M = GRASS_DENSITY.LEAD_M
  // The outermost blades' fade has to finish inside the ring, or the ring's edge is a hard cut.
  const EDGE_CAP_M = Math.max(FULL_R + GRASS_DENSITY.FADE_M + 1, ringRadius - GRASS_DENSITY.EDGE_M)
  const DENSITY_REACH_M = EDGE_CAP_M + DENSITY_LEAD_M
  const DENSITY_REACH_SQ = DENSITY_REACH_M * DENSITY_REACH_M
  // The placement a chunk is generated with knows the law, so it can materialise the blades the
  // law will draw at this distance and refine as the player closes. null is the whole-chunk
  // placement it replaces, kept only so the two can be measured against each other.
  const LOD_LAW = (cfg.grassPlacementLod === false) ? null : {
    fullR: FULL_R, capM: EDGE_CAP_M, leadM: GRASS_DENSITY.LEAD_M,
    spreadM: Number.isFinite(cfg.grassLodSpreadM) ? cfg.grassLodSpreadM : undefined,
    slackM: Number.isFinite(cfg.grassLodSlackM) ? cfg.grassLodSlackM : undefined,
    releaseM: Number.isFinite(cfg.grassLodReleaseM) ? cfg.grassLodReleaseM : undefined,
  }
  const REFINE_BUDGET_MS = Number.isFinite(cfg.grassRefineBudgetMs) ? cfg.grassRefineBudgetMs : 2
  const densityCfg = {
    fullR: FULL_R, p: GRASS_DENSITY.P, fadeM: GRASS_DENSITY.FADE_M,
    growMax: GRASS_DENSITY.GROW_MAX, growK: GRASS_DENSITY.GROW_K,
    faceStart: GRASS_DENSITY.FACE_START, faceEnd: GRASS_DENSITY.FACE_END,
  }

  // The wind bend is quadratic in the card height coordinate (gw = gv*gv*0.45), so three rows
  // (two segments) is the fewest that still carries the curve; a fourth row only subdivides it.
  const geoNear = makeClumpGeo(2, 1)
  const geoMid = makeClumpGeo(1, 1)

  let mat, im, imMid, grassNodes = null
  let uGrassContactOcc = null
  if (isWebGPU) {
    const built = makeGrassMaterialTSL(wind, densityCfg)
    mat = built.material
    grassNodes = built.nodes
    uGrassContactOcc = uniform(1)
    const grassColor = mat.colorNode
    mat.colorNode = vec4(grassColor.rgb.mul(mix(float(1.0), contactOcclusionFactorAt(positionWorld.xz), uGrassContactOcc)), grassColor.a)
    im = createStreamingInstancer(scene, geoNear, mat, INIT_CAP, GRASS_ATTRIBUTE_SCHEMA)
    imMid = createStreamingInstancer(scene, geoMid, mat, Math.min(INIT_CAP, 2048), GRASS_ATTRIBUTE_SCHEMA)
  } else {
    mat = makeGrassMaterial(wind, densityCfg)
    im = new InstancedMesh2(geoNear, mat, { capacity: INIT_CAP, renderer })
    imMid = new InstancedMesh2(geoMid, mat, { capacity: Math.min(INIT_CAP, 2048), renderer })
    for (const m of [im, imMid]) {
      m.initUniformsPerInstance({ vertex: { windShadow: 'vec2', groundTint: 'vec4', clumpRank: 'float' } })
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
  let nearInstances = 0
  const profile = { totalInstances: 0, nearInstances: 0, midInstances: 0, loads: 0, unloads: 0, updateMs: 0, grassDrawCalls: 2, ringScans: 0, cullMs: 0, chunksCulled: 0, prewarmMs: 0, prewarmWorkMs: 0, prewarmChunks: 0, lodRevisits: 0, lodMigrations: 0, densityAdds: 0, densityRemoves: 0, revisitAdds: 0, revisitRemoves: 0, refines: 0, refineBlades: 0, refineMs: 0, released: 0 }
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  function clumpLodNear(x, z, px, pz) {
    const ddx = x - px, ddz = z - pz
    return !(ddx * ddx + ddz * ddz > LOD_NEAR_DIST * LOD_NEAR_DIST)
  }

  function writeBlade(e, cell, i) {
    const o = i * XF_FLOATS
    const tint = cell.xf[o + 8]
    e.position.set(cell.xf[o], cell.xf[o + 1], cell.xf[o + 2])
    e.quaternion.set(cell.xf[o + 3], cell.xf[o + 4], cell.xf[o + 5], cell.xf[o + 6])
    const width = CLUMP_WIDTH_MIN + CLUMP_WIDTH_SPAN * tint
    e.scale.set(width, cell.xf[o + 7] * CLUMP_HEIGHT_SCALE, width)
  }

  function writeInstanceUniforms(mesh, cell, i) {
    const id = cell.entries[i].id
    const o = i * PF_FLOATS, pf = cell.pf
    const edgeRankPow = Math.fround(Math.pow(Math.max(pf[o], 1e-4), Math.fround(1 / GRASS_DENSITY.P)))
    _windShadowArr[0] = pf[o + 1]; _windShadowArr[1] = pf[o + 3]
    _groundTintArr[0] = pf[o + 4]; _groundTintArr[1] = pf[o + 5]; _groundTintArr[2] = pf[o + 6]; _groundTintArr[3] = pf[o + 2]
    if (isWebGPU) {
      mesh.setUniformAt(id, 'windShadow', _windShadowArr)
      mesh.setUniformAt(id, 'groundTint', _groundTintArr)
      mesh.setUniformAt(id, 'clumpRank', edgeRankPow)
    } else {
      mesh.setUniformAt(id, 'windShadow', _windShadowVec.fromArray(_windShadowArr))
      mesh.setUniformAt(id, 'groundTint', _groundTintVec.fromArray(_groundTintArr))
      mesh.setUniformAt(id, 'clumpRank', edgeRankPow)
    }
  }

  function addBlades(cell, idx, near) {
    const to = near ? im : imMid
    let _n = 0
    to.addInstances(idx.length, (e, id) => {
      const i = idx[_n++]
      writeBlade(e, cell, i)
      cell.entries[i] = { id, near }
      cell.lod[i] = near ? 1 : 0
      cell.on[i] = 1
    })
    totalInstances += idx.length
    cell.onCount += idx.length
    if (near) { cell.nearCount += idx.length; nearInstances += idx.length }
    const hide = cell.inFrustum === false || cell.occluded === true
    for (const i of idx) {
      try {
        writeInstanceUniforms(to, cell, i)
        if (hide) to.setVisibilityAt(cell.entries[i].id, false)
      } catch (_) {}
    }
    profile.densityAdds += idx.length
  }

  function removeBlades(cell, idx) {
    for (const i of idx) {
      const en = cell.entries[i]
      if (!en) continue
      try { (en.near ? im : imMid).removeInstances(en.id) } catch (_) {}
      totalInstances--
      cell.onCount--
      if (en.near) { nearInstances--; cell.nearCount-- }
      cell.entries[i] = null
      cell.on[i] = 0
    }
    profile.densityRemoves += idx.length
  }

  // One blade row: the transform and the per-instance payload, plus the squared reach the LOD
  // revisit decides the blade against. Nothing here touches an instancer.
  function writeRow(p, i, xf, pf, lod, keepR2, px, pz, classify, chunkNear) {
    _q.setFromAxisAngle(_up, p.yaw)
    _qTilt.setFromUnitVectors(_up, _nrm.set(p.nx, p.ny, p.nz))
    _q.premultiply(_qTilt)
    const o = i * XF_FLOATS
    xf[o] = p.x; xf[o + 1] = p.y; xf[o + 2] = p.z
    xf[o + 3] = _q.x; xf[o + 4] = _q.y; xf[o + 5] = _q.z; xf[o + 6] = _q.w
    xf[o + 7] = p.scale; xf[o + 8] = p.tint
    const o7 = i * PF_FLOATS
    pf[o7] = Number.isFinite(p.q) ? p.q : 0
    pf[o7 + 1] = p.windPhase
    pf[o7 + 2] = p.tint
    pf[o7 + 3] = Number.isFinite(p.shadow) ? p.shadow : 1
    pf[o7 + 4] = p.groundR; pf[o7 + 5] = p.groundG; pf[o7 + 6] = p.groundB
    const near = classify ? (lodRevisit ? clumpLodNear(p.x, p.z, px, pz) : chunkNear) : true
    lod[i] = near ? 1 : 0
    const reach = grassBladeEdgeM(pf[o7], FULL_R, EDGE_CAP_M) + DENSITY_LEAD_M
    keepR2[i] = reach * reach
    return near
  }

  // A chunk's population grows as the player closes on it and gives back what the law has finished
  // with as the player recedes, so the buffers behind a cell are held with headroom and a change of
  // size is a new view over the same bytes. views() re-slices, buffers() (re)allocates.
  function buffersFor(cell, count) {
    const reuse = !!(cell && cell.bufXf && cell.cap >= count)
    const cap = reuse ? cell.cap : Math.max(64, count, Math.ceil(count * 1.4))
    if (reuse) return null
    return {
      cap,
      bufXf: new Float32Array(cap * XF_FLOATS), bufPf: new Float32Array(cap * PF_FLOATS),
      bufLod: new Uint8Array(cap), bufOn: new Uint8Array(cap), bufKeep: new Float32Array(cap),
      allEntries: new Array(cap),
    }
  }

  function viewsFor(cell, bufs, count) {
    const bufXf = bufs ? bufs.bufXf : cell.bufXf
    const bufPf = bufs ? bufs.bufPf : cell.bufPf
    const bufLod = bufs ? bufs.bufLod : cell.bufLod
    const bufOn = bufs ? bufs.bufOn : cell.bufOn
    const bufKeep = bufs ? bufs.bufKeep : cell.bufKeep
    return {
      cap: bufs ? bufs.cap : cell.cap, bufXf, bufPf, bufLod, bufOn, bufKeep,
      allEntries: bufs ? bufs.allEntries : cell.allEntries,
      xf: bufXf.subarray(0, count * XF_FLOATS), pf: bufPf.subarray(0, count * PF_FLOATS),
      lod: bufLod.subarray(0, count), on: bufOn.subarray(0, count), keepR2: bufKeep.subarray(0, count),
    }
  }

  function commitChunk(key, list, px, pz, src) {
    const [minX, minZ, maxX, maxZ] = placementRing.bounds(key, list)
    const [centerX, centerZ] = placementRing.centre(key)
    const count = list ? Math.max(0, Math.min(list.length, MAX_INSTANCES - totalInstances)) : 0
    const bufs = buffersFor(null, count)
    const v = viewsFor(null, bufs, count)
    const nearIdx = [], midIdx = []
    const classify = Number.isFinite(px) && Number.isFinite(pz)
    let chunkNear = true
    if (classify && !lodRevisit) {
      const nearestX = px < minX ? minX : (px > maxX ? maxX : px)
      const nearestZ = pz < minZ ? minZ : (pz > maxZ ? maxZ : pz)
      const ddx = nearestX - px, ddz = nearestZ - pz
      chunkNear = !(ddx * ddx + ddz * ddz > LOD_NEAR_DIST * LOD_NEAR_DIST)
    }
    let _minY = Infinity, _maxY = -Infinity
    for (let i = 0; i < count; i++) {
      const p = list[i]
      if (p.y < _minY) _minY = p.y
      if (p.y + p.scale > _maxY) _maxY = p.y + p.scale
      const near = writeRow(p, i, v.xf, v.pf, v.lod, v.keepR2, px, pz, classify, chunkNear)
      const ddx = p.x - px, ddz = p.z - pz
      if (!classify || (ddx * ddx + ddz * ddz < v.keepR2[i])) {
        v.on[i] = 1
        if (near) nearIdx.push(i)
        else midIdx.push(i)
      }
    }
    const cell = Object.assign({
      key, xf: v.xf, pf: v.pf, lod: v.lod, on: v.on, keepR2: v.keepR2, entries: v.allEntries,
      count, bounds: [minX, minZ, maxX, maxZ], cx: centerX, cz: centerZ,
      nearCount: 0, onCount: 0, occluded: false, inFrustum: true,
      minY: _minY, maxY: _maxY, src: src || null,
    }, v)
    if (nearIdx.length) addBlades(cell, nearIdx, true)
    if (midIdx.length) addBlades(cell, midIdx, false)
    const extent = commitTileExtent('grass tile ground height', (x, z) => frame.groundHeightLocal(x, z), [centerX, centerZ], [minX, minZ, maxX, maxZ], _minY, _maxY, 1)
    for (const k in extent) cell[k] = extent[k]
    loaded.set(key, cell)
    _occCands = null
    profile.loads++
  }

  // The chunk grew: the blades it gained are written into the cell it already holds, and they
  // start switched off. Nothing is added to an instancer here -- revisit owns instances, and it
  // already decides every blade in the cell every LOD_REVISIT_STEP_M of travel -- so a growth
  // costs the rows it writes and not a re-commit.
  function appendChunk(cell, list, px, pz) {
    const from = cell.count
    const count = Math.min(list.length, from + Math.max(0, MAX_INSTANCES - totalInstances))
    const bufs = buffersFor(cell, count)
    if (bufs) {
      bufs.bufXf.set(cell.xf)
      bufs.bufPf.set(cell.pf)
      bufs.bufLod.set(cell.lod)
      bufs.bufOn.set(cell.on)
      bufs.bufKeep.set(cell.keepR2)
      for (let i = 0; i < from; i++) bufs.allEntries[i] = cell.entries[i]
    }
    const v = viewsFor(cell, bufs, count)
    const classify = Number.isFinite(px) && Number.isFinite(pz)
    const chunkNear = false
    let minX = cell.bounds[0], minZ = cell.bounds[1], maxX = cell.bounds[2], maxZ = cell.bounds[3]
    for (let i = from; i < count; i++) {
      const p = list[i]
      if (p.y < cell.minY) cell.minY = p.y
      if (p.y + p.scale > cell.maxY) cell.maxY = p.y + p.scale
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.z < minZ) minZ = p.z
      if (p.z > maxZ) maxZ = p.z
      writeRow(p, i, v.xf, v.pf, v.lod, v.keepR2, px, pz, classify, chunkNear)
      v.on[i] = 0
    }
    // The bounds a commit takes already carry the chunk's own corners, so a growth only has to
    // widen them by the blades it wrote: re-scanning the whole population would be the same
    // answer at the cost of the whole population.
    Object.assign(cell, v, { count, entries: v.allEntries, bounds: [minX, minZ, maxX, maxZ] })
    const extent = commitTileExtent('grass tile ground height', (x, z) => frame.groundHeightLocal(x, z), [cell.cx, cell.cz], [minX, minZ, maxX, maxZ], cell.minY, cell.maxY, 1)
    for (const k in extent) cell[k] = extent[k]
    _occCands = null
    profile.refines++
  }

  function loadChunk(key, px, pz) {
    if (loaded.has(key)) return
    exactFrame.beginChunk()
    let list; try { list = placementsForGrassChunk(key, exactFrame.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    if (exactFrame.missing) { deferGrassChunk(key); return }
    commitChunk(key, list, px, pz, null)
  }

  function deferGrassChunk(key) {
    deferredChunks.add(key)
    const c = placementRing.centre(key)
    exactFrame.prefetchChunk(c[0], c[1])
  }

  function unloadChunk(key) {
    const cell = loaded.get(key); if (!cell) return
    cell.detached = true
    for (const en of cell.entries) {
      if (!en) continue
      try { (en.near ? im : imMid).removeInstances(en.id); totalInstances-- } catch (_) {}
    }
    nearInstances -= cell.nearCount || 0
    loaded.delete(key); _occCands = null; profile.unloads++
  }

  let lodRevisit = true
  const _flipCell = [], _flipIdx = []
  let _lodEvalPx = NaN, _lodEvalPz = NaN

  function moveClumpsToLod(cell, idx, near) {
    const from = near ? imMid : im
    const to = near ? im : imMid
    for (const i of idx) { try { from.removeInstances(cell.entries[i].id) } catch (_) {} }
    let _n = 0
    to.addInstances(idx.length, (e, id) => {
      const i = idx[_n++]
      const en = cell.entries[i]
      writeBlade(e, cell, i)
      en.id = id
      en.near = near
      cell.lod[i] = near ? 1 : 0
    })
    const delta = near ? idx.length : -idx.length
    cell.nearCount += delta
    nearInstances += delta
    const hide = cell.inFrustum === false || cell.occluded === true
    for (const i of idx) {
      const en = cell.entries[i]
      try {
        writeInstanceUniforms(to, cell, i)
        if (hide) to.setVisibilityAt(en.id, false)
      } catch (_) {}
    }
    profile.lodMigrations += idx.length
  }

  // Two decisions per blade, re-taken together every LOD_REVISIT_STEP_M of travel: whether the
  // distance-density law still holds the blade at all, and if it does, which of the two clump
  // geometries it is drawn with. The first is the one that moves the instance count.
  function scanChunk(cell, px, pz) {
    if (cell.pending || !cell.xf || !cell.keepR2 || !cell.bounds) return
    const b = cell.bounds
    const nearestX = px < b[0] ? b[0] : (px > b[2] ? b[2] : px)
    const nearestZ = pz < b[1] ? b[1] : (pz > b[3] ? b[3] : pz)
    const ddx = nearestX - px, ddz = nearestZ - pz
    const nearestSq = ddx * ddx + ddz * ddz
    // A chunk whose nearest corner is already past the law's reach holds nothing the law
    // could switch on, so it only costs a pass while it still holds something switched on.
    const chunkOutside = nearestSq > LOD_NEAR_DIST * LOD_NEAR_DIST
    if (nearestSq > DENSITY_REACH_SQ && cell.onCount === 0) return
    const xf = cell.xf, keepR2 = cell.keepR2, on = cell.on, lod = cell.lod
    for (let i = 0; i < on.length; i++) {
      const o = i * XF_FLOATS
      const bdx = xf[o] - px, bdz = xf[o + 2] - pz
      const inReach = bdx * bdx + bdz * bdz < keepR2[i]
      if (inReach !== (on[i] === 1)) { _flipCell.push(cell); _flipIdx.push(i); continue }
      if (!inReach) continue
      const wantNear = chunkOutside ? false : clumpLodNear(xf[o], xf[o + 2], px, pz)
      if (wantNear !== (lod[i] === 1)) { _flipCell.push(cell); _flipIdx.push(i) }
    }
  }

  // A released blade keeps its instance: the row it owns is dropped and the rows behind it close
  // up, which is a move of the row and not of the instance it names.
  function compactChunk(cell, drop, px, pz) {
    const n = cell.count
    if (!n || !drop.length) return
    const live = []
    for (const i of drop) if (cell.on[i] === 1) live.push(i)
    if (live.length) { removeBlades(cell, live); profile.densityRemoves += live.length }
    let w = 0, ri = 0, r = 0
    while (r < n) {
      if (ri < drop.length && drop[ri] === r) { ri++; r++; continue }
      const r0 = r
      while (r < n && !(ri < drop.length && drop[ri] === r)) r++
      if (w !== r0) {
        cell.xf.copyWithin(w * XF_FLOATS, r0 * XF_FLOATS, r * XF_FLOATS)
        cell.pf.copyWithin(w * PF_FLOATS, r0 * PF_FLOATS, r * PF_FLOATS)
        cell.lod.copyWithin(w, r0, r)
        cell.on.copyWithin(w, r0, r)
        cell.keepR2.copyWithin(w, r0, r)
        cell.entries.copyWithin(w, r0, r)
      }
      w += r - r0
    }
    for (let i = w; i < n; i++) cell.entries[i] = null
    Object.assign(cell, viewsFor(cell, null, w))
    cell.count = w
    profile.released += drop.length
    // The flips the chunk had queued name rows that have just moved, so they are dropped and the
    // chunk is re-scanned at the position they were taken at: a scan is the same decisions again.
    if (dropFlips(cell)) scanChunk(cell, px, pz)
  }

  function dropFlips(cell) {
    let w = 0, dropped = 0
    for (let r = 0; r < _flipIdx.length; r++) {
      if (_flipCell[r] === cell) { dropped++; continue }
      _flipCell[w] = _flipCell[r]; _flipIdx[w] = _flipIdx[r]; w++
    }
    _flipCell.length = w; _flipIdx.length = w
    return dropped
  }

  function revisitNearLod(px, pz) {
    if (!lodRevisit) {
      if (_flipIdx.length) { _flipIdx.length = 0; _flipCell.length = 0 }
      return
    }
    if (!(Number.isFinite(px) && Number.isFinite(pz))) return
    const dx = px - _lodEvalPx, dz = pz - _lodEvalPz
    const moved = !Number.isFinite(_lodEvalPx) || !(dx * dx + dz * dz < LOD_REVISIT_STEP_M * LOD_REVISIT_STEP_M)
    if (!moved && _flipIdx.length === 0) return
    _lodEvalPx = px; _lodEvalPz = pz
    if (moved) {
      _flipIdx.length = 0; _flipCell.length = 0
      profile.lodRevisits++
      for (const cell of loaded.values()) scanChunk(cell, px, pz)
    }
    const batches = new Map()
    let budget = LOD_REVISIT_BUDGET
    while (_flipIdx.length > 0 && budget > 0) {
      const cell = _flipCell.pop(), i = _flipIdx.pop()
      if (!cell || cell.detached || cell.pending || !cell.xf) continue
      const o = i * XF_FLOATS
      const bdx = cell.xf[o] - px, bdz = cell.xf[o + 2] - pz
      const inReach = bdx * bdx + bdz * bdz < cell.keepR2[i]
      const live = cell.on[i] === 1
      let g = batches.get(cell)
      if (!g) { g = { addNear: [], addMid: [], drop: [], toNear: [], toMid: [] }; batches.set(cell, g) }
      if (!inReach && live) g.drop.push(i)
      else if (inReach && !live) {
        if (clumpLodNear(cell.xf[o], cell.xf[o + 2], px, pz)) g.addNear.push(i)
        else g.addMid.push(i)
      } else if (inReach && live) {
        const wantNear = clumpLodNear(cell.xf[o], cell.xf[o + 2], px, pz)
        if (wantNear !== (cell.lod[i] === 1)) { if (wantNear) g.toNear.push(i); else g.toMid.push(i) }
        else continue
      } else continue
      budget--
    }
    for (const [cell, g] of batches) {
      if (g.drop.length) { removeBlades(cell, g.drop); profile.revisitRemoves += g.drop.length }
      if (g.toMid.length) moveClumpsToLod(cell, g.toMid, false)
      if (g.toNear.length) moveClumpsToLod(cell, g.toNear, true)
      if (g.addMid.length) { addBlades(cell, g.addMid, false); profile.revisitAdds += g.addMid.length }
      if (g.addNear.length) { addBlades(cell, g.addNear, true); profile.revisitAdds += g.addNear.length }
    }
  }

  let _ringClean = false, _scanKey = NaN
  const LOAD_BUDGET = Number.isFinite(cfg.grassLoadBudgetMs) ? cfg.grassLoadBudgetMs : 4
  let _inflight = null
  const streamFocus = [NaN, NaN]
  function streamRing(px, pz) {
    streamFocus[0] = px; streamFocus[1] = pz
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
        if (placementRing.distSqFromFocus(key) > dropRadiusSq) continue
        startInflight(key, px, pz)
        didLoad = true; break
      }
    }
    if (totalInstances < MAX_INSTANCES && !_inflight) {
      for (const key of ring) {
        if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
        startInflight(key, px, pz)
        didLoad = true; break
      }
    }
    for (const key of loaded.keys()) {
      if (_inflight && key === _inflight.key) continue
      if (placementRing.distSqFromFocus(key) > dropRadiusSq) { unloadChunk(key); didDrop = true; break }
    }
    _scanKey = cKey; _ringClean = !didLoad && !didDrop && !_inflight && deferredChunks.size === 0
    profile.deferredChunks = deferredChunks.size
  }

  function stepInflight() {
    exactFrame.beginChunk()
    const done = _inflight.cursor.step(LOAD_BUDGET, streamFocus[0], streamFocus[1])
    if (exactFrame.missing) _inflight.missing = true
    return done
  }

  function finishInflight() {
    const { key, cursor, px, pz, missing } = _inflight
    _inflight = null
    loaded.delete(key)
    if (missing) { deferGrassChunk(key); return }
    // The focus a chunk commits against has to be the player's current one, not the one captured
    // when the chunk started placing: the keep decision is a distance and a stale focus holds
    // blades past their own edge.
    const fx = Number.isFinite(streamFocus[0]) ? streamFocus[0] : px
    const fz = Number.isFinite(streamFocus[1]) ? streamFocus[1] : pz
    commitChunk(key, cursor.blades, fx, fz, cursor)
  }

  function startInflight(key, px, pz) {
    loaded.set(key, { entries: [], pending: true })
    exactFrame.beginChunk()
    const cursor = LOD_LAW
      ? createGrassChunkLod(key, exactFrame.placementFrame, anchorField, worldSeed, LOD_LAW, undefined, () => exactFrame.missing)
      : createGrassChunkCursor(key, exactFrame.placementFrame, anchorField, worldSeed, undefined, () => exactFrame.missing)
    _inflight = { key, cursor, px, pz, missing: false }
    if (stepInflight()) finishInflight()
  }

  // A chunk is generated with the population the law will draw from where the player is, so the
  // population has to grow as the player closes. The chunk's own placement decides whether it has
  // grown, which is free until the player has actually closed on it, and the commit keeps the
  // prefix it already holds.
  function refineRing(px, pz) {
    if (!LOD_LAW) return
    let budget = REFINE_BUDGET_MS
    for (const [key, cell] of loaded) {
      if (budget <= 0) break
      if (cell.pending || !cell.src) continue
      const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
      const added = cell.src.grow(px, pz, budget)
      const drop = cell.src.takeReleased ? cell.src.takeReleased() : null
      if (drop && drop.length) compactChunk(cell, drop, px, pz)
      budget -= ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
      if (added > 0) { profile.refineBlades += added; appendChunk(cell, cell.src.blades, px, pz) }
      profile.refineMs += ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    }
  }

  let _lastPx = NaN, _lastPz = NaN
  const IDLE_EPS = 0.05
  const cullFreeze = createCullFreeze((auto) => { setInstancedCullAuto(im, auto); setInstancedCullAuto(imMid, auto); profile.cullFrozen = !auto })
  let _cullDirty = true
  let _cullBacklog = false

  function cullChunksToFrustum(camera) {
    const tc0 = (typeof performance !== 'undefined') ? performance.now() : 0
    camera.updateMatrixWorld()
    _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_projMat)
    let culledCount = 0
    let entryBudget = CULL_ENTRY_BUDGET
    _cullBacklog = false
    for (const cell of loaded.values()) {
      if (cell.pending) continue
      if (cell.empty) continue
      _cullBox.min.set(cell.aabbMin[0], cell.aabbMin[1], cell.aabbMin[2])
      _cullBox.max.set(cell.aabbMax[0], cell.aabbMax[1], cell.aabbMax[2])
      const inFrustum = _frustum.intersectsBox(_cullBox)
      if (!inFrustum) culledCount++
      if (inFrustum === cell.inFrustum) continue
      if (entryBudget <= 0) { _cullBacklog = true; continue }
      entryBudget -= cell.count != null ? cell.count : cell.entries.length
      cell.inFrustum = inFrustum
      if (cell.occluded) continue
      for (const en of cell.entries) { if (!en) continue; try { (en.near ? im : imMid).setVisibilityAt(en.id, inFrustum) } catch (_) {} }
    }
    profile.chunksCulled = culledCount
    profile.cullMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - tc0
  }

  function updateVisibility(camera, pose) {
    if (!camera) return
    const live = _cullDirty
    _cullDirty = false
    const frozen = cullFreeze.step(camera, pose, live)
    if (!frozen || _cullBacklog) cullChunksToFrustum(camera)
  }

  function setBenders() {
    wind.uBenderCount.value = 0
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
    wind.uGrassTime.value += dt * GRASS_ANIM_SPEED
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
      revisitNearLod(px, pz)
      refineRing(px, pz)
      if ((!!_inflight !== _beforeInflight) || (loaded.size !== _beforeLoaded)) _cullDirty = true
      wind.uCamPosXZ.value.set(px, pz)
      const decalOff = RenderControls.get('grassDecalsOff') === true
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
    wind.uGrassRing.value = EDGE_CAP_M
    profile.totalInstances = totalInstances
    profile.nearInstances = nearInstances
    profile.midInstances = totalInstances - nearInstances
    profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    if (typeof window !== 'undefined') window.__grassProfile = profile
    if (uGrassContactOcc) uGrassContactOcc.value = (typeof window !== 'undefined' && window.__grassContactOccOff === true) ? 0 : 1
    if (grassNodes) syncGrassMaterialTSL(grassNodes, wind)
  }

  function warmShaders(camera) {
    if (!camera) return runWarmPasses(null, 0)
    return runWarmPasses(() => renderer.render(scene, camera), 2)
  }

  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (cell.pending) continue
      if (cell.empty) continue
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
      cell._occProxy.instanceCount = cell.count != null ? cell.count : cell.entries.length
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
      for (const en of cell.entries) { if (!en) continue; try { (en.near ? im : imMid).setVisibilityAt(en.id, !shouldHide) } catch (_) {} }
    }
  }

  function dispose() {
    try { scene.remove(im.mesh || im); scene.remove(imMid.mesh || imMid) } catch (e) { _dbgGrass('scene.remove failed on dispose:', e?.message || e) }
    try { geoNear.dispose(); geoMid.dispose(); mat.dispose(); im.dispose && im.dispose(); imMid.dispose && imMid.dispose() } catch (e) { _dbgGrass('geo/mat/im dispose failed:', e?.message || e) }
    loaded.clear(); totalInstances = 0; _inflight = null; _occCands = null
    if (typeof window !== 'undefined' && window.__grass && window.__grass._im === im) delete window.__grass
  }

  const _nowMs = () => (typeof performance !== 'undefined') ? performance.now() : 0
  async function prewarm(px, pz, budgetMs = 60000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = _nowMs()
    const ring = placementRing.ringAt(px, pz, placementRing.focusKeyAt(px, pz))
    let n = 0
    let workMs = 0
    let yieldMs = 0
    for (const key of ring) {
      if (totalInstances >= MAX_INSTANCES) break
      if (workMs >= budgetMs) break
      if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
      // The slice is one LOAD_BUDGET step of the chunk's own placement cursor -- the same
      // incremental loader the streaming path already uses -- neither the whole chunk nor a
      // millisecond budget accumulated across chunks. A grass chunk is itself about a frame of
      // placement, so a chunk-sized unit could not bound the block either; one step can, and a
      // frame runs after every step.
      const _c0 = _nowMs()
      startInflight(key, px, pz)
      workMs += _nowMs() - _c0
      while (_inflight && _inflight.key === key) {
        await macrotaskYield()
        const _s0 = _nowMs()
        if (stepInflight()) finishInflight()
        workMs += _nowMs() - _s0
      }
      if (!deferredChunks.has(key)) n++
      const _y0 = _nowMs()
      await macrotaskYield()
      yieldMs += _nowMs() - _y0
    }
    profile.prewarmChunks = n
    profile.prewarmWorkMs = workMs
    profile.prewarmYieldMs = yieldMs
    profile.prewarmMs = _nowMs() - t0
    return n
  }

  function rebuildPlacement() { _inflight = null; deferredChunks.clear(); for (const key of [...loaded.keys()]) unloadChunk(key); _ringClean = false; _scanKey = NaN }
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, setSun: (sun) => setGrassSun(wind, sun), streamState: () => placementRing.streamState(loaded, deferredChunks, streamFocus, ringRadiusSq, dropRadiusSq), updateVisibility, tickWind, prewarm, warmShaders, dispose, _im: im, _imMid: imMid, _cells: loaded, get totalInstances() { return totalInstances }, get nearInstances() { return nearInstances }, get lodRevisit() { return lodRevisit }, set lodRevisit(v) { lodRevisit = v !== false; _lodEvalPx = NaN }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, setBenders, get benderCount() { return wind.uBenderCount.value }, get benderPosXZ() { return wind.uBenderPosXZ.value }, markScorched, decalStore, get decalCount() { return wind.uDecalCount.value }, get decalPosXZRS() { return wind.uDecalPosXZRS.value }, cfg, renderDistance, densityFullR: FULL_R, densityEdgeM: EDGE_CAP_M, densityReachM: DENSITY_REACH_M }
  if (typeof window !== 'undefined') window.__grass = api
  return api
}
