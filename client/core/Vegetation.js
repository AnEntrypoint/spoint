// Client visual layer for the ez-tree forest. Reads the SAME deterministic placement as the server (VegPlacement.js) so the visual trunk matches the collided trunk. Per species: one InstancedMesh2 for branches + one for leaves, 3 mesh LODs + a cheap shadow LOD + BVH per-instance frustum culling. window.__veg / window.__vegProfile.
import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
// streaming-gltf's octahedral impostor (FULL-sphere octahedron - works from any angle, incl ground
// level; the agargaro vendored lib only implemented HEMI so ground views rendered nothing). Plain
// Single canonical impostor implementation (packages/streaming-gltf/src/octahedral-impostor-ez.js,
// shared with ModelPool's OctahedralImpostorEzTier via the same package import elsewhere -- no more
// client/vendor duplicate, see AGENTS.md draw-call-audit-impostor-system-unification).
import { createOctahedralImpostorMaterial, computeObjectBoundingSphere } from 'streaming-gltf/octahedral-impostor-ez'  // full-sphere octahedron (works at ground level, unlike hemi-only variants)
import { buildSharedImpostorAtlas, createSharedImpostorMesh, IMPOSTOR_DISSOLVE_FADE_BAND_M } from './VegImpostorTier.js'
import { placementsForChunk, VEG, SPECIES } from '/src/terrain/VegPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { dbg } from './debug-log.js'
import { RenderControls } from './RenderControls.js'
import { loadEzTree, makeWindUniforms, applyWind, awaitMatTextures, capGeo, simplifyGeo, buildSpecies, makeEmptyGeo, TARGET_H } from './VegetationBuild.js'

const _dbgVeg = dbg('vegetation')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)   // shared, never-rendered proxy geo for occlusion candidates
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 64   // metres past the ring before a chunk is dropped (hysteresis)

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()
const _vanMat = new THREE.Matrix4(), _vanProj = new THREE.Matrix4(), _vanFrustum = new THREE.Frustum()   // scratch for window.__vegVanishProbe


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
  if (typeof window !== 'undefined') { wind.uVegWind.value = window.__vegWind != null ? +window.__vegWind : 1 }

  // LOD cutovers: the forest is geometry/vertex-bound (ez-tree branch meshes ~10k tris each), so aggressive LOD cutting-in is the perf win (cut tris 891k->43k, fps 24.8->34.9).
  const D1 = Number.isFinite(cfg.lod1) ? cfg.lod1 : Math.min(14, renderDistance * 0.045)
  const D2 = Number.isFinite(cfg.lod2) ? cfg.lod2 : Math.min(35, renderDistance * 0.11)
  const D3 = (typeof window !== 'undefined' && Number.isFinite(+window.__vegD3)) ? +window.__vegD3 : Number.isFinite(cfg.impostorDistance) ? cfg.impostorDistance : Math.min(renderDistance, Math.max(D2 + 12, renderDistance * 0.13))   // TEMP perf arm override
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

  const meshes = []   // per-species record: { branch: InstancedMesh2, leaf: InstancedMesh2 }

  // time-sliced build: species build back-to-back until an ~8ms budget elapses, then yield once (a fixed one-rAF-per-species yield threw away a whole frame per species on a slow GPU)
  let buildErr = 0
  let _buildT0 = (typeof performance !== 'undefined') ? performance.now() : 0
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
      branchGeo0.boundingBox = _treeBox.clone(); leafGeo0.boundingBox = _treeBox.clone()
      branchGeo0.boundingSphere = _treeSph.clone(); leafGeo0.boundingSphere = _treeSph.clone()
      const branch = new InstancedMesh2(branchGeo0, applyWind(sp.branchMat, wind), { capacity: INIT_CAP, renderer })
      const leaf = new InstancedMesh2(leafGeo0, applyWind(sp.leafMat, wind), { capacity: INIT_CAP, renderer })
      for (const m of [branch, leaf]) {
        m.initUniformsPerInstance({ vertex: { windPhase: 'float' }, fragment: { tint: 'float' } })
        m.perObjectFrustumCulled = true
        m.frustumCulled = false   // BVH owns culling; the whole object must not be camera-culled
        // sortObjects must stay OFF while LODs are in use: @three.ez's sort-based LOD assignment drops instances in the LOD0 band (distance < D1) into no drawn bucket, vanishing every near tree at the same cutover distance
      }
      // mesh LODs derived from the capped base; aggressive ratios (geometry is the bottleneck)
      const b1 = await simplifyGeo(branchGeo0, 0.28, false), b2 = await simplifyGeo(branchGeo0, 0.07, true)
      const l1 = await simplifyGeo(leafGeo0, 0.30, false), l2 = await simplifyGeo(leafGeo0, 0.09, true)
      // Shadow LOD geometry: derived from branchGeo0 INDEPENDENTLY, before b2 is ever handed to
      // addLOD below -- @three.ez's InstancedMesh2.patchGeometry stamps a custom 'instanceIndex'
      // attribute onto whatever geometry object addLOD/addLevel consumes to mark it claimed; cloning
      // AFTER that stamp (the old b2.clone() here) clones the stamp too, so addShadowLOD's own
      // patchGeometry sees an already-claimed geometry and defensively re-clones + warns
      // ("Geometry has been cloned because it was already used") on every single species build --
      // this was the real, repeating GC-churn source (~4MB/frame), not any missing clone. A second
      // simplifyGeo call at the same ratio produces the same result geometry, minted before any
      // InstancedMesh2 ever touches it, so no stamped attribute exists to clone.
      const b2shadow = await simplifyGeo(branchGeo0, 0.07, true)
      // every LOD geo must carry the same full-tree union box+sphere, or the BVH culls the instance early when a partial trunk/canopy box exits the frustum
      for (const g of [b1, b2, l1, l2, b2shadow]) { g.boundingBox = _treeBox.clone(); g.boundingSphere = _treeSph.clone() }
      branch.addLOD(b1, branch.material, D1, LOD_HYS); branch.addLOD(b2, branch.material, D2, LOD_HYS)
      leaf.addLOD(l1, leaf.material, D1, LOD_HYS); leaf.addLOD(l2, leaf.material, D2, LOD_HYS)
      for (const mesh of [branch, leaf]) {
        for (const child of mesh.children) {
          if (child._geometry) { child._geometry.boundingBox = _treeBox.clone(); child._geometry.boundingSphere = _treeSph.clone() }
        }
      }
      // Shadow casting is the dominant veg cost; cast only near trees, zero-area geo beyond SHADOW_CAST for distant trees.
      branch.addShadowLOD(b2shadow, 0)
      branch.addShadowLOD(makeEmptyGeo(), SHADOW_CAST)
      // instancedmesh2-instanceindex-undeclared-identifier-vegetation-shader: addShadowLOD's own signature
      // (geometry, distance, hysteresis) has NO material parameter -- @three.ez's addLevel falls back to a
      // bare `new THREE.ShaderMaterial()` (zero vertex/fragment shader given, so THREE substitutes its own
      // ShaderMaterial default_vertex.glsl.js: `gl_Position = projectionMatrix * modelViewMatrix *
      // vec4(position,1.0)`, no instancing chunks at all) for each freshly-created shadow-LOD child object.
      // That child is a real InstancedMesh2 added to the scene graph (this.add(object) inside addLevel), so
      // THREE's normal per-frame scene traversal reaches its onBeforeRender/patchMaterial on the MAIN color
      // pass too (not just the shadow pass) even though its LODinfo.render never selects it for an actual
      // draw -- InstancedMesh2.onBeforeRender calls patchMaterial+updateTextures (which compiles the
      // material, injecting the windPhase/tint uniformsTexture GLSL that assumes instanceIndex is already
      // declared) BEFORE its own count===0 early-return, so the shader compiles regardless. Real live GL
      // compile failure caught via a WebGL2RenderingContext.prototype.compileShader monkeypatch against a
      // real booted server + vegetation streamed in during real gameplay (PORT=8250, ERROR 0:80/0:81
      // 'instanceIndex' : undeclared identifier) -- a genuinely third, distinct root cause from the
      // Grass.js/SSAO.js hand-written-ShaderMaterial sites this same PRD row also fixed. Fixed by reaching
      // into LODinfo.objects (addLevel's own push target) right after each addShadowLOD call and assigning
      // the SAME wind-wrapped material the render LODs already use (branch.material, matching the addLOD
      // calls above) instead of leaving @three.ez's dummy default in place -- this material already went
      // through applyWind's onBeforeCompile plumbing and compiles correctly under InstancedMesh2's indirect
      // instancing mode.
      for (const shadowObj of branch.LODinfo.objects) {
        if (shadowObj !== branch && shadowObj.material && shadowObj.material.type === 'ShaderMaterial' && !shadowObj.material.vertexShader?.includes('uVegTime')) {
          shadowObj.material = branch.material
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
      scene.add(branch); scene.add(leaf)
      branch.updateMatrix(); branch.matrixAutoUpdate = false
      leaf.updateMatrix(); leaf.matrixAutoUpdate = false
      // Opaque draw-order band (perf only, zero visual effect -- depth test still enforces correct
      // occlusion regardless of draw order): see Rocks.js's renderOrder comment for the full rationale.
      // Every species shares this band (no per-species material sharing exists to sub-group further;
      // see m-veg-fallback-wins-closed), so this groups ALL vegetation branch/leaf draws adjacently
      // against rocks/grass/terrain/impostor, not against each other.
      branch.renderOrder = 3; leaf.renderOrder = 3
      meshes.push({ name, branch, leaf, count: 0, impostor, impMat: impMatRef, impDims })
    } catch (e) { buildErr++; console.error('[veg] species build failed:', name, e?.message || e) }
    const _now = (typeof performance !== 'undefined') ? performance.now() : 0
    if (_now - _buildT0 > 8) {
      await new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
      _buildT0 = (typeof performance !== 'undefined') ? performance.now() : 0
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
            // 2026-08-24): VegImpostorTier.js's createSharedImpostorMesh defaults farSingleSprite to true
            // (opts.farSingleSprite !== false) when the caller doesn't pass the option at all -- this call
            // site never passed it, so the shared impostor silently inherited EZ_FAR_SINGLE_SPRITE. That
            // define makes the fragment shader pick whichever of the 3 nearest octahedral sprites currently
            // has the max view-weight and sample ONLY that one (octahedral-impostor-shaders.js
            // IMPOSTOR_MAP_FRAGMENT) -- as the camera orbits past an octant boundary the max-weight sprite
            // hard-SWAPS to a different baked view with its own independent alpha silhouette, and any pixel
            // covered in the old sprite but uncovered in the new one hits `if (sprite1.a <= alphaClamp)
            // discard` -- a real per-pixel visibility pop at the swap instant. The shader's own comment
            // calls this "acceptable at extreme distance" -- true when this mode was only reached by the
            // FAR/orphaned fallback tier, but the fix above (tree-lod-impostor-fade-overlap-gap) moved this
            // shared impostor's own engage distance (nearCutoff) right up against the mesh LOD's own
            // vanish point, so it is now live-visible far closer than "extreme," where the single-sprite pop
            // reads as "the tree fades out then fades back in" during mouse-look rotation (user-witnessed).
            // Full 3-sprite blend cross-fades smoothly across the same boundary instead of hard-swapping.
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

  // Finalize the impostor far-LOD now that we know whether the shared mesh is live: shared live -> both branch+leaf go empty at FAR_LOD_SWAP (the shared mesh draws the far tree); shared off/failed -> per-species billboard fallback (never invisible).
  // LOD2 (the lowest-quality branch/leaf mesh, active D2->D3) used to swap to its far-LOD exactly at
  // D3, one bucket AFTER the impostor's own dissolve-in fade band (centered at nearCutoff=D3*0.92,
  // +-IMPOSTOR_DISSOLVE_FADE_BAND_M=3) had already finished -- so the impostor was fully opaque for a
  // few metres before LOD2 instantly popped out, an overlap-then-pop rather than a real cross-fade.
  // Pulling LOD2's own swap-out back one LOD bucket closer, to where the impostor's dissolve band
  // STARTS (nearCutoff - band), shrinks LOD2's span so it disappears exactly as the impostor begins
  // fading in -- the two now genuinely overlap across the whole dissolve band instead of LOD2 persisting
  // solid through and past it.
  const FAR_LOD_SWAP = Math.max(D2, IMPOSTOR_NEAR_CUTOFF - IMPOSTOR_DISSOLVE_FADE_BAND_M)
  for (const rec of meshes) {
    if (!rec.impostor) continue
    if (sharedImpostor && rec.impTile != null) {
      rec.branch.addLOD(makeEmptyGeo(), rec.branch.material, FAR_LOD_SWAP, LOD_HYS)
      rec.leaf.addLOD(makeEmptyGeo(), rec.leaf.material, FAR_LOD_SWAP, LOD_HYS)
    } else if (rec.impMat) {
      // must stamp the whole-tree bounding sphere on the far-LOD plane, or its default ~0.7 unit-plane sphere pops the impostor out near the frustum edge
      const impPlane = new THREE.PlaneGeometry(1, 1)
      if (rec.branch.geometry && rec.branch.geometry.boundingSphere) impPlane.boundingSphere = rec.branch.geometry.boundingSphere.clone()
      rec.branch.addLOD(impPlane, rec.impMat, FAR_LOD_SWAP, LOD_HYS)
      rec.leaf.addLOD(makeEmptyGeo(), rec.leaf.material, FAR_LOD_SWAP, LOD_HYS)
    }
  }

  const loaded = new Map()   // "sx,sz" -> { instances: Map<imId, {branchId, leafId, species}> }
  let _occCands = null   // cached getOcclusionCandidates(); nulled on any loaded-set change
  let curSuper = null
  let totalInstances = 0
  const profile = { totalInstances: 0, visibleInstances: 0, drawCalls: 0, updateMs: 0, loads: 0, unloads: 0, bvhRebuilds: 0, species: speciesList.length, buildErrors: buildErr, impostors: meshes.filter(m => m.impostor).length }

  // loads ONE 32m chunk per call, bounding the per-frame classify burst to ~64 candidates so a streaming frame never stalls
  function loadChunk(cx, cz, px, pz) {
    const key = cx + ',' + cz
    if (loaded.has(key)) return
    const entries = []
    let list
    try { list = placementsForChunk(cx, cz, frame, anchorField, worldSeed) } catch (_) { list = null }
    const _haveCam = Number.isFinite(px) && Number.isFinite(pz)
    // classify+accept into per-species buckets first so each species gets ONE batched addInstances call, not N single-instance calls
    const byRec = new Map()   // rec -> [{x,y,z,yaw,scale,windPhase,tint}]
    // Real placed-tree extent (not a fixed world-space [-8,48] guess): the occlusion query box for this
    // chunk must bracket the ACTUAL ground elevation + real tree height here, or a chunk on a dune/hill
    // whose surface falls outside that fixed window puts the box entirely behind the nearer terrain --
    // self-occlusion regardless of viewing angle (same defect class as Rocks.js's "disappear on approach"
    // fix and terrain-occlusion-selfocclusion-envelope, generalized here to this shared streaming-gltf
    // OcclusionQueryTier path). Track real min/max Y (ground level to species-height*scale canopy top)
    // across every placed tree so the box always fronts them.
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
      bucket.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: p.scale, windPhase: p.windPhase, tint })
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
    // one batched addInstances call per species mesh (branch+leaf); trees have 1 DOF orientation (yaw about +Y)
    for (const [rec, bucket] of byRec) {
      let bi = 0
      rec.branch.addInstances(bucket.length, (e) => {
        const c = bucket[bi++]
        _q.setFromAxisAngle(_v.set(0, 1, 0), c.yaw)
        e.position.set(c.x, c.y, c.z); e.quaternion.copy(_q); e.scale.setScalar(c.scale)
        c.branchId = e.id
        c.branchEntity = e   // captured since no id->entity lookup API exists (for occlusion visibility toggling)
      })
      bi = 0
      rec.leaf.addInstances(bucket.length, (e) => {
        const c = bucket[bi++]
        _q.setFromAxisAngle(_v.set(0, 1, 0), c.yaw)
        e.position.set(c.x, c.y, c.z); e.quaternion.copy(_q); e.scale.setScalar(c.scale)
        c.leafId = e.id
        c.leafEntity = e
      })
      rec.count += bucket.length
      // batched shared-impostor registration: one shared-mesh instance per tree, drawn only beyond D3 (nearCutoff) so no double-draw with the branch mesh
      let impIds = null
      if (sharedImpostor && rec.impTile != null) {
        impIds = sharedImpostor.addImpostors(bucket.map(c => ({ species: rec.impTile, x: c.x, y: c.y, z: c.z })))
      }
      for (let i = 0; i < bucket.length; i++) {
        const c = bucket[i]
        const impId = impIds ? impIds[i] : -1
        entries.push({ rec, branchId: c.branchId, leafId: c.leafId, branchEntity: c.branchEntity, leafEntity: c.leafEntity, impId, windPhase: c.windPhase, tint: c.tint })
      }
    }
    for (const en of entries) {
      try {
        en.rec.branch.setUniformAt(en.branchId, 'windPhase', en.windPhase); en.rec.leaf.setUniformAt(en.leafId, 'windPhase', en.windPhase)
        en.rec.branch.setUniformAt(en.branchId, 'tint', en.tint); en.rec.leaf.setUniformAt(en.leafId, 'tint', en.tint)
      } catch (_) {}
    }
    const _aabbMin = [cx * CH, _minY, cz * CH], _aabbMax = [(cx + 1) * CH, _maxY, (cz + 1) * CH]
    loaded.set(key, { entries, aabbMin: _aabbMin, aabbMax: _aabbMax, occluded: false })
    _occCands = null
    _vegLoadFifo.push(key)
    profile.loads++
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

  // loads at most one nearest missing 32m chunk per call so a streaming frame never stalls
  const CH = VEG.CHUNK
  const LOADS_PER_FRAME = 1   // each chunk's placementsForChunk costs ~40ms; more than 1/frame is a visible hitch
  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  // idle stream gate: while a still camera would otherwise re-run streamRing every frame (measured ~0.8ms/frame at idle), only run it every IDLE_STRIDE-th frame when displacement < IDLE_EPS
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05, IDLE_STRIDE = 16
  // still-camera InstancedMesh2 cull gate: autoUpdate=true (the @three.ez default) re-runs BVH/linear
  // frustum culling + LOD-bucket assignment for every species branch/leaf mesh + the shared impostor
  // EVERY frame, on both the main-camera AND shadow-camera passes (build/index.js:664 ctor default,
  // :730/:738 onBeforeShadow/onBeforeRender gates). None of that changes when neither the camera nor the
  // shadow target has moved: setting autoUpdate=false freezes the last-computed count/LOD bucket (verified
  // via frustumCullingAlreadyPerformed/performFrustumCulling source read) at zero visual cost since wind
  // sway is a vertex-shader uniform (uVegTime), independent of which instances are marked drawn. Re-arm
  // (autoUpdate=true) ONLY on real camera/shadow-target movement -- a periodic every-8th-frame re-arm was
  // tried and live-witnessed causing rapid visible tree flashing (a live re-cull on a hysteresis-boundary
  // instance can land in a different LOD bucket than the frozen state purely from float/timing jitter
  // across the freeze window, popping every ~130ms at 60fps). A real slow-hysteresis transition mid-freeze
  // simply completes on the next genuine movement instead of within a fixed frame budget -- correctness
  // preserved (nothing ever needs the freeze broken faster than the player's own next move), flashing gone.
  let _cullFrozen = false
  // rotation-still tracking: cameraStill above is POSITION-only (px,pz), which alone misses a pure
  // look/turn (mouse-look or a stationary character rotating) -- that changes the frustum direction
  // with zero translation, so a position-only gate would freeze culling against a stale view and never
  // re-cull the now-different visible set. Track the camera's world quaternion dot-product against the
  // last-seen orientation; a pure look-around is caught here even when px/pz sit dead still.
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985   // ~0.2deg: matches the tightness of IDLE_EPS's 0.05m translation gate
  const _cullQ = new THREE.Quaternion()
  let _vegSpiral = null, _vegSpiralSpan = -1
  let _vegSpiralCursor = 0   // forward-only resume index; reset on chunk-cell change
  const _vegLoadFifo = []   // load-order FIFO -> O(1) amortized eviction candidate instead of a full Map scan
  function _vegSpiralOffsets(span) {
    // must be bounded/terminating (a prior manual spiral never terminated and OOM'd the tab)
    const out = []
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dz) <= span) out.push([dx, dz])
    out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
    return out
  }
  function streamRing(px, pz) {
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    curSuper = [cCx, cCz]
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return
    profile.ringScans = (profile.ringScans || 0) + 1
    const span = Math.ceil(ringRadius / CH)
    if (span !== _vegSpiralSpan) { _vegSpiral = _vegSpiralOffsets(span); _vegSpiralSpan = span; _vegSpiralCursor = 0 }
    if (cCx !== _scanCx || cCz !== _scanCz) _vegSpiralCursor = 0
    let didLoad = false
    for (let n = 0; n < LOADS_PER_FRAME && totalInstances < MAX_INSTANCES; n++) {
      let found = false
      for (; _vegSpiralCursor < _vegSpiral.length; _vegSpiralCursor++) {
        const dx = _vegSpiral[_vegSpiralCursor][0], dz = _vegSpiral[_vegSpiralCursor][1]
        const cx = cCx + dx, cz = cCz + dz
        const ddx = cx * CH - px, ddz = cz * CH - pz
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
        loadChunk(cx, cz, px, pz); didLoad = true; found = true; break
      }
      if (!found) break
    }
    let didDrop = false
    while (_vegLoadFifo.length) {
      const key = _vegLoadFifo[0]
      if (!loaded.has(key)) { _vegLoadFifo.shift(); continue }
      const ci = key.indexOf(',')
      const kx = +key.slice(0, ci), kz = +key.slice(ci + 1)
      const ddx = kx * CH - px, ddz = kz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
        _vegLoadFifo.shift(); unloadChunk(key); didDrop = true
      }
      break
    }
    // full-scan fallback only when a chunk could newly exceed dropRadius (cell changed) or budget matters (at instance cap) -- avoids an O(loaded) sweep every streaming frame
    const _cellChanged = cCx !== _scanCx || cCz !== _scanCz
    if (!didDrop && _vegLoadFifo.length && (_cellChanged || totalInstances >= MAX_INSTANCES)) {
      // rare fallback: FIFO head still in-range, full scan for a droppable chunk
      for (const key of loaded.keys()) {
        const ci = key.indexOf(',')
        const kx = +key.slice(0, ci), kz = +key.slice(ci + 1)
        const ddx = kx * CH - px, ddz = kz * CH - pz
        if ((ddx * ddx + ddz * ddz) > dropRadiusSq) {
          const fi = _vegLoadFifo.indexOf(key); if (fi >= 0) _vegLoadFifo.splice(fi, 1)
          unloadChunk(key); didDrop = true; break
        }
      }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop
    return didLoad || didDrop
  }

  // Pre-streams the nearest chunks behind the loading curtain so the spawn view already has the forest, yielding a frame every PREWARM_BATCH chunks so the main thread doesn't freeze (a synchronous version froze the page for multiple seconds).
  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  const PREWARM_BATCH = 2
  async function prewarm(px, pz, maxChunks = 64, budgetMs = 4000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _vegSpiralSpan) { _vegSpiral = _vegSpiralOffsets(span); _vegSpiralSpan = span }
    let n = 0
    for (const [dx, dz] of _vegSpiral) {
      if (n >= maxChunks || totalInstances >= MAX_INSTANCES) break
      if (((typeof performance !== 'undefined') ? performance.now() : 0) - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
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
      try { rec.branch.computeBVH({ margin: BVH_MARGIN }); rec.leaf.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
    }
    if (sharedImpostor) { try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {} }
    bvhBuilt = true
    _instancesAtLastBVHBuild = totalInstances
  }

  // PERIODIC BVH REBUILD (impostors-invisible-far-from-spawn fix): ensureBVH() above runs computeBVH()
  // exactly ONCE, near session start when only a few instances exist. Every instance streamed in
  // afterward (addImpostors -> addInstances -> per-instance bvh.insert(), see @three.ez/instanced-mesh's
  // own InstancedMeshBVH.create() doc comment: "more efficient and accurate compared to incremental
  // methods, which add one instance at a time") goes through the INCREMENTAL insert path the library's
  // own source explicitly calls less accurate than a top-down rebuild. Live-witnessed: at a pose far
  // from spawn (614 occlusion candidates, 1524 total instances, 437 shared-impostor instances all
  // reporting active+visible+correctly-positioned via getActiveAt/getVisibilityAt/getPositionAt) the
  // shared impostor's BVHCullingLOD walk still returned drawnCount~6 regardless of camera movement --
  // consistent with a degenerate incrementally-grown tree failing to discover instances outside the
  // region the initial few-instance tree was built for, independent of the cull-freeze gate (which was
  // separately confirmed toggling correctly). Fix: force a fresh top-down computeBVH() rebuild once a
  // meaningful fraction of instances have streamed in since the last (re)build -- bounded cost (rebuild
  // is O(instances), matches the one-time startup cost), infrequent enough to never hitch every frame.
  let _instancesAtLastBVHBuild = 0
  const BVH_REBUILD_GROWTH_FRACTION = 0.5   // rebuild once instance count has grown 50% since last build
  function maybeRebuildBVH() {
    if (!bvhBuilt || totalInstances === 0) return
    const grown = totalInstances - _instancesAtLastBVHBuild
    if (grown <= 0 || grown < _instancesAtLastBVHBuild * BVH_REBUILD_GROWTH_FRACTION) return
    for (const rec of meshes) {
      try { rec.branch.computeBVH({ margin: BVH_MARGIN }); rec.leaf.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {}
    }
    if (sharedImpostor) { try { sharedImpostor.mesh.computeBVH({ margin: BVH_MARGIN }); profile.bvhRebuilds++ } catch (_) {} }
    _instancesAtLastBVHBuild = totalInstances
  }

  // Debug-only (window.__vegVanishProbe): find the nearest branch instance and record its exact
  // LOD/frustum/active/visible/actual-drawn-bucket state to window.__vegVanish (+ push to
  // __vegVanishHits when a near, in-frustum, active+visible instance is assigned to NO drawn bucket --
  // the real "vanishing tree"). Lives outside update()'s hot-path body so the per-frame contract stays
  // legible; shares the closure + module-level scratch (_camPos/_vanMat/_v/_vanFrustum/_vanProj).
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
        // active/visible flags for the specific instance (false => the lib will not draw it)
        let active = null, visible = null
        try { if (typeof im.getActiveAt === 'function') active = im.getActiveAt(nidx) } catch (_) {}
        try { if (typeof im.getVisibilityAt === 'function') visible = im.getVisibilityAt(nidx) } catch (_) {}
        // ACTUAL drawn bucket: scan each LOD level's instanceIndex array (first `count` entries) for nidx.
        // -1 => the instance was assigned to NO drawn LOD this frame (the real vanish). This reveals the
        // TRUE render assignment (vs getObjectLODIndexForDistance which is only the intended mapping).
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

  // -------- frame update -----------------------------------------------------
  // shadowStill: caller (app.js animate()) passes !_shadowMoved (ShadowPipeline.update()'s texel-step
  // return value) so the cull-freeze requires BOTH camera AND shadow-target to be still --
  // a still camera whose shadow target is still moving (e.g. following a different focus point)
  // must keep culling live or the shadow pass paints against a stale instance set.
  // tickWind(dt): advances the wind sway uniform every real render frame, independent of
  // update()'s own throttled placement-decision cadence (PlacementScheduler.js's MIN_TICK_GAP_MS
  // caps update() at ~25Hz so the expensive chunk-streaming scan doesn't run every frame at 60fps --
  // correct for placement, but wind.uVegTime was ALSO only advancing on those same ~25Hz ticks,
  // producing visibly jerky/stepped sway instead of smooth 60Hz motion since it is a per-material GPU
  // uniform, not per-instance state, and is essentially free to update every frame). Callers should
  // invoke this unconditionally every frame and still call update() on its existing throttle for
  // everything else.
  function tickWind(dt) {
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
    let cameraStill = false
    let _streamMutated = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastPx, mdz = pz - _lastPz
      const still = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < IDLE_EPS * IDLE_EPS
      cameraStill = still
      _idleFrames = still ? _idleFrames + 1 : 0
      _lastPx = px; _lastPz = pz
      profile.streamCalls = (profile.streamCalls || 0) + 1
      if (!still || (_idleFrames % IDLE_STRIDE) === 0) _streamMutated = !!streamRing(px, pz)
      else profile.streamIdleSkips = (profile.streamIdleSkips || 0) + 1
    }
    // Rotation-still check: independent of the position source above, always read the real camera's
    // world orientation (a pure look-around must unfreeze even if playerPos never moves).
    let rotationStill = true
    if (camera) {
      camera.getWorldQuaternion(_cullQ)
      if (Number.isFinite(_lastQw)) {
        const dot = _cullQ.x * _lastQx + _cullQ.y * _lastQy + _cullQ.z * _lastQz + _cullQ.w * _lastQw
        rotationStill = Math.abs(dot) >= ROT_COS_EPS
      } else rotationStill = false
      _lastQx = _cullQ.x; _lastQy = _cullQ.y; _lastQz = _cullQ.z; _lastQw = _cullQ.w
    }
    // Still-gate: only ever freeze once at least one still frame has been observed (never on the
    // very first update() call, where _lastPx/_lastPz start NaN and cameraStill reads false) --
    // _idleFrames already encodes this (0 on any movement including the initial NaN transition).
    // _idleFrames counts position-still frames only; AND rotationStill directly so a stationary-but-
    // turning camera never freezes regardless of the position-based counter's value.
    // A still-camera IDLE_STRIDE streamRing pass can still add/remove real instances (a chunk crosses
    // ringRadius/dropRadius while the player stands still near its boundary) -- addInstance/removeInstances
    // (node_modules/@three.ez/instanced-mesh's feature/Instances.js) never assign a frustum/LOD bucket
    // themselves, only performFrustumCulling does, and that is fully skipped while autoUpdate=false. Left
    // alone, a newly streamed-in tree would stay undrawn (never enter LODinfo.render.count) for the rest of
    // the freeze window. Forcing wantFrozen false for this one frame re-arms autoUpdate via the existing
    // toggle below, so the normal cull pass runs once and re-buckets the mutated instance set; the still-
    // camera gate then re-freezes on its own next frame if the camera is still actually motionless.
    const wantFrozen = cameraStill && rotationStill && shadowStill !== false && _idleFrames > 0 && !_streamMutated
    if (wantFrozen !== _cullFrozen) {
      _cullFrozen = wantFrozen
      const auto = !wantFrozen
      for (const rec of meshes) { rec.branch.autoUpdate = auto; rec.leaf.autoUpdate = auto }
      if (sharedImpostor) sharedImpostor.mesh.autoUpdate = auto
      profile.cullFrozen = wantFrozen
    }
    if (totalInstances > 0) { try { if (!bvhBuilt) ensureBVH(); else maybeRebuildBVH() } catch (_) { bvhBuilt = true } }
    // toggle root visibility off for a species with zero streamed instances (skips its per-frame cull walk); applyOcclusion writes entity.visible, not mesh.visible, so the two never conflict
    for (const rec of meshes) {
      const vis = rec.count > 0
      if (rec.branch.visible !== vis) { rec.branch.visible = vis; rec.leaf.visible = vis }
      if (typeof window !== 'undefined' && window.__vegLeafOff) rec.leaf.visible = false   // TEMP perf arm
      if (typeof window !== 'undefined' && window.__vegAllOff) { rec.branch.visible = false; rec.leaf.visible = false }   // TEMP perf arm
      if (typeof window !== 'undefined' && window.__vegHideFar && window.__vegHideFar.includes(rec.name)) { rec.branch.visible = false; rec.leaf.visible = false }   // TEMP perf arm
    }
    if (typeof window !== 'undefined' && window.__vegAllOff && sharedImpostor) sharedImpostor.mesh.visible = false   // TEMP perf arm
    // diagnostic (window.__vegVanishProbe=true): tracks the nearest instance's exact LOD/visibility state to catch a single vanishing tree the species-total counts can't reveal. Extracted from the hot path so update()'s body reads as the per-frame contract; the probe only runs when the debug global is set.
    if (typeof window !== 'undefined' && window.__vegVanishProbe && camera) _vanishProbe(camera)
    // profile is diagnostic-only, throttled to ~4Hz
    _profAccum += dt
    if (_profAccum >= 0.25) {
      _profAccum = 0
      let vis = 0, impostorInst = 0, meshInst = 0, vegDraws = 0
      const countDraws = (im) => {
        const lc = im.LODinfo && im.LODinfo.render && im.LODinfo.render.count
        if (lc && lc.length) { let n = 0; for (let i = 0; i < lc.length; i++) if ((lc[i] || 0) > 0) n++; return n }
        return (im.count || 0) > 0 ? 1 : 0
      }
      for (const rec of meshes) {
        vis += (rec.branch.count || 0)
        const c = rec.branch.LODinfo && rec.branch.LODinfo.render && rec.branch.LODinfo.render.count
        if (c && c.length) { impostorInst += c[c.length - 1] || 0; for (let i = 0; i < c.length - 1; i++) meshInst += c[i] || 0 }
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
      profile.updateMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0
      if (typeof window !== 'undefined') window.__vegProfile = profile
    }
  }

  function dispose() {
    for (const rec of meshes) {
      for (const m of [rec.branch, rec.leaf]) {
        try { scene.remove(m); m.bvh && m.bvh.clear && m.bvh.clear() } catch (_) {}
        try { m.geometry && m.geometry.dispose() } catch (_) {}
        try { m.material && m.material.dispose() } catch (_) {}
        try { m.dispose && m.dispose() } catch (_) {}
      }
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
    meshes.length = 0; loaded.clear(); _occCands = null; totalInstances = 0
    if (typeof window !== 'undefined' && window.__veg && window.__veg._meshes === meshes) delete window.__veg
  }

  // Vegetation is a candidate to be culled, never an occluder (thin/transparent geometry). One box proxy per loaded 32m chunk (not per-instance, too many candidates for the query budget).
  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (!cell._occProxy) {
        const root = new THREE.Object3D()
        // must have a real (unit-box) mesh child: OcclusionQueryTier's Box3.setFromObject walks geometry not transforms, so a bare Object3D yields an empty box and the candidate never queries
        const perProxyOccBoxGeo = _occBoxGeo.clone()
        const boxMesh = new THREE.Mesh(perProxyOccBoxGeo, _occBoxMat)
        boxMesh.visible = false
        boxMesh.raycast = () => {}
        root.add(boxMesh)
        // margin+lift: a box flush with the exact ground-anchored AABB false-occludes at steep downward
        // viewing angles / close range (mirrors TerrainOcclusion.js's elevation-envelope fix and Rocks.js's
        // "disappear on approach" fix). aabbMin/aabbMax now bracket the REAL placed-tree elevation extent
        // (see loadChunk), so LIFT only needs to cover half the box's own height (proportional) instead of
        // a flat constant that's inadequate once the real extent exceeds a few metres.
        const rawH = cell.aabbMax[1] - cell.aabbMin[1]
        const MARGIN = 2, LIFT = Math.max(2, rawH * 0.5)
        const size = [cell.aabbMax[0] - cell.aabbMin[0] + MARGIN * 2, rawH + MARGIN * 2, cell.aabbMax[2] - cell.aabbMin[2] + MARGIN * 2]
        root.position.set((cell.aabbMin[0] + cell.aabbMax[0]) / 2, (cell.aabbMin[1] + cell.aabbMax[1]) / 2 + LIFT, (cell.aabbMin[2] + cell.aabbMax[2]) / 2)
        root.scale.set(Math.max(size[0], 1e-3), Math.max(size[1], 1e-3), Math.max(size[2], 1e-3))
        root.updateMatrixWorld(true)
        cell._occProxy = { root, key }
      }
      // instanceCount refreshed every call (entries mutates as trees load/unload within an already-cached
      // chunk) so a chunk-count-based anomaly check in the shared occlusion consumer can weight by real
      // instance density instead of treating every chunk as equal -- a single densely-packed chunk hiding
      // can mask a majority-of-INSTANCES false-occlusion while looking like a tiny chunk-count fraction.
      cell._occProxy.instanceCount = cell.entries.length
      out.push(cell._occProxy)
    }
    _occCands = out
    return out
  }
  // fail-open by construction: a key absent from occludedKeys leaves entities at their last visible state
  function applyOcclusion(occludedKeys) {
    for (const [key, cell] of loaded) {
      const shouldHide = occludedKeys.has(key)
      if (shouldHide === cell.occluded) continue
      cell.occluded = shouldHide
      for (const en of cell.entries) {
        try { if (en.branchEntity) en.branchEntity.visible = !shouldHide } catch (_) {}
        try { if (en.leafEntity) en.leafEntity.visible = !shouldHide } catch (_) {}
        // far-LOD shared impostor billboard has NO participation in any occlusion system otherwise -- it
        // only relies on the raw GPU z-test against the terrain depth-writeback, which false-negatives
        // (shows through hills) and false-positives (hides visible trees) at steep/grazing view angles.
        // Same per-chunk verdict as branch/leaf above; impId is the InstancedMesh2 instance id already
        // captured at load time (see loadChunk -> sharedImpostor.addImpostors).
        if (sharedImpostor && en.impId != null && en.impId >= 0) {
          try { sharedImpostor.mesh.setVisibilityAt(en.impId, !shouldHide) } catch (_) {}
        }
      }
    }
  }

  const api = {
    update, tickWind, prewarm, warmShaders, dispose, _meshes: meshes,
    // Exposes the far-LOD shared octahedral-impostor InstancedMesh2 (millions-of-blades-scale mega-atlas
    // mesh built above, see USE_SHARED_IMPOSTOR/createSharedImpostorMesh) so external consumers -- notably
    // WebGPUCullingHubIntegration.js's GPU-compute-cull A/B correctness harness, which previously only
    // covered per-species branch/leaf meshes via _meshes -- can also exercise the actual millions-of-instance
    // tier this PRD row's compute-culling scope targets. null when the shared-impostor path is off/degraded
    // (per-species fallback), matching every other optional accessor's shape here.
    get sharedImpostor() { return sharedImpostor ? sharedImpostor.mesh : null },
    get totalInstances() { return totalInstances },
    get profile() { return profile },
    // _ringClean/_scanCx/_scanCz must reset too, or the next update() sees the same (px,pz) it scanned
    // before this call and takes streamRing's early-exit no-op path forever -- the just-emptied `loaded`
    // map would never repopulate until a real position change invalidates the stale scan-cache (same
    // frozen-derived-state-vs-fresh-recompute class as the cull-freeze/streamRing gap above).
    rebuildPlacement() { for (const key of [...loaded.keys()]) unloadChunk(key); curSuper = null; _ringClean = false; _scanCx = NaN; _scanCz = NaN },
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
