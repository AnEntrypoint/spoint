import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createOctahedralImpostorMaterial, computeObjectBoundingSphere, createTextureAtlas } from 'streaming-gltf/octahedral-impostor-ez'
import { makeImpostorCaptureMaterialTSL } from 'streaming-gltf/octahedral-impostor-display-tsl'
import { buildSharedImpostorAtlas, createSharedImpostorMesh, impostorHandoffDistances } from './VegImpostorTier.js'
import { placementsForChunk, VEG, SPECIES, VEG_SHAPE_VARIANTS } from '/src/terrain/VegPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createExactPatchFrame } from './ExactPatchFrame.js'
import { createPlacementRing } from './PlacementRing.js'
import { createCullFreeze, setInstancedCullAuto } from './CullFreeze.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'
import { loadEzTree, makeWindUniforms, applyWind, awaitMatTextures, capGeo, simplifyGeo, buildSpecies, makeEmptyGeo, TARGET_H } from './VegetationBuild.js'
import { createWebGPULodInstancer } from './WebGPULodInstancer.js'
import { makeWindUniformsTSL, tickWindTSL, applyWindTSL, applyTintTSL } from './VegetationTSL.js'

const _dbgVeg = dbg('vegetation')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_HYSTERESIS_MARGIN_M = 64
const VEG_MESH_OPAQUE_DRAW_ORDER = 3
const VEG_SHARED_IMPOSTOR_OPAQUE_DRAW_ORDER = 4
const BUILD_SLICE_BUDGET_MS = 8
const VEG_ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'vec3' }
const _tintUniform = new THREE.Vector3()
const _leanQ = new THREE.Quaternion()
const barkTintLuma = (t) => 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]
const SHARED_IMPOSTOR_BAKE = Symbol('shape variants share the species impostor bake')

function hideLastLevel(lodSet) {
  const levels = lodSet && lodSet.levels
  if (levels && levels.length) levels[levels.length - 1].object.visible = false
}

function freezeLevelMatrices(mesh) {
  const levels = mesh && mesh.LODinfo && mesh.LODinfo.objects
  if (!levels) return
  for (const level of levels) if (level !== mesh) { level.updateMatrix(); level.matrixAutoUpdate = false }
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _vanMat = new THREE.Matrix4(), _vanProj = new THREE.Matrix4(), _vanFrustum = new THREE.Frustum()
const _cullMat = new THREE.Matrix4(), _cullShift = new THREE.Matrix4(), _cullFrustum = new THREE.Frustum()

export async function createVegetation(opts = {}) {
  const { renderer, scene, frame } = opts
  const biomeOverride = createBiomeOverride()
  const anchorField = biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createVegetation: renderer/scene/frame required')
  const isWebGPU = !!renderer.isWebGPURenderer

  let Tree, TreePreset
  try {
    ({ Tree, TreePreset } = await loadEzTree())
    if (typeof Tree !== 'function') throw new Error('ez-tree module loaded but exports no Tree constructor')
  } catch (e) {
    console.error('[veg] @dgreenheck/ez-tree failed to load -- vegetation skipped this session (rest of the client is unaffected):', e?.message || e)
    return null
  }

  const renderDistance = Number.isFinite(cfg.renderDistance) ? cfg.renderDistance : 640
  const ringRadius = renderDistance + 40
  const dropRadius = ringRadius + DROP_HYSTERESIS_MARGIN_M
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : 30000
  const FALLOFF_NEAR = Number.isFinite(cfg.vegFalloffNear) ? cfg.vegFalloffNear : 96
  const FALLOFF_FLOOR = Number.isFinite(cfg.vegFalloffFloor) ? cfg.vegFalloffFloor : 0.15
  const _falloffSpan = Math.max(1, renderDistance - FALLOFF_NEAR)
  function vegKeepProb(d) {
    if (d <= FALLOFF_NEAR) return 1
    if (d >= renderDistance) return FALLOFF_FLOOR
    const t = (d - FALLOFF_NEAR) / _falloffSpan
    const smoothstepT = t * t * (3 - 2 * t)
    return 1 - (1 - FALLOFF_FLOOR) * smoothstepT
  }
  function _treeCoin(id) {
    let x = ((id | 0) ^ 0x9e3779b1) >>> 0
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
    x ^= x >>> 13
    return (x >>> 0) / 4294967296
  }
  const INIT_CAP = Math.min(MAX_INSTANCES, Number.isFinite(cfg.initCapacity) ? cfg.initCapacity : 2048)
  const wind = makeWindUniforms()
  if (typeof window !== 'undefined') { wind.uVegWind.value = window.__vegWind != null ? +window.__vegWind : 1 }
  const windTSL = isWebGPU ? makeWindUniformsTSL() : null
  if (isWebGPU && typeof window !== 'undefined') { windTSL.uVegWind.value = window.__vegWind != null ? +window.__vegWind : 1 }

  const D1 = Number.isFinite(cfg.lod1) ? cfg.lod1 : Math.min(14, renderDistance * 0.045)
  const D2 = Number.isFinite(cfg.lod2) ? cfg.lod2 : Math.min(35, renderDistance * 0.11)
  const D3 = (typeof window !== 'undefined' && Number.isFinite(+window.__vegD3)) ? +window.__vegD3 : Number.isFinite(cfg.impostorDistance) ? cfg.impostorDistance : Math.min(renderDistance, Math.max(D2 + 12, renderDistance * 0.13))
  const IMPOSTOR_NEAR_CUTOFF = D3 * 0.92
  const SHADOW_CAST = Number.isFinite(cfg.shadowCastDistance) ? cfg.shadowCastDistance : 35
  const LOD_HYS = Number.isFinite(cfg.lodHysteresis) ? cfg.lodHysteresis : 0.12
  const BVH_MARGIN = Number.isFinite(cfg.bvhMargin) ? cfg.bvhMargin : 24
  const speciesList = Array.isArray(cfg.species) && cfg.species.length ? cfg.species : SPECIES
  const SHAPE_VARIANTS = Number.isFinite(cfg.shapeVariants) ? Math.max(1, Math.min(VEG_SHAPE_VARIANTS, Math.floor(cfg.shapeVariants))) : VEG_SHAPE_VARIANTS
  const buildList = []
  for (let v = 0; v < SHAPE_VARIANTS; v++) for (const name of speciesList) buildList.push({ name, variant: v })
  const recKey = (name, variant) => name + '#' + variant
  const _vegMode = (typeof location !== 'undefined' && (location.search.match(/[?&]veg=(\w+)/) || [])[1]) || 'full'
  const _buildImpostor = _vegMode !== 'branch'
  const USE_SHARED_IMPOSTOR = cfg.sharedImpostor !== false && (_vegMode === 'full' || _vegMode === 'shared')

  const meshes = []

  let buildErr = 0
  let _buildT0 = (typeof performance !== 'undefined') ? performance.now() : 0
  for (let i = 0; i < buildList.length; i++) {
    const { name, variant } = buildList[i]
    try {
      const sp = buildSpecies(name, Tree, variant, TreePreset)
      const branchGeo0 = await capGeo(sp.branchGeo, Number.isFinite(cfg.branchTriCap) ? cfg.branchTriCap : 2200)
      const leafGeo0 = await capGeo(sp.leafGeo, Number.isFinite(cfg.leafTriCap) ? cfg.leafTriCap : 1400)
      branchGeo0.computeBoundingBox(); leafGeo0.computeBoundingBox()
      const _treeBox = branchGeo0.boundingBox.clone().union(leafGeo0.boundingBox)
      const _treeSph = _treeBox.getBoundingSphere(new THREE.Sphere())
      branchGeo0.boundingBox = _treeBox.clone(); leafGeo0.boundingBox = _treeBox.clone()
      branchGeo0.boundingSphere = _treeSph.clone(); leafGeo0.boundingSphere = _treeSph.clone()
      let branch, leaf, impostor = false, impMatRef = null, impDims = null
      const b1 = await simplifyGeo(branchGeo0, 0.28, false), b2 = await simplifyGeo(branchGeo0, 0.07, true)
      const l1 = await simplifyGeo(leafGeo0, 0.30, false), l2 = await simplifyGeo(leafGeo0, 0.09, true)
      const b2shadow = await simplifyGeo(branchGeo0, 0.07, true)
      for (const g of [b1, b2, l1, l2, b2shadow]) { g.boundingBox = _treeBox.clone(); g.boundingSphere = _treeSph.clone() }
      if (isWebGPU) {
        applyWindTSL(sp.branchMat, windTSL); applyTintTSL(sp.branchMat)
        applyWindTSL(sp.leafMat, windTSL); applyTintTSL(sp.leafMat)
        branch = createWebGPULodInstancer(scene, [
          { geometry: branchGeo0, material: sp.branchMat, distance: 0 },
          { geometry: b1, material: sp.branchMat, distance: D1 },
          { geometry: b2, material: sp.branchMat, distance: D2 },
        ], INIT_CAP, VEG_ATTRIBUTE_SCHEMA, {
          hysteresis: LOD_HYS, shadowGeometry: b2shadow, shadowMaterial: sp.branchMat,
          shadowDistance: SHADOW_CAST,
        })
        leaf = createWebGPULodInstancer(scene, [
          { geometry: leafGeo0, material: sp.leafMat, distance: 0 },
          { geometry: l1, material: sp.leafMat, distance: D1 },
          { geometry: l2, material: sp.leafMat, distance: D2 },
        ], INIT_CAP, VEG_ATTRIBUTE_SCHEMA, { hysteresis: LOD_HYS })
        try {
          if (!_buildImpostor) throw new Error('veg-bisect: impostor disabled (?veg=branch)')
          if (variant > 0) throw SHARED_IMPOSTOR_BAKE
          if (!USE_SHARED_IMPOSTOR) throw new Error('WebGPU draws impostors only through the shared atlas (?veg=full or ?veg=shared)')
          await awaitMatTextures([sp.branchMat, sp.leafMat])
          const sph = computeObjectBoundingSphere(sp.tree, new THREE.Sphere(), true)
          if (sph && Number.isFinite(sph.radius) && sph.radius > 0) {
            const baked = createTextureAtlas({ renderer, target: sp.tree, useHemiOctahedron: false, spritesPerSide: 8, textureSize: 1024, makeCaptureMaterial: makeImpostorCaptureMaterialTSL })
            impDims = { center: [sph.center.x, sph.center.y, sph.center.z], radius: sph.radius }
            impostor = true
            impMatRef = { map: baked.albedo, normalMap: baked.normalDepth, dispose() { baked.renderTarget.dispose() } }
          }
        } catch (e) { if (e !== SHARED_IMPOSTOR_BAKE) console.warn('[veg] impostor bake failed (mesh-LOD-only):', name, e?.message || e) }
      } else {
        branch = new InstancedMesh2(branchGeo0, applyWind(sp.branchMat, wind), { capacity: INIT_CAP, renderer })
        leaf = new InstancedMesh2(leafGeo0, applyWind(sp.leafMat, wind), { capacity: INIT_CAP, renderer })
        for (const m of [branch, leaf]) {
          m.initUniformsPerInstance({ vertex: { windPhase: 'float' }, fragment: { tint: 'vec3' } })
          m.perObjectFrustumCulled = true
          m.frustumCulled = false
        }
        branch.addLOD(b1, branch.material, D1, LOD_HYS); branch.addLOD(b2, branch.material, D2, LOD_HYS)
        leaf.addLOD(l1, leaf.material, D1, LOD_HYS); leaf.addLOD(l2, leaf.material, D2, LOD_HYS)
        for (const mesh of [branch, leaf]) {
          for (const child of mesh.children) {
            if (child._geometry) { child._geometry.boundingBox = _treeBox.clone(); child._geometry.boundingSphere = _treeSph.clone() }
          }
        }
        branch.addShadowLOD(b2shadow, 0)
        branch.addShadowLOD(makeEmptyGeo(), SHADOW_CAST)
        hideLastLevel(branch.LODinfo.shadowRender)
        for (const shadowObj of branch.LODinfo.objects) {
          const hasLibraryDefaultShaderMaterial = shadowObj !== branch && shadowObj.material && shadowObj.material.type === 'ShaderMaterial' && !shadowObj.material.vertexShader?.includes('uVegTime')
          if (hasLibraryDefaultShaderMaterial) {
            shadowObj.material = branch.material
          }
        }
        try {
          if (!_buildImpostor) throw new Error('veg-bisect: impostor disabled (?veg=branch)')
          if (variant > 0) throw SHARED_IMPOSTOR_BAKE
          await awaitMatTextures([sp.branchMat, sp.leafMat])
          const sph = computeObjectBoundingSphere(sp.tree, new THREE.Sphere(), true)
          if (sph && Number.isFinite(sph.radius) && sph.radius > 0) {
            const transform = new THREE.Matrix4().makeScale(sph.radius * 2, sph.radius * 2, sph.radius * 2).setPosition(sph.center)
            const impMat = createOctahedralImpostorMaterial({
              baseType: THREE.MeshStandardMaterial, useHemiOctahedron: false,
              spritesPerSide: 8, alphaClamp: 0.4, transform, transparent: false,
              renderer, target: sp.tree, textureSize: 1024,
              farSingleSprite: true,
            })
            impDims = { center: [sph.center.x, sph.center.y, sph.center.z], radius: sph.radius }
            impostor = true; impMatRef = impMat
          }
        } catch (e) { if (e !== SHARED_IMPOSTOR_BAKE) console.warn('[veg] impostor bake failed (mesh-LOD-only):', name, e?.message || e) }
        scene.add(branch); scene.add(leaf)
      }
      branch.updateMatrix(); branch.matrixAutoUpdate = false
      leaf.updateMatrix(); leaf.matrixAutoUpdate = false
      branch.renderOrder = VEG_MESH_OPAQUE_DRAW_ORDER; leaf.renderOrder = VEG_MESH_OPAQUE_DRAW_ORDER
      meshes.push({ name, variant, branch, leaf, count: 0, impostor, impMat: impMatRef, impDims })
    } catch (e) { buildErr++; console.error('[veg] species build failed:', name, e?.message || e) }
    const _now = (typeof performance !== 'undefined') ? performance.now() : 0
    if (_now - _buildT0 > BUILD_SLICE_BUDGET_MS) {
      await new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
      _buildT0 = (typeof performance !== 'undefined') ? performance.now() : 0
    }
  }
  const recByKey = new Map(meshes.map(r => [recKey(r.name, r.variant), r]))

  try {
    const maxAniso = 1
    const hasMSAA = !!(renderer.getContext() && renderer.getContext().getContextAttributes && renderer.getContext().getContextAttributes().antialias)
    for (const r of meshes) {
      for (const m of [r.branch && r.branch.material, r.leaf && r.leaf.material]) {
        if (!m) continue
        for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
          const t = m[k]
          if (t && t.isTexture && t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true }
        }
      }
      const lm = r.leaf && r.leaf.material
      if (lm && hasMSAA && !lm.alphaToCoverage) { lm.alphaToCoverage = true; lm.needsUpdate = true }
    }
  } catch (e) { console.warn('[veg] mip/alpha setup skipped:', e?.message || e) }

  let sharedImpostor = null
  if (USE_SHARED_IMPOSTOR) {
    try {
      const impRecs = meshes.filter(r => r.impostor && r.impMat && r.impDims)
      if (impRecs.length) {
        const speciesAtlases = impRecs.map(r => ({ albedo: r.impMat.map, normal: r.impMat.normalMap }))
        const atlas = buildSharedImpostorAtlas(renderer, speciesAtlases, {})
        if (atlas && atlas.copied > 0) {
          const dims = impRecs.map(r => r.impDims)
          sharedImpostor = createSharedImpostorMesh(renderer, atlas, dims, {
            maxInstances: MAX_INSTANCES, initCapacity: INIT_CAP,
            spritesPerSide: 8, alphaClamp: 0.4,
            nearCutoff: IMPOSTOR_NEAR_CUTOFF,
            lodHysteresis: LOD_HYS,
            farSingleSprite: false,
            parallax: RenderControls.get('vegImpostorParallax') === true,
            parallaxScale: RenderControls.get('vegImpostorParallaxScale'),
          })
          if (sharedImpostor) {
            const tileByName = new Map()
            impRecs.forEach((r, i) => { r.impTile = i; tileByName.set(r.name, i) })
            for (const r of meshes) if (tileByName.has(r.name)) r.impTile = tileByName.get(r.name)
            sharedImpostor.atlas = atlas
            scene.add(sharedImpostor.mesh)
            sharedImpostor.mesh.updateMatrix(); sharedImpostor.mesh.matrixAutoUpdate = false
            sharedImpostor.mesh.renderOrder = VEG_SHARED_IMPOSTOR_OPAQUE_DRAW_ORDER
            for (const r of impRecs) {
              try { r.impMat.map && r.impMat.map.dispose() } catch (_) {}
              try { r.impMat.normalMap && r.impMat.normalMap.dispose() } catch (_) {}
              try { r.impMat.dispose && r.impMat.dispose() } catch (_) {}
              r.impMat = null
            }
          }
        } else if (atlas) { atlas.dispose && atlas.dispose() }
      }
    } catch (e) { console.warn('[veg] shared impostor build failed (per-species fallback):', e?.message || e); sharedImpostor = null }
  }
  if (isWebGPU && !sharedImpostor) {
    for (const r of meshes) { if (r.impMat) { try { r.impMat.dispose() } catch (_) {} r.impMat = null } }
  }

  const FAR_LOD_SWAP = Math.max(D2 * (1 + LOD_HYS), impostorHandoffDistances(IMPOSTOR_NEAR_CUTOFF).meshEnd)
  for (const rec of meshes) {
    if (!rec.impostor && rec.impTile == null) continue
    if (isWebGPU) {
      if (sharedImpostor && rec.impTile != null) { rec.branch.setMeshFarDistance(FAR_LOD_SWAP); rec.leaf.setMeshFarDistance(FAR_LOD_SWAP) }
    } else if (sharedImpostor && rec.impTile != null) {
      rec.branch.addLOD(makeEmptyGeo(), rec.branch.material, FAR_LOD_SWAP, 0)
      rec.leaf.addLOD(makeEmptyGeo(), rec.leaf.material, FAR_LOD_SWAP, 0)
      hideLastLevel(rec.branch.LODinfo.render); hideLastLevel(rec.leaf.LODinfo.render)
    } else if (rec.impMat) {
      const impPlane = new THREE.PlaneGeometry(1, 1)
      if (rec.branch.geometry && rec.branch.geometry.boundingSphere) impPlane.boundingSphere = rec.branch.geometry.boundingSphere.clone()
      rec.branch.addLOD(impPlane, rec.impMat, FAR_LOD_SWAP, 0)
      rec.leaf.addLOD(makeEmptyGeo(), rec.leaf.material, FAR_LOD_SWAP, 0)
      hideLastLevel(rec.leaf.LODinfo.render)
    }
  }
  for (const rec of meshes) { freezeLevelMatrices(rec.branch); freezeLevelMatrices(rec.leaf) }
  if (sharedImpostor) freezeLevelMatrices(sharedImpostor.mesh)

  const loaded = new Map()
  const deferredChunks = new Set()
  const exactFrame = createExactPatchFrame(frame)
  const placementRing = createPlacementRing(frame, VEG, ringRadius)
  let _occCands = null
  let curSuper = null
  let totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, bvhRebuilds: 0, species: speciesList.length, buildErrors: buildErr, impostors: meshes.filter(m => m.impostor).length }

  function loadChunk(key, px, pz) {
    if (loaded.has(key)) return true
    const entries = []
    let list
    exactFrame.beginChunk()
    try { list = placementsForChunk(key, exactFrame.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    if (exactFrame.missing) {
      deferredChunks.add(key)
      const c = placementRing.centre(key)
      exactFrame.prefetchChunk(c[0], c[1])
      return false
    }
    deferredChunks.delete(key)
    const _haveCam = Number.isFinite(px) && Number.isFinite(pz)
    const byRec = new Map()
    let _minY = Infinity, _maxY = -Infinity
    if (list) for (let i = 0; i < list.length; i++) {
      if (totalInstances >= MAX_INSTANCES) break
      const p = list[i]
      if (_haveCam) {
        const dx = p.x - px, dz = p.z - pz
        const d = Math.sqrt(dx * dx + dz * dz)
        if (d > FALLOFF_NEAR && _treeCoin(p.trunkId) >= vegKeepProb(d)) continue
      }
      const name = SPECIES[p.species]
      const rec = recByKey.get(recKey(name, Math.min(p.shape | 0, SHAPE_VARIANTS - 1)))
      if (!rec) continue
      let bucket = byRec.get(rec)
      if (!bucket) { bucket = []; byRec.set(rec, bucket) }
      bucket.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale, windPhase: p.windPhase, tint: p.tint, tilt: p.tiltQuat })
      totalInstances++
      const treeH = (TARGET_H[name] || 9) * p.scale
      if (p.y < _minY) _minY = p.y
      if (p.y + treeH > _maxY) _maxY = p.y + treeH
    }
    if (_minY === Infinity) {
      let gh = 0
      const c = placementRing.centre(key)
      try { gh = frame.groundHeightLocal(c[0], c[1]) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 2; _maxY = gh + 2
    }
    for (const [rec, bucket] of byRec) {
      let bi = 0
      rec.branch.addInstances(bucket.length, (e) => {
        const c = bucket[bi++]
        _q.setFromAxisAngle(_v.set(0, 1, 0), c.yaw); _leanQ.set(c.tilt[0], c.tilt[1], c.tilt[2], c.tilt[3]); _q.premultiply(_leanQ)
        e.position.set(c.x, c.y, c.z); e.quaternion.copy(_q); e.scale.setScalar(c.scale)
        c.branchId = e.id
      })
      bi = 0
      rec.leaf.addInstances(bucket.length, (e) => {
        const c = bucket[bi++]
        _q.setFromAxisAngle(_v.set(0, 1, 0), c.yaw); _leanQ.set(c.tilt[0], c.tilt[1], c.tilt[2], c.tilt[3]); _q.premultiply(_leanQ)
        e.position.set(c.x, c.y, c.z); e.quaternion.copy(_q); e.scale.setScalar(c.scale)
        c.leafId = e.id
      })
      rec.count += bucket.length
      let impIds = null
      if (sharedImpostor && rec.impTile != null) {
        impIds = sharedImpostor.addImpostors(bucket.map(c => ({ species: rec.impTile, x: c.x, y: c.y, z: c.z, scale: c.scale, tint: c.tint })))
      }
      for (let i = 0; i < bucket.length; i++) {
        const c = bucket[i]
        const impId = impIds ? impIds[i] : -1
        entries.push({ rec, branchId: c.branchId, leafId: c.leafId, impId, windPhase: c.windPhase, tint: c.tint })
      }
    }
    for (const en of entries) {
      try {
        en.rec.branch.setUniformAt(en.branchId, 'windPhase', en.windPhase); en.rec.leaf.setUniformAt(en.leafId, 'windPhase', en.windPhase)
        const barkLuma = barkTintLuma(en.tint)
        en.rec.branch.setUniformAt(en.branchId, 'tint', isWebGPU ? [barkLuma, barkLuma, barkLuma] : _tintUniform.setScalar(barkLuma))
        en.rec.leaf.setUniformAt(en.leafId, 'tint', isWebGPU ? en.tint : _tintUniform.fromArray(en.tint))
      } catch (_) {}
    }
    const b = placementRing.bounds(key, list)
    const _aabbMin = [b[0], _minY, b[1]], _aabbMax = [b[2], _maxY, b[3]]
    loaded.set(key, { entries, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false })
    _occCands = null
    profile.loads++
    return true
  }

  function unloadChunk(key) {
    const cell = loaded.get(key)
    if (!cell) return
    for (const en of cell.entries) {
      try { en.rec.branch.removeInstances(en.branchId); en.rec.leaf.removeInstances(en.leafId); en.rec.count--; totalInstances-- } catch (_) {}
      if (sharedImpostor && en.impId != null && en.impId >= 0) { try { sharedImpostor.removeImpostor(en.impId) } catch (_) {} }
    }
    loaded.delete(key)
    _occCands = null
    profile.unloads++
  }

  const LOAD_BUDGET_MS = Number.isFinite(cfg.vegLoadBudgetMs) ? cfg.vegLoadBudgetMs : 2
  const DEFERRED_RETRIES_PER_FRAME = 2
  const _retryKeys = []
  let _ringClean = false, _scanKey = NaN
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05, IDLE_STRIDE = 16
  const cullFreeze = createCullFreeze((auto) => {
    for (const rec of meshes) { setInstancedCullAuto(rec.branch, auto); setInstancedCullAuto(rec.leaf, auto) }
    if (sharedImpostor) setInstancedCullAuto(sharedImpostor.mesh, auto)
    profile.cullFrozen = !auto
  })
  let _cullDirty = true
  const _lastCullMat = new THREE.Matrix4()
  let _vegSpiralCursor = 0
  const streamFocus = [NaN, NaN]
  function streamRing(px, pz) {
    streamFocus[0] = px; streamFocus[1] = pz
    const cKey = placementRing.focusKeyAt(px, pz)
    curSuper = cKey
    if (_ringClean && cKey === _scanKey) return
    profile.ringScans = (profile.ringScans || 0) + 1
    const ring = placementRing.ringAt(px, pz, cKey)
    const _cellChanged = cKey !== _scanKey
    if (_cellChanged) _vegSpiralCursor = 0
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
      if (loadChunk(key, px, pz)) didLoad = true
    }
    for (let ringAttempts = 0; totalInstances < MAX_INSTANCES && (ringAttempts === 0 || performance.now() - loadT0 < LOAD_BUDGET_MS); ringAttempts++) {
      let found = false
      for (; _vegSpiralCursor < ring.length; _vegSpiralCursor++) {
        const key = ring[_vegSpiralCursor]
        if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key) || deferredChunks.has(key)) continue
        if (loadChunk(key, px, pz)) didLoad = true
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
    return didLoad || didDrop
  }

  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  const PREWARM_BATCH = 2
  async function prewarm(px, pz, maxChunks = 64, budgetMs = 4000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    const ring = placementRing.ringAt(px, pz, placementRing.focusKeyAt(px, pz))
    let n = 0
    for (const key of ring) {
      if (n >= maxChunks || totalInstances >= MAX_INSTANCES) break
      if (((typeof performance !== 'undefined') ? performance.now() : 0) - t0 > budgetMs) break
      if (placementRing.distSqFromFocus(key) > ringRadiusSq || loaded.has(key)) continue
      if (loadChunk(key, px, pz)) n++
      if (n % PREWARM_BATCH === 0) await _yieldFrame()
    }
    if (totalInstances > 0 && !bvhBuilt) ensureBVH()
    return n
  }

  function warmShaders(camera) {
    if (!camera) return 0
    try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {}
    return meshes.length
  }

  let bvhBuilt = false
  let _profAccum = 0
  function ensureBVH() {
    if (bvhBuilt) return
    if (isWebGPU) { bvhBuilt = true; return }
    for (const rec of meshes) {
      try { rec.branch.computeBVH({ margin: BVH_MARGIN }); rec.leaf.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
    }
    if (sharedImpostor) { try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {} }
    bvhBuilt = true
    _instancesAtLastBVHBuild = totalInstances
  }

  let _instancesAtLastBVHBuild = 0
  const BVH_REBUILD_GROWTH_FRACTION = 0.5
  function rebuildBVHAfterIncrementalGrowth() {
    if (isWebGPU) return
    if (!bvhBuilt || totalInstances === 0) return
    const grown = totalInstances - _instancesAtLastBVHBuild
    if (grown <= 0 || grown < _instancesAtLastBVHBuild * BVH_REBUILD_GROWTH_FRACTION) return
    for (const rec of meshes) {
      try { rec.branch.computeBVH({ margin: BVH_MARGIN }); rec.leaf.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
    }
    if (sharedImpostor) { try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {} }
    _instancesAtLastBVHBuild = totalInstances
  }

  function _vanishProbe(camera) {
    try {
      camera.getWorldPosition(_camPos)
      let nd = Infinity, nrec = null, nidx = -1
      for (const rec of meshes) {
        const im = rec.branch, cnt = im.instancesCount || 0
        for (let i = 0; i < cnt; i++) { im.getMatrixAt(i, _vanMat); _v.setFromMatrixPosition(_vanMat); const d = _v.distanceTo(_camPos); if (d < nd) { nd = d; nrec = rec; nidx = i } }
      }
      if (nrec && nd < 30) {
        const lc = (im) => (im.LODinfo && im.LODinfo.render && Array.from(im.LODinfo.render.count || [])) || null
        const im = nrec.branch
        im.getMatrixAt(nidx, _vanMat)
        _vanFrustum.setFromProjectionMatrix(_vanProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
        const inFr = im.geometry.boundingBox ? _vanFrustum.intersectsBox(im.geometry.boundingBox.clone().applyMatrix4(_vanMat)) : null
        let lodLevel = null, lodCount = null, levelDrawn = null
        const lodObj = im.LODinfo && im.LODinfo.render
        if (lodObj && lodObj.levels && typeof im.getObjectLODIndexForDistance === 'function') {
          try {
            lodLevel = im.getObjectLODIndexForDistance(lodObj.levels, nd * nd)
            lodCount = lodObj.count ? Array.from(lodObj.count) : null
            levelDrawn = (lodCount && lodLevel != null) ? lodCount[lodLevel] : null
          } catch (_) {}
        }
        let active = null, visible = null
        try { if (typeof im.getActiveAt === 'function') active = im.getActiveAt(nidx) } catch (_) {}
        try { if (typeof im.getVisibilityAt === 'function') visible = im.getVisibilityAt(nidx) } catch (_) {}
        let actualBucket = -1
        try {
          if (lodObj && lodObj.levels) {
            for (let L = 0; L < lodObj.levels.length; L++) {
              const arr = lodObj.levels[L].object && lodObj.levels[L].object.instanceIndex && lodObj.levels[L].object.instanceIndex.array
              const cnt = lodObj.count ? lodObj.count[L] : 0
              if (arr) { for (let k = 0; k < cnt; k++) { if (arr[k] === nidx) { actualBucket = L; break } } }
              if (actualBucket >= 0) break
            }
          }
        } catch (_) {}
        let sharedImpDrawn = null
        if (sharedImpostor && sharedImpostor.mesh) {
          try { const sm = sharedImpostor.mesh, slc = sm.LODinfo && sm.LODinfo.render && sm.LODinfo.render.count; sharedImpDrawn = slc ? Array.from(slc).reduce((a, x) => a + (x || 0), 0) : (sm.count || 0) } catch (_) {}
        }
        const rec = {
          t: (typeof performance !== 'undefined') ? Math.round(performance.now()) : 0,
          name: nrec.name, dist: +nd.toFixed(2), inFrustum: inFr, camNear: +camera.near.toFixed(2),
          instanceActive: active, instanceVisible: visible,
          nearestLODlevel: lodLevel, nearestLODcount: levelDrawn,
          actualBucket,
          instCount: im.instancesCount || 0,
          branchLOD: lc(nrec.branch), leafLOD: lc(nrec.leaf), sharedImpostorDrawn: sharedImpDrawn,
        }
        window.__vegVanish = rec
        if (nd < 15 && inFr === true && active !== false && visible !== false && (actualBucket < 0 || levelDrawn === 0 || levelDrawn == null)) {
          (window.__vegVanishHits = window.__vegVanishHits || []).push(rec)
        }
      }
    } catch (_) {}
  }

  function tickWind(dt) {
    if (isWebGPU) { tickWindTSL(windTSL, dt); return }
    wind.uVegTime.value += dt
    if (typeof window !== 'undefined' && window.__vegWind != null) wind.uVegWind.value = +window.__vegWind
  }

  function update(dt, camera, playerPos, shadowStill) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (camera) { camera.getWorldPosition(_camPos); px = _camPos.x; pz = _camPos.z }
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastPx, mdz = pz - _lastPz
      const still = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleFrames = still ? _idleFrames + 1 : 0
      _lastPx = px; _lastPz = pz
      profile.streamCalls = (profile.streamCalls || 0) + 1
      if (!still || !_ringClean || (_idleFrames % IDLE_STRIDE) === 0) { if (streamRing(px, pz)) _cullDirty = true }
      else profile.streamIdleSkips = (profile.streamIdleSkips || 0) + 1
    }
    if (shadowStill === false) _cullDirty = true
    if (totalInstances > 0) { try { if (!bvhBuilt) ensureBVH(); else rebuildBVHAfterIncrementalGrowth() } catch (_) { bvhBuilt = true } }
    for (const rec of meshes) {
      const vis = rec.count > 0
      if (rec.branch.visible !== vis) { rec.branch.visible = vis; rec.leaf.visible = vis }
      if (typeof window !== 'undefined' && window.__vegLeafOff) rec.leaf.visible = false
      if (typeof window !== 'undefined' && window.__vegAllOff) { rec.branch.visible = false; rec.leaf.visible = false }
      if (typeof window !== 'undefined' && window.__vegHideFar && window.__vegHideFar.includes(rec.name)) { rec.branch.visible = false; rec.leaf.visible = false }
    }
    if (typeof window !== 'undefined' && sharedImpostor) sharedImpostor.mesh.visible = !window.__vegAllOff
    if (typeof window !== 'undefined' && window.__vegVanishProbe && camera) _vanishProbe(camera)
    _profAccum += dt
    if (_profAccum >= 0.25) {
      _profAccum = 0
      let vis = 0, impostorInst = 0, meshInst = 0, vegDraws = 0
      const countDraws = (im) => {
        const lod = im.LODinfo && im.LODinfo.render
        const lc = lod && lod.count
        if (lc && lc.length) { let n = 0; for (let i = 0; i < lc.length; i++) if ((lc[i] || 0) > 0 && lod.levels[i].object.visible) n++; return n }
        return (im.count || 0) > 0 ? 1 : 0
      }
      for (const rec of meshes) {
        vis += (rec.branch.count || 0)
        const c = rec.branch.LODinfo && rec.branch.LODinfo.render && rec.branch.LODinfo.render.count
        if (c && c.length) {
          const farLevelDraws = rec.branch.LODinfo.render.levels[c.length - 1].object.visible
          if (farLevelDraws) impostorInst += c[c.length - 1] || 0
          for (let i = 0; i < c.length - 1; i++) meshInst += c[i] || 0
        }
        vegDraws += countDraws(rec.branch) + countDraws(rec.leaf)
      }
      let sharedImpInst = 0, sharedImpDraws = 0
      if (sharedImpostor) {
        const m = sharedImpostor.mesh
        const lc = m.LODinfo && m.LODinfo.render && m.LODinfo.render.count
        if (lc && lc.length) { for (let i = 0; i < lc.length; i++) { if ((lc[i] || 0) > 0) sharedImpDraws++ } sharedImpInst = lc[lc.length - 1] || 0 }
        else if ((m.count || 0) > 0) { sharedImpDraws = 1; sharedImpInst = m.count }
        impostorInst += sharedImpInst
        vegDraws += sharedImpDraws
      }
      profile.totalInstances = totalInstances
      profile.visibleInstances = vis
      profile.impostorInstances = impostorInst
      profile.sharedImpostor = !!sharedImpostor
      profile.sharedImpostorInstances = sharedImpInst
      profile.sharedImpostorDrawCalls = sharedImpDraws
      profile.sharedImpostorCount = sharedImpostor ? (sharedImpostor.count || 0) : 0
      profile.meshInstances = meshInst
      profile.vegDrawCalls = vegDraws
      try { profile.drawCalls = renderer.info.render.calls } catch (_) {}
      if (typeof window !== 'undefined') window.__vegProfile = profile
    }
    profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
    if (!(profile.updateMaxMs >= profile.updateMs)) profile.updateMaxMs = profile.updateMs
  }

  function updateVisibility(camera, pose, shadowStill) {
    const live = _cullDirty || shadowStill === false || renderer.shadowMap.needsUpdate === true
    _cullDirty = false
    const frozen = cullFreeze.step(camera, pose, live)
    if (isWebGPU && camera && !frozen && meshes.length) {
      const origin = meshes[0].branch.mesh.position
      camera.getWorldPosition(_camPos).sub(origin)
      _cullMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(_cullShift.makeTranslation(origin.x, origin.y, origin.z))
      const viewChanged = !_cullMat.equals(_lastCullMat)
      if (viewChanged) { _lastCullMat.copy(_cullMat); _cullFrustum.setFromProjectionMatrix(_cullMat) }
      for (const rec of meshes) {
        rec.branch.updateLOD(_camPos, _cullFrustum, viewChanged)
        rec.leaf.updateLOD(_camPos, _cullFrustum, viewChanged)
      }
    }
  }

  function applyCellOcclusion(cell) {
    const visible = !cell.occluded
    for (const en of cell.entries) {
      try { en.rec.branch.setVisibilityAt(en.branchId, visible) } catch (_) {}
      try { en.rec.leaf.setVisibilityAt(en.leafId, visible) } catch (_) {}
      if (sharedImpostor && en.impId != null && en.impId >= 0) {
        try { sharedImpostor.mesh.setVisibilityAt(en.impId, visible) } catch (_) {}
      }
    }
  }


  function dispose() {
    for (const rec of meshes) {
      for (const m of [rec.branch, rec.leaf]) {
        try { scene.remove(m.mesh || m); m.bvh && m.bvh.clear && m.bvh.clear() } catch (_) {}
        try { m.geometry && m.geometry.dispose() } catch (_) {}
        try { m.material && m.material.dispose() } catch (_) {}
        try { m.dispose && m.dispose() } catch (_) {}
      }
      if (rec.impMat) {
        try { rec.impMat.map && rec.impMat.map.dispose() } catch (e) { _dbgVeg('impostor map dispose failed (leak risk):', e?.message || e) }
        try { rec.impMat.normalMap && rec.impMat.normalMap.dispose() } catch (e) { _dbgVeg('impostor normalMap dispose failed (leak risk):', e?.message || e) }
        try { rec.impMat.dispose && rec.impMat.dispose() } catch (e) { _dbgVeg('impostor material dispose failed:', e?.message || e) }
      }
    }
    if (sharedImpostor) {
      try { scene.remove(sharedImpostor.mesh); sharedImpostor.mesh.bvh && sharedImpostor.mesh.bvh.clear && sharedImpostor.mesh.bvh.clear() } catch (_) {}
      try { sharedImpostor.mesh.geometry && sharedImpostor.mesh.geometry.dispose() } catch (_) {}
      try { sharedImpostor.material && sharedImpostor.material.dispose() } catch (_) {}
      try { sharedImpostor.mesh.dispose && sharedImpostor.mesh.dispose() } catch (_) {}
      try { sharedImpostor.atlas && sharedImpostor.atlas.dispose && sharedImpostor.atlas.dispose() } catch (_) {}
      sharedImpostor = null
    }
    meshes.length = 0; loaded.clear(); _occCands = null; totalInstances = 0
    if (typeof window !== 'undefined' && window.__veg && window.__veg._meshes === meshes) delete window.__veg
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
      cell._occProxy.instanceCount = cell.entries.length
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
      _cullDirty = true
      applyCellOcclusion(cell)
    }
  }

  const api = {
    update, updateVisibility, tickWind, prewarm, warmShaders, dispose, _meshes: meshes,
    castShadows: true,
    get sharedImpostor() { return sharedImpostor ? sharedImpostor.mesh : null },
    get totalInstances() { return totalInstances },
    get profile() { return profile },
    rebuildPlacement() { for (const key of [...loaded.keys()]) unloadChunk(key); deferredChunks.clear(); curSuper = null; _ringClean = false; _scanKey = NaN },
    repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); this.rebuildPlacement() },
    biomeOverride,
    getOcclusionCandidates, applyOcclusion,
    cfg, renderDistance,
    streamState: () => placementRing.streamState(loaded, deferredChunks, streamFocus, ringRadiusSq, dropRadiusSq),
  }
  if (typeof window !== 'undefined') window.__veg = api
  return api
}
