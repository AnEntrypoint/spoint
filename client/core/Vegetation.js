// Client visual layer for the ez-tree forest. Reads the SAME deterministic placement as the server (VegPlacement.js) so the visual trunk matches the collided trunk. Per species: ONE InstancedMesh2 holding branch+leaf as two material groups, 3 mesh LODs + BVH per-instance frustum culling. window.__veg / window.__vegProfile.
import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
// streaming-gltf's octahedral impostor (FULL-sphere octahedron - works from any angle, incl ground
// level; the agargaro vendored lib only implemented HEMI so ground views rendered nothing). Plain
// Single canonical impostor implementation (packages/streaming-gltf/src/octahedral-impostor-ez.js,
// shared with ModelPool's OctahedralImpostorEzTier via the same package import elsewhere -- no more
// client/vendor duplicate, see AGENTS.md draw-call-audit-impostor-system-unification).
import { createOctahedralImpostorMaterial, computeObjectBoundingSphere } from 'streaming-gltf/octahedral-impostor-ez'  // full-sphere octahedron (works at ground level, unlike hemi-only variants)
import { buildSharedImpostorAtlas, createSharedImpostorMesh, IMPOSTOR_DISSOLVE_FADE_BAND_M } from './VegImpostorTier.js'
import { createVegChunkCursor, VEG, SPECIES } from '/src/terrain/VegPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'
import { loadEzTree, makeWindUniforms, applyWind, awaitMatTextures, capGeo, simplifyGeo, buildSpecies, makeEmptyGeo, mergeTreeGeo, withSingleGroup, installInstancedMesh2Perf, TARGET_H } from './VegetationBuild.js'
import { spiralOffsets, chunkKey, resolveCameraPose } from './PlacementScheduler.js'
import { createOcclusionSuperCells } from './OcclusionPolicy.js'

const _dbgVeg = dbg('vegetation')

const DROP_MARGIN = 64   // metres past the ring before a chunk is dropped (hysteresis)

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _vanMat = new THREE.Matrix4(), _vanProj = new THREE.Matrix4(), _vanFrustum = new THREE.Frustum()   // scratch for window.__vegVanishProbe
const _now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now()
// ONE debug gate for every window.__veg* live knob (wind override, perf arms, vanish probe): a single
// property read per frame instead of ~8 window.* lookups per tick. Set window.__sceneryDebug = true to
// enable the knobs (they keep their old names); unset, no per-frame window.* read happens at all.
const _dbgOn = (typeof window !== 'undefined') ? () => window.__sceneryDebug === true : () => false

export async function createVegetation(opts = {}) {
  const { renderer, scene, frame } = opts
  // Client-visual paint-biome sync (terrain-paint-biome-client-visual-sync): wraps the SAME cached
  // anchorField the server's collider streamer wraps, same ordering (cache first, biome-blend outside
  // it) -- see src/terrain/TerrainPhysics.js's cachedAnchorField/paintedAnchorField pair. The override
  // store starts empty; client/app.js's onTerrainPaintBiomeAck replays the server's authoritative
  // stroke into biomeOverride.applyPaintBrush then calls api.repaintBiome() to re-stream affected chunks.
  const biomeOverride = createBiomeOverride()
  const anchorField = biomeOverride.wrapClimateField(createCachedAnchorField(opts.anchorField, frame))
  const cfg = opts.cfg || {}
  const worldSeed = (opts.worldSeed ?? cfg.seed ?? 0) | 0
  if (!renderer || !scene || !frame) throw new Error('createVegetation: renderer/scene/frame required')
  installInstancedMesh2Perf()

  // Resolve the ez-tree package HERE (inside createVegetation, not at module top level) so a
  // missing/404'd package degrades to "no vegetation this session" instead of aborting the entire
  // client module graph (see the loadEzTree comment above for the full static-vs-dynamic rationale).
  let Tree
  try {
    ({ Tree } = await loadEzTree())
    if (typeof Tree !== 'function') throw new Error('ez-tree module loaded but exports no Tree constructor')
  } catch (e) {
    console.error('[veg] @dgreenheck/ez-tree failed to load -- vegetation skipped this session (rest of the client is unaffected):', e?.message || e)
    return null
  }

  const renderDistance = Number.isFinite(cfg.renderDistance) ? cfg.renderDistance : 640
  const ringRadius = renderDistance + 40
  const dropRadius = ringRadius + DROP_MARGIN
  const ringRadiusSq = ringRadius * ringRadius
  const dropRadiusSq = dropRadius * dropRadius
  const MAX_INSTANCES = Number.isFinite(cfg.maxInstances) ? cfg.maxInstances : 30000
  // Distance density falloff bounds the instance/triangle budget as renderDistance grows: full density within FALLOFF_NEAR (which sits beyond the server's ~64m trunk-collider ring, so a shootable tree always exists on both client+server), smoothstepping to FALLOFF_FLOOR at renderDistance. A deterministic per-tree coin (keyed off trunkId) avoids shimmer.
  const FALLOFF_NEAR = Number.isFinite(cfg.vegFalloffNear) ? cfg.vegFalloffNear : 96
  const FALLOFF_FLOOR = Number.isFinite(cfg.vegFalloffFloor) ? cfg.vegFalloffFloor : 0.15
  const _falloffSpan = Math.max(1, renderDistance - FALLOFF_NEAR)
  function vegKeepProb(d) {
    if (d <= FALLOFF_NEAR) return 1
    if (d >= renderDistance) return FALLOFF_FLOOR
    const t = (d - FALLOFF_NEAR) / _falloffSpan
    const s = t * t * (3 - 2 * t)                       // smoothstep 0..1
    return 1 - (1 - FALLOFF_FLOOR) * s
  }
  // deterministic [0,1) coin from a stable per-tree id (same hash family as VegPlacement.rand): kept iff coin < keepProb(dist)
  function _treeCoin(id) {
    let x = ((id | 0) ^ 0x9e3779b1) >>> 0
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
    x ^= x >>> 13
    return (x >>> 0) / 4294967296
  }
  // small initial capacity is safe: InstancedMesh2 auto-grows on demand (cap*1.5+512), avoiding tens of MB of unused GPU buffers if pre-allocated at MAX_INSTANCES per species
  const INIT_CAP = Math.min(MAX_INSTANCES, Number.isFinite(cfg.initCapacity) ? cfg.initCapacity : 2048)
  const wind = makeWindUniforms()
  if (_dbgOn() && window.__vegWind != null) wind.uVegWind.value = +window.__vegWind

  // LOD cutovers: the forest is geometry/vertex-bound (ez-tree branch meshes ~10k tris each), so aggressive LOD cutting-in is the perf win (cut tris 891k->43k, fps 24.8->34.9).
  const D1 = Number.isFinite(cfg.lod1) ? cfg.lod1 : Math.min(14, renderDistance * 0.045)
  const D2 = Number.isFinite(cfg.lod2) ? cfg.lod2 : Math.min(35, renderDistance * 0.11)
  const D3 = (_dbgOn() && Number.isFinite(+window.__vegD3)) ? +window.__vegD3 : Number.isFinite(cfg.impostorDistance) ? cfg.impostorDistance : Math.min(renderDistance, Math.max(D2 + 12, renderDistance * 0.13))   // TEMP perf arm override
  // Impostor dissolve-in fade is centered here (VegImpostorTier.js's own nearCutoff); computed once so
  // both the impostor's own nearCutoff and the branch/leaf mesh's far-LOD swap-out distance below stay
  // aligned to the SAME value, never two independently-evaluated D3*0.92 literals drifting apart.
  const IMPOSTOR_NEAR_CUTOFF = D3 * 0.92
  const SHADOW_CAST = Number.isFinite(cfg.shadowCastDistance) ? cfg.shadowCastDistance : 35   // only trees within this cast shadows (the shadow pass is the dominant veg cost)
  // hysteresis threaded into every veg addLOD -- stateless LOD (hysteresis=0) toggles a tree's level every frame at a cutover ("trees pop in/out")
  const LOD_HYS = Number.isFinite(cfg.lodHysteresis) ? cfg.lodHysteresis : 0.12
  // BVH cull margin: must exceed a scaled canopy's reach past its trunk-origin box, or a tree culls while its canopy is still on-screen
  const BVH_MARGIN = Number.isFinite(cfg.bvhMargin) ? cfg.bvhMargin : 24
  const speciesList = Array.isArray(cfg.species) && cfg.species.length ? cfg.species : SPECIES
  // shared impostor (default ON): all species' far-LOD trees draw via one InstancedMesh2 over a shared mega atlas (1 draw) instead of 15 per-species impostor LODs
  // ?veg=branch|impostor|shared|none bisects which veg parts build, to isolate an OOM-leaking part
  const _vegMode = (typeof location !== 'undefined' && (location.search.match(/[?&]veg=(\w+)/) || [])[1]) || 'full'
  const _buildImpostor = _vegMode !== 'branch'
  const USE_SHARED_IMPOSTOR = cfg.sharedImpostor !== false && (_vegMode === 'full' || _vegMode === 'shared')
  // Shadow LODs are only built when some light in the scene actually casts shadows (SceneSetup.js ships
  // sun.castShadow=false and nothing re-enables it, verified by grep 2026-09-06): without a caster the
  // addShadowLOD child objects were dead scene children traversed by three every frame, plus a second
  // simplifyGeo bake per species at boot. cfg.castShadows forces either way. A light that flips
  // castShadow on at runtime after construction would render trees without shadows (documented).
  let CAST_SHADOWS = cfg.castShadows === true
  if (cfg.castShadows == null) { try { scene.traverse(o => { if (o.isLight && o.castShadow) CAST_SHADOWS = true }) } catch (_) {} }

  const meshes = []   // per-species record: { name, mesh (InstancedMesh2: group 0 branch, group 1 leaf), branch: mesh (compat alias), leaf: null, count }

  // time-sliced build: species build back-to-back until an ~8ms budget elapses, then yield once (a fixed one-rAF-per-species yield threw away a whole frame per species on a slow GPU)
  let buildErr = 0
  let _buildT0 = _now()
  for (let i = 0; i < speciesList.length; i++) {
    const name = speciesList[i]
    try {
      const sp = buildSpecies(name, Tree)
      // cap LOD0 to a hard tri budget (raw branch meshes are ~10k tris each, the measured dominant cost)
      const branchGeo0 = await capGeo(sp.branchGeo, Number.isFinite(cfg.branchTriCap) ? cfg.branchTriCap : 2200)
      const leafGeo0 = await capGeo(sp.leafGeo, Number.isFinite(cfg.leafTriCap) ? cfg.leafTriCap : 1400)
      // branch and leaf must share ONE bounding box+sphere (full-tree union): separate cull volumes let the canopy cull independently of the trunk, vanishing the leaves (or the whole tree from the BVH's per-construction-time box) while looking up close or approaching
      branchGeo0.computeBoundingBox(); leafGeo0.computeBoundingBox()
      const _treeBox = branchGeo0.boundingBox.clone().union(leafGeo0.boundingBox)
      const _treeSph = _treeBox.getBoundingSphere(new THREE.Sphere())
      // mesh LODs derived from the capped base; aggressive ratios (geometry is the bottleneck)
      const b1 = await simplifyGeo(branchGeo0, 0.28, false), b2 = await simplifyGeo(branchGeo0, 0.07, true)
      const l1 = await simplifyGeo(leafGeo0, 0.30, false), l2 = await simplifyGeo(leafGeo0, 0.09, true)
      // Shadow LOD geometry: derived from branchGeo0 INDEPENDENTLY, before b2 is ever handed to
      // addLOD below -- @three.ez's InstancedMesh2.patchGeometry stamps a custom 'instanceIndex'
      // attribute onto whatever geometry object addLOD/addLevel consumes to mark it claimed; a second
      // simplifyGeo call at the same ratio produces the same result geometry, minted before any
      // InstancedMesh2 ever touches it, so no stamped attribute exists to clone. Only baked when a
      // shadow caster exists (see CAST_SHADOWS).
      const b2shadow = CAST_SHADOWS ? await simplifyGeo(branchGeo0, 0.07, true) : null
      // ONE geometry per LOD level: branch (group 0) + leaf (group 1) -- see VegetationBuild.mergeTreeGeo.
      const geo0 = mergeTreeGeo(branchGeo0, leafGeo0), geo1 = mergeTreeGeo(b1, l1), geo2 = mergeTreeGeo(b2, l2)
      // every LOD geo must carry the same full-tree union box+sphere, or the BVH culls the instance early when a partial trunk/canopy box exits the frustum
      for (const g of [geo0, geo1, geo2]) { g.boundingBox = _treeBox.clone(); g.boundingSphere = _treeSph.clone() }
      if (b2shadow) { b2shadow.boundingBox = _treeBox.clone(); b2shadow.boundingSphere = _treeSph.clone() }
      const mats = [applyWind(sp.branchMat, wind), applyWind(sp.leafMat, wind)]
      const mesh = new InstancedMesh2(geo0, mats, { capacity: INIT_CAP, renderer })
      mesh.initUniformsPerInstance({ vertex: { windPhase: 'float' }, fragment: { tint: 'float' } })
      mesh.perObjectFrustumCulled = true
      mesh.frustumCulled = false   // BVH owns culling; the whole object must not be camera-culled
      // sortObjects must stay OFF while LODs are in use: @three.ez's sort-based LOD assignment drops instances in the LOD0 band (distance < D1) into no drawn bucket, vanishing every near tree at the same cutover distance
      mesh.addLOD(geo1, mats, D1, LOD_HYS); mesh.addLOD(geo2, mats, D2, LOD_HYS)
      for (const child of mesh.children) {
        if (child._geometry) { child._geometry.boundingBox = _treeBox.clone(); child._geometry.boundingSphere = _treeSph.clone() }
      }
      if (CAST_SHADOWS) {
        // Shadow casting is the dominant veg cost; cast only near trees, zero-area geo beyond SHADOW_CAST for distant trees.
        mesh.addShadowLOD(withSingleGroup(b2shadow), 0)
        mesh.addShadowLOD(withSingleGroup(makeEmptyGeo()), SHADOW_CAST)
        // instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: addShadowLOD's own signature
        // (geometry, distance, hysteresis) has NO material parameter -- @three.ez's addLevel falls back to a
        // bare `new THREE.ShaderMaterial()` for each freshly-created shadow-LOD child object, and that child
        // still gets patchMaterial+updateTextures on the MAIN color pass (compiling a shader that assumes
        // instanceIndex is declared -- a real live GL compile failure). Assign the SAME wind-wrapped
        // materials the render LODs use instead of leaving @three.ez's dummy default in place.
        for (const shadowObj of mesh.LODinfo.objects) {
          if (shadowObj !== mesh && shadowObj.material && shadowObj.material.type === 'ShaderMaterial' && !shadowObj.material.vertexShader?.includes('uVegTime')) {
            shadowObj.material = mats
          }
        }
      }
      // Impostor far-LOD: bakes an octahedral atlas of the whole tree, adding a camera-facing plane as the branch's farthest LOD (leaf swaps to zero-area). Best-effort: any bake failure degrades to mesh-LOD-only.
      let impostor = false, impMatRef = null, impDims = null
      try {
        if (!_buildImpostor) throw new Error('veg-bisect: impostor disabled (?veg=branch)')
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
          // D3 far-LOD decision deferred until after the shared atlas build attempt (which needs every species' atlas); impMat kept so its atlas can be packed into the mega
          impostor = true; impMatRef = impMat
        }
      } catch (e) { console.warn('[veg] impostor bake failed (mesh-LOD-only):', name, e?.message || e) }
      scene.add(mesh)
      mesh.updateMatrix(); mesh.matrixAutoUpdate = false
      // Opaque draw-order band (perf only, zero visual effect -- depth test still enforces correct
      // occlusion regardless of draw order): see Rocks.js's renderOrder comment for the full rationale.
      // Every species shares this band, so this groups ALL vegetation branch/leaf draws adjacently
      // against rocks/grass/terrain/impostor, not against each other.
      mesh.renderOrder = 3
      // `branch` stays as a compat alias of the merged mesh (window.__veg._meshes consumers); `leaf` is
      // null -- the leaf lives in group 1 of the same mesh, never a second InstancedMesh2 any more.
      meshes.push({ name, mesh, branch: mesh, leaf: null, count: 0, impostor, impMat: impMatRef, impDims, bvhCount: 0 })
    } catch (e) { buildErr++; console.error('[veg] species build failed:', name, e?.message || e) }
    if (_now() - _buildT0 > 8) {
      await new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
      _buildT0 = _now()
    }
  }
  // must look up by species name, not array index: a failed species build is absent from meshes (the array compacts), so index-based lookup would map every later species to the wrong mesh
  const recByName = new Map(meshes.map(r => [r.name, r]))

  // Must apply mip/alpha setup AFTER every impostor bake (leafMat renders into a non-multisampled RT during the bake, where A2C is undefined-ish).
  // Anisotropy pinned to 1 (Performance-Mode reference: no anisotropic softening at distance); alphaToCoverage on the leaf cutout when the renderer has real MSAA, alphaTest stays 0.5 for the no-MSAA shadow pass.
  try {
    const maxAniso = 1
    const hasMSAA = !!(renderer.getContext() && renderer.getContext().getContextAttributes && renderer.getContext().getContextAttributes().antialias)
    for (const r of meshes) {
      for (const m of r.mesh.material) {
        if (!m) continue
        for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'alphaMap', 'bumpMap']) {
          const t = m[k]
          if (t && t.isTexture && t.anisotropy !== maxAniso) { t.anisotropy = maxAniso; t.needsUpdate = true }
        }
      }
      const lm = r.mesh.material[1]
      if (lm && hasMSAA && !lm.alphaToCoverage) { lm.alphaToCoverage = true; lm.needsUpdate = true }
    }
  } catch (e) { console.warn('[veg] mip/alpha setup skipped:', e?.message || e) }

  // Packs every species' baked atlas into one mega atlas + one InstancedMesh2, freeing per-species atlases; any failure degrades to the per-species fallback (sharedImpostor stays null).
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
            // nearCutoff slightly inside D3 so the impostor engages before the branch mesh goes empty -- a brief overlap instead of a 1-frame gap where neither draws
            nearCutoff: IMPOSTOR_NEAR_CUTOFF,
            lodHysteresis: LOD_HYS,
            // FULL 3-SPRITE BLEND, not the single-nearest-sprite cheap path (tree-fade-out-then-back-in-dip,
            // 2026-08-24): the single-sprite mode hard-swaps baked views across octant boundaries, a real
            // per-pixel visibility pop now that nearCutoff sits right against the mesh LOD's vanish point.
            farSingleSprite: false,
            // Read ONCE at boot (material is built here, not re-read per-frame) -- see RenderControls.js
            // vegImpostorParallax/vegImpostorParallaxScale docs, same discipline as shadowCascades.
            parallax: RenderControls.get('vegImpostorParallax') === true,
            parallaxScale: RenderControls.get('vegImpostorParallaxScale'),
          })
          if (sharedImpostor) {
            impRecs.forEach((r, i) => { r.impTile = i })
            sharedImpostor.atlas = atlas
            scene.add(sharedImpostor.mesh)
            sharedImpostor.mesh.updateMatrix(); sharedImpostor.mesh.matrixAutoUpdate = false
            // Opaque draw-order band (perf only, zero visual effect): see Rocks.js's renderOrder comment.
            sharedImpostor.mesh.renderOrder = 4
            // free per-species atlases now that they're copied into the mega atlas
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

  // Finalize the impostor far-LOD now that we know whether the shared mesh is live: shared live -> the
  // whole tree goes empty at FAR_LOD_SWAP (the shared mesh draws the far tree); shared off/failed ->
  // per-species billboard fallback (never invisible). LOD2's swap-out sits one LOD bucket before the
  // impostor's own dissolve band STARTS (nearCutoff - band) so the two genuinely overlap across the
  // whole dissolve band instead of LOD2 persisting solid through and past it.
  const FAR_LOD_SWAP = Math.max(D2, IMPOSTOR_NEAR_CUTOFF - IMPOSTOR_DISSOLVE_FADE_BAND_M)
  for (const rec of meshes) {
    if (!rec.impostor) continue
    if (sharedImpostor && rec.impTile != null) {
      // one single-group zero-area triangle: ONE degenerate draw per far tree bucket (was two, one per mesh)
      rec.mesh.addLOD(withSingleGroup(makeEmptyGeo()), rec.mesh.material, FAR_LOD_SWAP, LOD_HYS)
    } else if (rec.impMat) {
      // must stamp the whole-tree bounding sphere on the far-LOD plane, or its default ~0.7 unit-plane sphere pops the impostor out near the frustum edge
      const impPlane = withSingleGroup(new THREE.PlaneGeometry(1, 1))
      if (rec.mesh.geometry && rec.mesh.geometry.boundingSphere) impPlane.boundingSphere = rec.mesh.geometry.boundingSphere.clone()
      rec.mesh.addLOD(impPlane, [rec.impMat], FAR_LOD_SWAP, LOD_HYS)
    }
  }

  const CH = VEG.CHUNK
  const loaded = new Map()   // chunkKey(cx,cz) -> { key, cx, cz, entries, aabbMin, aabbMax, occluded }
  // Occlusion candidates are 128m super-cells (16 chunks per box), never per chunk -- see
  // OcclusionPolicy.createOcclusionSuperCells for why (verdict refresh vs stale fail-open) and why it is
  // hide-less by construction. Vegetation is a candidate to be culled, never an occluder.
  const occ = createOcclusionSuperCells({ prefix: 'v', cellsPerSide: 4, margin: 2, liftMin: 2, countOf: c => c.entries.length })
  let curSuper = null
  let totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, bvhRebuilds: 0, species: speciesList.length, buildErrors: buildErr, impostors: meshes.filter(m => m.impostor).length, loadMsMax: 0, loadMsTotal: 0, deferredTicks: 0, prefetches: 0, castShadows: CAST_SHADOWS }
  if (typeof window !== 'undefined') window.__vegProfile = profile   // profile object identity is stable: mirror it ONCE, not on every tick

  // Commits one finished chunk placement list (from a cursor, budgeted or step(Infinity)) into the
  // instance meshes. px/pz: the focus position the falloff coin is evaluated against (captured when
  // the chunk's cursor was started, exactly the position the old synchronous load used).
  function commitChunk(cx, cz, list, px, pz) {
    const key = chunkKey(cx, cz)
    if (loaded.has(key)) return
    const entries = []
    const _haveCam = Number.isFinite(px) && Number.isFinite(pz)
    // classify+accept into per-species buckets first so each species gets ONE batched addInstances call, not N single-instance calls
    const byRec = new Map()   // rec -> [{x,y,z,yaw,scale,windPhase,tint}]
    // Real placed-tree extent (not a fixed world-space guess): the occlusion query box for this chunk
    // must bracket the ACTUAL ground elevation + real tree height here, or a chunk on a dune/hill whose
    // surface falls outside a fixed window puts the box entirely behind the nearer terrain (self-occlusion
    // regardless of viewing angle). Track real min/max Y (ground level to species-height*scale canopy top).
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
      const rec = recByName.get(name)
      if (!rec) continue
      const tint = 0.82 + (Math.sin(p.windPhase * 1.7) * 0.5 + 0.5) * 0.32
      let bucket = byRec.get(rec)
      if (!bucket) { bucket = []; byRec.set(rec, bucket) }
      bucket.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale, windPhase: p.windPhase, tint, id: -1, entity: null })
      totalInstances++
      const treeH = (TARGET_H[name] || 9) * p.scale
      if (p.y < _minY) _minY = p.y
      if (p.y + treeH > _maxY) _maxY = p.y + treeH
    }
    // Fall back to a sampled ground height (not a hardcoded guess) when the chunk placed zero trees,
    // so an empty-but-still-registered cell's box still fronts the real local terrain.
    if (_minY === Infinity) {
      let gh = 0
      try { gh = frame.groundHeightLocal(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 2; _maxY = gh + 2
    }
    // one batched addInstances call per species mesh; trees have 1 DOF orientation (yaw about +Y)
    for (const [rec, bucket] of byRec) {
      let bi = 0
      rec.mesh.addInstances(bucket.length, (e) => {
        const c = bucket[bi++]
        _q.setFromAxisAngle(_v.set(0, 1, 0), c.yaw)
        e.position.set(c.x, c.y, c.z); e.quaternion.copy(_q); e.scale.setScalar(c.scale)
        c.id = e.id
        c.entity = e   // captured since no id->entity lookup API exists (for occlusion visibility toggling)
      })
      rec.count += bucket.length
      // batched shared-impostor registration: one shared-mesh instance per tree, drawn only beyond D3 (nearCutoff) so no double-draw with the branch mesh
      const impIds = (sharedImpostor && rec.impTile != null) ? sharedImpostor.addImpostors(bucket, rec.impTile) : null
      const ut = rec.mesh.uniformsTexture
      for (let i = 0; i < bucket.length; i++) {
        const c = bucket[i]
        // both per-instance uniforms land in ONE texture row write (setUniformAt on the texture, one enqueue)
        try { ut.setUniformAt(c.id, 'windPhase', c.windPhase); ut.setUniformAt(c.id, 'tint', c.tint); ut.enqueueUpdate(c.id) } catch (_) {}
        entries.push({ rec, id: c.id, entity: c.entity, impId: impIds ? impIds[i] : -1 })
      }
    }
    const cell = { key, cx, cz, entries, aabbMin: [cx * CH, _minY, cz * CH], aabbMax: [(cx + 1) * CH, _maxY, (cz + 1) * CH], occluded: false }
    loaded.set(key, cell)
    occ.add(key, cx, cz, cell)
    _vegLoadFifo.push(cell)
    profile.loads++
    _mutated = true
  }

  // Synchronous full load (prewarm / out-of-band callers): completes any in-flight cursor for this
  // chunk first, else runs a fresh cursor to completion -- byte-identical output to the budgeted path.
  function loadChunk(cx, cz, px, pz) {
    const key = chunkKey(cx, cz)
    if (loaded.has(key)) return
    const t0 = _now()
    let list = null
    if (_inflight && _inflight.key === key) { const f = _inflight; _inflight = null; f.cursor.step(Infinity); list = f.cursor.list; px = f.px; pz = f.pz }
    else { try { const c = createVegChunkCursor(cx, cz, frame, anchorField, worldSeed); c.step(Infinity); list = c.list } catch (_) { list = null } }
    commitChunk(cx, cz, list, px, pz)
    const ms = _now() - t0
    profile.loadMsTotal += ms; if (ms > profile.loadMsMax) profile.loadMsMax = ms
  }

  function unloadChunk(cell) {
    if (!loaded.has(cell.key)) return
    // ONE variadic removeInstances per species mesh per chunk (its trailing array-count trim runs once),
    // and one batched impostor removal, instead of two library calls per tree.
    const ids = new Map()   // rec -> [ids]
    const impIds = []
    for (const en of cell.entries) {
      let a = ids.get(en.rec); if (!a) { a = []; ids.set(en.rec, a) }
      a.push(en.id)
      if (en.impId != null && en.impId >= 0) impIds.push(en.impId)
    }
    for (const [rec, a] of ids) { try { rec.mesh.removeInstances(...a); rec.count -= a.length; totalInstances -= a.length } catch (_) {} }
    if (sharedImpostor && impIds.length) { try { sharedImpostor.removeImpostors(impIds) } catch (_) {} }
    loaded.delete(cell.key)
    occ.remove(cell.key)
    profile.unloads++
    _mutated = true
  }

  // ---- streaming ring -------------------------------------------------------------------------------
  // Per-tick wall-clock budget for placement work (cell classification + height taps): one chunk's
  // 64 cells are spread across ticks by a VegPlacement cursor (order- and value-identical to the old
  // one-shot placementsForChunk), so a chunk whose height taps miss the GPU patch cache never stalls a
  // whole tick. When placement is cheap (patches resident) several chunks complete per tick.
  const LOAD_BUDGET_MS = Number.isFinite(cfg.vegLoadBudgetMs) ? cfg.vegLoadBudgetMs : 6
  let _inflight = null   // { key, cx, cz, cursor, px, pz, t0 }
  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  // idle stream gate: while a still camera would otherwise re-run streamRing every tick (measured ~0.8ms at idle), only run it every IDLE_STRIDE-th tick when displacement < IDLE_EPS
  let _lastSx = NaN, _lastSz = NaN, _idleTicks = 0
  const IDLE_EPS = 0.05, IDLE_STRIDE = 16
  let _vegSpiral = null, _vegSpiralSpan = -1
  let _vegSpiralCursor = 0   // forward-only resume index; reset on chunk-cell change
  const _vegLoadFifo = []   // load-order FIFO of cell records -> O(1) amortized eviction candidate instead of a full Map scan
  // GPU-patch awareness (TerrainBackdrop.js installs frame._patchPrefetch + frame._fractalGroundHeightLocal
  // when the client placement height is the O(1) GPU patch lookup): placement heights are authoritative
  // only from a RESIDENT patch -- a non-resident patch makes createPatchHeightFn fall back to the CPU
  // fractal, which differs from the patch (the server collider's source) by cm..dm. So (1) the next
  // spiral chunk's patch is prefetched one tick ahead, and (2) a chunk whose centre patch is still not
  // resident is DEFERRED (spiral cursor held, no other chunk skipped ahead -- order preserved) for up to
  // DEFER_MAX_TICKS, then placed anyway (the old behaviour). Residency is detected by comparing the patch
  // lookup with the raw fractal at the chunk centre (one fractal eval per deferral check): equal means the
  // lookup fell through to the fractal. Output is unchanged where today's path already hit the patch and
  // strictly more correct (matches the collider) where it used to fall back mid-stream.
  const _patchAware = typeof frame._patchPrefetch === 'function' && typeof frame._fractalGroundHeightLocal === 'function'
  const DEFER_MAX_TICKS = 6
  let _deferKey = -1, _deferTicks = 0, _lastPrefetchKey = -1
  function _patchResident(cx, cz) {
    const x = cx * CH + CH * 0.5, z = cz * CH + CH * 0.5
    let hp, hf
    try { hp = frame.groundHeightLocal(x, z); hf = frame._fractalGroundHeightLocal(x, z) } catch (_) { return true }
    return hp !== hf
  }
  function _prefetchAhead(cCx, cCz, px, pz, fromIdx) {
    if (!_patchAware) return
    const end = Math.min(_vegSpiral.length, fromIdx + 96)
    for (let i = fromIdx; i < end; i++) {
      const cx = cCx + _vegSpiral[i][0], cz = cCz + _vegSpiral[i][1]
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq) continue
      const key = chunkKey(cx, cz)
      if (loaded.has(key) || (_inflight && _inflight.key === key)) continue
      if (key === _lastPrefetchKey) return
      _lastPrefetchKey = key
      const x = cx * CH + CH * 0.5, z = cz * CH + CH * 0.5
      // the centre lookup issues the chunk's own patch bake on a miss; prefetchAround covers the 3x3 neighbours
      try { frame.groundHeightLocal(x, z); frame._patchPrefetch(x, z) } catch (_) {}
      profile.prefetches++
      return
    }
  }
  function _startChunk(cx, cz, px, pz) {
    _inflight = { key: chunkKey(cx, cz), cx, cz, cursor: createVegChunkCursor(cx, cz, frame, anchorField, worldSeed), px, pz, t0: _now() }
  }
  function _finishInflight() {
    const f = _inflight; _inflight = null
    commitChunk(f.cx, f.cz, f.cursor.list, f.px, f.pz)
    const ms = _now() - f.t0
    profile.loadMsTotal += ms; if (ms > profile.loadMsMax) profile.loadMsMax = ms
  }
  function streamRing(px, pz) {
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    curSuper = [cCx, cCz]
    const tickT0 = _now()
    const deadline = tickT0 + LOAD_BUDGET_MS
    let didLoad = false
    if (_inflight) {
      if (!_inflight.cursor.step(Math.max(0, deadline - _now()))) { _ringClean = false; return true }
      _finishInflight(); didLoad = true
    }
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return didLoad
    profile.ringScans = (profile.ringScans || 0) + 1
    const span = Math.ceil(ringRadius / CH)
    if (span !== _vegSpiralSpan) { _vegSpiral = spiralOffsets(span); _vegSpiralSpan = span; _vegSpiralCursor = 0 }
    if (cCx !== _scanCx || cCz !== _scanCz) _vegSpiralCursor = 0
    let deferred = false
    while (totalInstances < MAX_INSTANCES && _now() < deadline) {
      let found = false
      for (; _vegSpiralCursor < _vegSpiral.length; _vegSpiralCursor++) {
        const dx = _vegSpiral[_vegSpiralCursor][0], dz = _vegSpiral[_vegSpiralCursor][1]
        const cx = cCx + dx, cz = cCz + dz
        const ddx = cx * CH - px, ddz = cz * CH - pz
        const key = chunkKey(cx, cz)
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(key)) continue
        if (_patchAware && !_patchResident(cx, cz)) {
          if (_deferKey !== key) { _deferKey = key; _deferTicks = 0 }
          if (++_deferTicks <= DEFER_MAX_TICKS) { profile.deferredTicks++; deferred = true; try { frame._patchPrefetch(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {} break }
        }
        _deferKey = -1
        _startChunk(cx, cz, px, pz)
        _prefetchAhead(cCx, cCz, px, pz, _vegSpiralCursor + 1)
        found = true; break
      }
      if (!found) break
      if (!_inflight.cursor.step(Math.max(0, deadline - _now()))) break
      _finishInflight(); didLoad = true
    }
    let didDrop = false
    while (_vegLoadFifo.length) {
      const cell = _vegLoadFifo[0]
      if (!loaded.has(cell.key)) { _vegLoadFifo.shift(); continue }
      const ddx = cell.cx * CH - px, ddz = cell.cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
        _vegLoadFifo.shift(); unloadChunk(cell); didDrop = true
      }
      break
    }
    // full-scan fallback only when a chunk could newly exceed dropRadius (cell changed) or budget matters (at instance cap) -- avoids an O(loaded) sweep every streaming tick
    const _cellChanged = cCx !== _scanCx || cCz !== _scanCz
    if (!didDrop && _vegLoadFifo.length && (_cellChanged || totalInstances >= MAX_INSTANCES)) {
      // rare fallback: FIFO head still in-range, full scan for a droppable chunk
      for (const cell of loaded.values()) {
        const ddx = cell.cx * CH - px, ddz = cell.cz * CH - pz
        if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
          const fi = _vegLoadFifo.indexOf(cell); if (fi >= 0) _vegLoadFifo.splice(fi, 1)
          unloadChunk(cell); didDrop = true; break
        }
      }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop && !_inflight && !deferred
    return didLoad || didDrop
  }

  // Pre-streams the nearest chunks behind the loading curtain so the spawn view already has the forest, yielding a frame every PREWARM_BATCH chunks so the main thread doesn't freeze (a synchronous version froze the page for multiple seconds).
  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  const PREWARM_BATCH = 2
  async function prewarm(px, pz, maxChunks = 64, budgetMs = 4000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = _now()
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _vegSpiralSpan) { _vegSpiral = spiralOffsets(span); _vegSpiralSpan = span }
    let n = 0
    for (const [dx, dz] of _vegSpiral) {
      if (n >= maxChunks || totalInstances >= MAX_INSTANCES) break
      if (_now() - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(chunkKey(cx, cz))) continue
      loadChunk(cx, cz, px, pz); n++
      if (n % PREWARM_BATCH === 0) await _yieldFrame()
    }
    if (totalInstances > 0 && !bvhBuilt) ensureBVH()
    return n
  }

  function warmShaders(camera) {
    if (!camera) return 0
    // renderer.compile/compileAsync is incompatible with @three.ez InstancedMesh2 (compiles outside the per-object instancing setup, failing VALIDATE_STATUS on instanceIndex); a real render() sets up instancing correctly.
    try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {}
    return meshes.length
  }

  let bvhBuilt = false
  let _profAccum = 0
  function ensureBVH() {
    if (bvhBuilt) return
    for (const rec of meshes) {
      try { rec.mesh.computeBVH({ margin: BVH_MARGIN }); rec.bvhCount = rec.count; profile.bvhRebuilds++ } catch (_) {}
    }
    if (sharedImpostor) { try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); _impostorBvhCount = sharedImpostor.count; profile.bvhRebuilds++ } catch (_) {} }
    bvhBuilt = true
  }

  // PERIODIC BVH REBUILD (impostors-invisible-far-from-spawn fix): ensureBVH() above runs computeBVH()
  // exactly ONCE, near session start when only a few instances exist. Every instance streamed in
  // afterward goes through @three.ez's INCREMENTAL insert path, which the library's own source calls
  // less accurate than a top-down rebuild (live-witnessed: a degenerate incrementally-grown tree
  // failing to discover instances outside the region the initial few-instance tree was built for).
  // Fix: force a fresh top-down computeBVH() once a meaningful fraction of instances have streamed in
  // since the last (re)build -- PER MESH and ROUND-ROBIN, at most ONE mesh rebuilt per tick (a species
  // whose own count grew past the fraction since ITS last build), never all species in one tick.
  let _impostorBvhCount = 0, _bvhRR = 0
  const BVH_REBUILD_GROWTH_FRACTION = 0.5   // rebuild once a mesh's instance count has grown 50% since its last build
  function maybeRebuildBVH() {
    if (!bvhBuilt || totalInstances === 0) return
    const n = meshes.length + (sharedImpostor ? 1 : 0)
    for (let k = 0; k < n; k++) {
      const i = (_bvhRR + k) % n
      if (i < meshes.length) {
        const rec = meshes[i]
        const grown = rec.count - rec.bvhCount
        if (grown > 0 && grown >= rec.bvhCount * BVH_REBUILD_GROWTH_FRACTION) {
          try { rec.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
          rec.bvhCount = rec.count; _bvhRR = i + 1; return
        }
      } else {
        const c = sharedImpostor.count, grown = c - _impostorBvhCount
        if (grown > 0 && grown >= _impostorBvhCount * BVH_REBUILD_GROWTH_FRACTION) {
          try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
          _impostorBvhCount = c; _bvhRR = i + 1; return
        }
      }
    }
  }

  // Debug-only (window.__sceneryDebug=true + window.__vegVanishProbe): find the nearest instance and record its exact
  // LOD/frustum/active/visible/actual-drawn-bucket state to window.__vegVanish (+ push to
  // __vegVanishHits when a near, in-frustum, active+visible instance is assigned to NO drawn bucket --
  // the real "vanishing tree"). Lives outside the hot-path body; shares the closure + module-level scratch.
  function _vanishProbe(camera) {
    try {
      camera.getWorldPosition(_camPos)
      let nd = Infinity, nrec = null, nidx = -1
      for (const rec of meshes) {
        const im = rec.mesh, cnt = im.instancesCount || 0
        for (let i = 0; i < cnt; i++) { im.getMatrixAt(i, _vanMat); _v.setFromMatrixPosition(_vanMat); const d = _v.distanceTo(_camPos); if (d < nd) { nd = d; nrec = rec; nidx = i } }
      }
      if (nrec && nd < 30) {
        const lc = (im) => (im.LODinfo && im.LODinfo.render && Array.from(im.LODinfo.render.count || [])) || null
        const im = nrec.mesh
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
        // ACTUAL drawn bucket: scan each LOD level's instanceIndex array (first `count` entries) for nidx.
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
          t: Math.round(_now()),
          name: nrec.name, dist: +nd.toFixed(2), inFrustum: inFr, camNear: +camera.near.toFixed(2),
          instanceActive: active, instanceVisible: visible,
          nearestLODlevel: lodLevel, nearestLODcount: levelDrawn,
          actualBucket,
          instCount: im.instancesCount || 0,
          treeLOD: lc(im), sharedImpostorDrawn: sharedImpDrawn,
        }
        window.__vegVanish = rec
        if (nd < 15 && inFr === true && active !== false && visible !== false && (actualBucket < 0 || levelDrawn === 0 || levelDrawn == null)) {
          (window.__vegVanishHits = window.__vegVanishHits || []).push(rec)
        }
      }
    } catch (_) {}
  }

  // -------- per-frame / per-tick update ---------------------------------------------------------------
  // tickWind(dt): advances the wind sway uniform every real render frame, independent of the throttled
  // placement cadence (PlacementScheduler.js's MIN_TICK_GAP_MS caps streaming at ~25Hz; the wind uniform
  // is a per-material GPU uniform, essentially free to update every frame, and 25Hz sway was visibly stepped).
  function tickWind(dt) {
    wind.uVegTime.value += dt
    if (_dbgOn() && window.__vegWind != null) wind.uVegWind.value = +window.__vegWind
  }

  let _mutated = false   // an instance was added/removed since the last visibility pass (forces one live cull)
  const _ownPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

  // updateStreaming(dt, camera, playerPos, pose): the ~25Hz placement-decision half -- chunk ring scan
  // (budgeted cursor), eviction, BVH maintenance, profile. Never touches cull state (see updateVisibility).
  function updateStreaming(dt, camera, playerPos, pose) {
    const t0 = _now()
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (pose) { px = pose.x; pz = pose.z }
    else if (camera) { resolveCameraPose(camera, _ownPose); px = _ownPose.x; pz = _ownPose.z }
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastSx, mdz = pz - _lastSz
      const still = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleTicks = still ? _idleTicks + 1 : 0
      _lastSx = px; _lastSz = pz
      profile.streamCalls = (profile.streamCalls || 0) + 1
      // an in-flight cursor or a deferred chunk must keep being serviced every tick even while still
      if (!still || _inflight || _deferKey !== -1 || (_idleTicks % IDLE_STRIDE) === 0) streamRing(px, pz)
      else profile.streamIdleSkips = (profile.streamIdleSkips || 0) + 1
    }
    if (totalInstances > 0) { try { if (!bvhBuilt) ensureBVH(); else maybeRebuildBVH() } catch (_) { bvhBuilt = true } }
    // profile is diagnostic-only, throttled to ~4Hz
    _profAccum += dt
    if (_profAccum >= 0.25) {
      _profAccum = 0
      let vis = 0, impostorInst = 0, meshInst = 0, vegDraws = 0
      for (const rec of meshes) {
        const im = rec.mesh
        vis += (im.count || 0)
        const lodObj = im.LODinfo && im.LODinfo.render
        const c = lodObj && lodObj.count
        if (c && c.length) {
          impostorInst += c[c.length - 1] || 0
          for (let i = 0; i < c.length - 1; i++) meshInst += c[i] || 0
          for (let i = 0; i < c.length; i++) if ((c[i] || 0) > 0) vegDraws += Math.max(1, (lodObj.levels[i].object.geometry.groups || []).length)
        } else if ((im.count || 0) > 0) vegDraws += Math.max(1, (im.geometry.groups || []).length)
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
      profile.loadedChunks = loaded.size
      profile.occSuperCells = occ.superCount
      profile.occHiddenSuperCells = occ.hiddenCount
      try { profile.drawCalls = renderer.info.render.calls } catch (_) {}
    }
    profile.updateMs = _now() - t0
  }

  // updateVisibility(camera, pose, shadowStill): the EVERY-FRAME half -- still-camera detection and the
  // InstancedMesh2 autoUpdate cull-freeze toggle. autoUpdate=true (the @three.ez default) re-runs
  // BVH frustum culling + LOD-bucket assignment for every species mesh + the shared impostor every frame,
  // on both the main-camera AND shadow-camera passes; none of that changes when neither the camera nor the
  // shadow target has moved, so autoUpdate=false freezes the last-computed count/LOD bucket at zero visual
  // cost (wind sway is a vertex-shader uniform). Re-arm ONLY on real camera/shadow-target movement -- a
  // periodic re-arm was live-witnessed causing rapid tree flashing at LOD hysteresis boundaries. A
  // streaming mutation (addInstances/removeInstances never assign a frustum/LOD bucket themselves) forces
  // one live cull pass so a newly streamed tree is never left undrawn for the rest of a freeze window.
  // shadowStill: with no shadow-casting light (CAST_SHADOWS false) the shadow target is irrelevant and
  // always counts as still; a caller running a real shadow pass passes !shadowMoved.
  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985   // ~0.2deg: matches the tightness of IDLE_EPS's 0.05m translation gate
  function updateVisibility(camera, pose, shadowStill) {
    if (!pose && camera) pose = resolveCameraPose(camera, _ownPose)
    let cameraStill = false, rotationStill = true
    if (pose) {
      const mdx = pose.x - _lastPx, mdz = pose.z - _lastPz
      cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      _idleFrames = cameraStill ? _idleFrames + 1 : 0
      _lastPx = pose.x; _lastPz = pose.z
      if (Number.isFinite(_lastQw)) {
        const dot = pose.qx * _lastQx + pose.qy * _lastQy + pose.qz * _lastQz + pose.qw * _lastQw
        rotationStill = Math.abs(dot) >= ROT_COS_EPS
      } else rotationStill = false
      _lastQx = pose.qx; _lastQy = pose.qy; _lastQz = pose.qz; _lastQw = pose.qw
    }
    const shadowOk = CAST_SHADOWS ? shadowStill !== false : true
    const wantFrozen = cameraStill && rotationStill && shadowOk && _idleFrames > 0 && !_mutated
    _mutated = false
    if (wantFrozen !== _cullFrozen) {
      _cullFrozen = wantFrozen
      const auto = !wantFrozen
      for (const rec of meshes) rec.mesh.autoUpdate = auto
      if (sharedImpostor) sharedImpostor.mesh.autoUpdate = auto
      profile.cullFrozen = wantFrozen
    }
    // toggle root visibility off for a species with zero streamed instances (skips its per-frame cull walk); applyOcclusion writes entity.visible, not mesh.visible, so the two never conflict
    for (const rec of meshes) {
      const vis = rec.count > 0
      if (rec.mesh.visible !== vis) rec.mesh.visible = vis
    }
    if (_dbgOn()) {
      for (const rec of meshes) {
        if (window.__vegAllOff) rec.mesh.visible = false   // TEMP perf arm
        if (window.__vegHideFar && window.__vegHideFar.includes(rec.name)) rec.mesh.visible = false   // TEMP perf arm
      }
      if (window.__vegAllOff && sharedImpostor) sharedImpostor.mesh.visible = false   // TEMP perf arm
      if (window.__vegVanishProbe && camera) _vanishProbe(camera)
    }
  }

  // update(): the combined legacy entry (streaming + visibility in one call) for callers that have not
  // been split; RenderGraph.nodes.js's foliage-lod-sync and PlacementScheduler.js call the halves directly.
  function update(dt, camera, playerPos, shadowStill, pose) {
    updateStreaming(dt, camera, playerPos, pose)
    updateVisibility(camera, pose, shadowStill)
  }

  function dispose() {
    for (const rec of meshes) {
      const m = rec.mesh
      try { scene.remove(m); m.bvh && m.bvh.clear && m.bvh.clear() } catch (_) {}
      try { m.geometry && m.geometry.dispose() } catch (_) {}
      try { for (const mat of m.material) mat && mat.dispose() } catch (_) {}
      try { m.dispose && m.dispose() } catch (_) {}
      // must free impostor atlas textures explicitly: material.dispose alone leaks ~10MiB/species across reloads (map/normalMap backed by a WebGLRenderTarget)
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
    meshes.length = 0; loaded.clear(); occ.clear(); _vegLoadFifo.length = 0; _inflight = null; totalInstances = 0
    if (typeof window !== 'undefined' && window.__veg && window.__veg._meshes === meshes) delete window.__veg
  }

  function getOcclusionCandidates() { return occ.candidates() }
  // Delta-applied against the last applied hidden super-cell set (see createOcclusionSuperCells): only
  // the member chunks of a super-cell whose verdict flipped are touched. fail-open by construction: a key
  // absent from occludedKeys leaves entities at their last visible state.
  function _setCellHidden(cell, hide) {
    if (cell.occluded === hide) return
    cell.occluded = hide
    for (const en of cell.entries) {
      try { if (en.entity) en.entity.visible = !hide } catch (_) {}
      // far-LOD shared impostor billboard has NO participation in any occlusion system otherwise -- it
      // only relies on the raw GPU z-test against the terrain depth-writeback. Same per-cell verdict.
      if (sharedImpostor && en.impId != null && en.impId >= 0) {
        try { sharedImpostor.mesh.setVisibilityAt(en.impId, !hide) } catch (_) {}
      }
    }
  }
  function applyOcclusion(occludedKeys) { occ.applyOcclusion(occludedKeys, _setCellHidden) }

  const api = {
    update, updateStreaming, updateVisibility, tickWind, prewarm, warmShaders, dispose, _meshes: meshes,
    // Exposes the far-LOD shared octahedral-impostor InstancedMesh2 (mega-atlas mesh built above, see
    // USE_SHARED_IMPOSTOR/createSharedImpostorMesh) so external consumers -- notably
    // WebGPUCullingHubIntegration.js's GPU-compute-cull A/B correctness harness -- can also exercise it.
    // null when the shared-impostor path is off/degraded (per-species fallback).
    get sharedImpostor() { return sharedImpostor ? sharedImpostor.mesh : null },
    get totalInstances() { return totalInstances },
    get profile() { return profile },
    get castShadows() { return CAST_SHADOWS },
    // _ringClean/_scanCx/_scanCz must reset too, or the next update() sees the same (px,pz) it scanned
    // before this call and takes streamRing's early-exit no-op path forever. Any in-flight cursor and
    // deferral state is dropped (it was placing against the pre-rebuild anchorField).
    rebuildPlacement() { _inflight = null; _deferKey = -1; _lastPrefetchKey = -1; for (const cell of [...loaded.values()]) unloadChunk(cell); _vegLoadFifo.length = 0; curSuper = null; _ringClean = false; _scanCx = NaN; _scanCz = NaN; _vegSpiralCursor = 0 },
    // Applies an authoritative paint-biome stroke (same {x,z,radius,strength,target} shape the server's
    // BiomeOverride.applyPaintBrush takes) to this client's own override layer, then rebuilds placement
    // so the visible trees actually reflect it -- see the onTerrainPaintBiomeAck wiring in client/app.js.
    repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); this.rebuildPlacement() },
    biomeOverride,
    getOcclusionCandidates, applyOcclusion,
    cfg, renderDistance,
  }
  if (typeof window !== 'undefined') window.__veg = api
  return api
}
