// Dense near-only instanced ground grass: two InstancedMesh2 tiers of crossed tapered blades (near
// full-curve geometry, mid flat-quad geometry, assigned per-chunk by distance -- see createGrass's LOD
// block), GPU wind sway, chunk-streamed within a short ring, chunk-granularity manual frustum culling
// (perObjectFrustumCulled off, no per-blade BVH). Visual-only, no collider. window.__grass / window.__grassProfile.
// Two independent per-blade shader-uniform effects on top of placement: player/actor BEND (transient,
// see MAX_BENDERS below) and burn/flatten DECALS (persistent world-state, api.markScorched, backed by
// src/terrain/GrassDecal.js -- see MAX_DECALS below).
import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { placementsForGrassChunk, createGrassChunkCursor, GRASS } from '/src/terrain/GrassPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createModelExclusionField } from '/src/terrain/ModelExclusionField.js'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import { dbg } from './debug-log.js'
import { MAX_BENDERS, MAX_DECALS, makeBladeGeo, makeWind, makeGrassMaterial } from './GrassMaterial.js'

// Re-exported from GrassMaterial.js for backward compatibility (RenderGraph.nodes.js references
// Grass.MAX_BENDERS in its own comments; no current importer reaches these, kept for API stability).
export { MAX_BENDERS, MAX_DECALS }

const _dbgGrass = dbg('grass')
const _occBoxGeo = new THREE.BoxGeometry(1, 1, 1)   // shared, never-rendered proxy geo for occlusion candidates
const _occBoxMat = new THREE.MeshBasicMaterial()

const DROP_MARGIN = 16
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _camPos = new THREE.Vector3()

export async function createGrass(opts = {}) {
  const { renderer, scene, frame } = opts
  // Client-visual paint-biome sync (terrain-paint-biome-client-visual-sync) -- see the matching comment
  // in Vegetation.js's createVegetation for the full rationale; same wrap ordering as
  // src/terrain/TerrainPhysics.js's cachedAnchorField/paintedAnchorField pair.
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

  // --- Multi-tier blade geometry LOD (near full-curve / mid flat-quad) -------------------------------
  // Beyond ~15m the multi-segment curve baked into the near tier is sub-pixel (per PRD row), so a mid
  // tier reuses the SAME crossed-quad topology at N=1 (4 tris/blade vs 20 -- an ~5x per-blade vertex/tri
  // cut) rather than a different silhouette shape that would visibly "pop" at the cutover. A true third
  // (far) geometry tier was considered and deliberately NOT added: grass already hard-unloads chunks
  // beyond `ringRadius` (see streamRing/dropRadius below) and the vertex shader ring-fades blade scale to
  // zero approaching that edge (uGrassRing, see makeGrassMaterial's vertex stage) -- a chunk-streamed
  // system's "far tier" IS the unload boundary, so adding a fixed-topology far tier (billboard or
  // terrain-shader shell/noise band) would duplicate work the streaming ring + fade already do, for a
  // regime (grass blades near the world's own draw-distance edge) that's rarely on-screen densely enough
  // to matter. This is the documented "simpler, safely achievable" branch named in the task.
  const LOD_NEAR_DIST = Number.isFinite(cfg.grassLodNearDistance) ? cfg.grassLodNearDistance : 8
  const geoNear = makeBladeGeo(5)     // full 5-segment curved blade, 20 tris/blade (10 quads x 2 tris)
  const geoMid = makeBladeGeo(1)      // flat single-segment crossed quad, 4 tris/blade
  const mat = makeGrassMaterial(wind)
  const im = new InstancedMesh2(geoNear, mat, { capacity: INIT_CAP, renderer })
  const imMid = new InstancedMesh2(geoMid, mat, { capacity: Math.min(INIT_CAP, 2048), renderer })
  // instShadow: per-instance cached terrain-shadow scalar (0..1), sampled once per blade at placement
  // time from the terrain frame's ground-shadow/AO field -- not a real shadow-map fetch (see makeGrassMaterial).
  for (const m of [im, imMid]) {
    m.initUniformsPerInstance({ vertex: { windPhase: 'float', instShadow: 'float' }, fragment: { tint: 'float' } })
    // Chunk-granularity culling (not per-blade BVH): grass streams in 32m chunks whose real AABB is
    // already tracked per-chunk (see commitChunk's aabbMin/aabbMax, reused by getOcclusionCandidates
    // below). At 40k blades, per-instance BVH/linear frustum culling every frame is pure CPU overhead
    // once the GPU has headroom to just draw+depth-discard off-screen blades -- so perObjectFrustumCulled
    // stays OFF (frustumCulling() takes the cheap updateIndexArray() path: filters active+visibility bits
    // only, no per-instance sphere/BVH test, see node_modules/@three.ez/instanced-mesh's FrustumCulling.js
    // read before this change -- confirmed `!perObjectFrustumCulled && !sortObjects` short-circuits
    // straight to updateIndexArray). Per-CHUNK visibility is instead driven manually in update() by
    // testing each loaded chunk's real AABB against the camera frustum (THREE.Frustum.intersectsBox) and
    // toggling every blade in an off-frustum chunk invisible via the same setVisibilityAt used by
    // applyOcclusion below -- coarser than per-blade but the actual CPU-cost driver (an O(40000) test
    // every frame) collapses to O(loaded-chunk-count), typically a few dozen. The vertex-shader ring-fade
    // (uGrassRing) already handles the soft edge case the task calls out for the remaining per-instance
    // imprecision at a chunk's own boundary.
    m.perObjectFrustumCulled = false
    m.frustumCulled = false
  }
  // No per-instance sort: blades are opaque (depth test handles ordering), avoiding a per-frame O(n) radix sort.
  scene.add(im); scene.add(imMid)
  im.updateMatrix(); im.matrixAutoUpdate = false
  imMid.updateMatrix(); imMid.matrixAutoUpdate = false
  // Opaque draw-order band (perf only, zero visual effect): see Rocks.js's renderOrder comment.
  im.renderOrder = 2; imMid.renderOrder = 2
  // Grass never casts shadows (no castShadow set), so no shadow-camera BVH-cull pass ever runs against
  // it -- unlike Vegetation.js, only the main-camera-pass autoUpdate needs a still-camera freeze gate.

  const loaded = new Map()
  let _occCands = null   // cached getOcclusionCandidates(); nulled on any loaded-set change
  let totalInstances = 0
  const profile = { totalInstances: 0, loads: 0, unloads: 0, updateMs: 0, grassDrawCalls: 2, ringScans: 0, cullMs: 0, chunksCulled: 0 }
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  // Real placed-blade extent (not a fixed world-space guess): the occlusion query box for this chunk
  // must bracket the ACTUAL ground elevation + blade height here, or a chunk on a dune/hill whose
  // surface falls outside a fixed window puts the box entirely behind the nearer terrain --
  // self-occlusion regardless of viewing angle (same defect class as Vegetation.js/Rocks.js's
  // "disappear on approach" fix, generalized here to grass's own streaming-gltf OcclusionQueryTier
  // candidate). Track real min/max Y (ground level to blade tip) across every placed blade in the
  // batch so the box always fronts them.
  //
  // LOD-tier pick: PER-CHUNK, not per-blade -- a chunk is 32m across (GRASS.CHUNK) vs a 44m default
  // render distance, so per-blade tier assignment inside one chunk would barely matter while doubling
  // the addInstances bookkeeping (two id spaces per chunk instead of one); the whole chunk goes to
  // whichever tier its CENTER falls into at commit time, using the player position passed in from
  // streamRing/prewarm (loadChunk has no live camera, so it falls back to treating an out-of-band call
  // as near-tier -- conservative: more detail, never less).
  function commitChunk(key, list, px, pz) {
    const ci2 = key.indexOf(','); const kcx = +key.slice(0, ci2), kcz = +key.slice(ci2 + 1)
    const centerX = kcx * CH + CH * 0.5, centerZ = kcz * CH + CH * 0.5
    let useMid = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const ddx = centerX - px, ddz = centerZ - pz
      useMid = (ddx * ddx + ddz * ddz) > LOD_NEAR_DIST * LOD_NEAR_DIST
    }
    const targetMesh = useMid ? imMid : im
    const entries = []
    let _minY = Infinity, _maxY = -Infinity
    if (list) {
      const batch = Math.min(list.length, MAX_INSTANCES - totalInstances)
      // Single batched addInstances(batch, onCreation) call instead of `batch` individual
      // addInstances(1, ...) calls: each single-count call re-enters the full addInstance
      // machinery (active-bit set, freeIds-refill scan, capacity check, BVH insert) on its
      // own -- up to 1792 blades/chunk (BLADES_PER_CELL=7 x GRID^2=256) means up to 1792
      // redundant re-entries. addInstances' onCreation callback already receives (instance, id)
      // directly, so the previous per-call `e.id` capture-and-store-back was unnecessary.
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
    // Fall back to a sampled ground height (not a hardcoded guess) when the chunk placed zero blades,
    // so an empty-but-still-registered cell's box still fronts the real local terrain.
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
    // must be bounded/terminating (an earlier unbounded spiral OOM'd the tab)
    const out = []
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dz) <= span) out.push([dx, dz])
    out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]))
    return out
  }
  let _spiral = null, _spiralSpan = -1
  // One in-flight chunk at a time, built incrementally under a per-frame wall-clock budget to avoid stalling the rAF (a lush chunk can take ~960ms if done in one frame).
  const LOAD_BUDGET = Number.isFinite(cfg.grassLoadBudgetMs) ? cfg.grassLoadBudgetMs : 4
  let _inflight = null  // { key, cursor }
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
        const ddx = cx * CH - px, ddz = cz * CH - pz
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
      const ddx = kx * CH - px, ddz = kz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) { unloadChunk(key); didDrop = true; break }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop && !_inflight
  }

  // Still-camera cull-freeze (ported from Vegetation.js, same rationale + same _streamMutated gap-fix):
  // autoUpdate=true (the @three.ez default) re-runs the library's own updateIndexArray() active+visibility
  // rebuild every frame regardless of whether the camera moved -- cheap now that perObjectFrustumCulled is
  // off (see the LOD block above), but still a real per-instance array pass worth gating. Also gates this
  // file's OWN manual chunk-frustum cull pass below (no point re-testing every chunk's AABB against an
  // unchanged frustum). Grass has no shadow pass to also gate (never casts shadows), so only
  // cameraStill+rotationStill need tracking here. Re-arm ONLY on real movement -- no periodic re-arm
  // (Vegetation.js's own history: a periodic re-arm caused visible tree flashing at hysteresis boundaries;
  // grass has no LOD hysteresis but the same principle -- nothing needs the freeze broken faster than the
  // player's own next move).
  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985
  const _cullQ = new THREE.Quaternion()

  // benders: optional array of nearby player/actor world positions to bend grass away from, e.g.
  // [{x,z}, ...] or [{position:[x,y,z]}, ...] (both player-state and THREE.Object3D shapes accepted,
  // same duck-typing as playerPos below) -- RenderGraph.nodes.js's foliage-lod-sync feeds this from
  // ctx.pm.playerMeshes (real per-player world positions, local + remote). Caller is responsible for
  // pre-filtering to the nearest MAX_BENDERS within range; this function does not sort/cap itself so
  // it stays cheap to call every frame with an already-small list.
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
    for (let i = n; i < MAX_BENDERS; i++) { arr[i * 2] = 1e6; arr[i * 2 + 1] = 1e6 }
    wind.uBenderCount.value = n
  }
  if (Number.isFinite(cfg.grassBendRadius)) wind.uGrassBendRadius.value = cfg.grassBendRadius
  if (Number.isFinite(cfg.grassBendStrength)) wind.uGrassBendStrength.value = cfg.grassBendStrength

  // Burn/flatten decal store: persistent world-state (see src/terrain/GrassDecal.js's header for why
  // this is architecturally distinct from the transient bender buffer above). Lives for the lifetime of
  // this createGrass() instance -- a world reload/dispose loses unpersisted decals same as any other
  // in-memory client render state; toJSON()/loadGrassDecal round-trip is available for a future
  // world-save wiring pass (out of this slice's scope). Regrowth (decal strength decaying back toward 0
  // over real wall-clock time) is built into the store itself (see GrassDecal.js) -- cfg.grassDecalHalfLifeS
  // overrides the default half-life, cfg.grassDecalRegrowth:false disables decay entirely (decals then
  // stay at full stamped strength forever, matching the old pre-regrowth behavior, e.g. for a
  // deliberately-permanent world feature like a lava scar) via a half-life so large no real play session
  // reaches even one half-life of decay (Number.MAX_VALUE itself would divide-by-effectively-infinity
  // fine in the decay exponent, but 1e12 seconds is already >30,000 years -- plenty inert without risking
  // float edge cases at true Infinity/MAX_VALUE in the pow() exponent).
  const decalHalfLifeS = (cfg.grassDecalRegrowth === false) ? 1e12 : (Number.isFinite(cfg.grassDecalHalfLifeS) && cfg.grassDecalHalfLifeS > 0 ? cfg.grassDecalHalfLifeS : undefined)
  const decalStore = createGrassDecal(null, { halfLifeS: decalHalfLifeS })
  let _decalVersion = -1   // last uDecalPosXZRS refresh's decalStore.version; refresh only on real change

  // Pushes the up-to-MAX_DECALS nearest decal stamps (within decalScanRadius of px,pz) into the
  // uDecalPosXZRS/uDecalCount uniforms. Cheap to call every frame: nearestStamps is O(stampCount) but
  // real stamp counts (explosion craters, tracks) are tiny compared to live actor counts, and this only
  // does real work when either the camera moved past the ring-scan granularity OR the store itself
  // changed (a fresh markScorched call) -- see the version-gate in update() below.
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

  // Public API: stamp a scorch/flatten decal at world (worldX,worldZ) -- explosion crater, vehicle
  // track, fire, etc. radius in metres, strength 0..1 (default 1 = fully scorched/flattened) peak at
  // center with cosine falloff to the edge (see GrassDecal.markScorched). Instant-apply + persistent:
  // affected blades shrink/re-tint on the NEXT update() call (no chunk rebuild needed, purely a
  // shader-uniform effect). Regrowth then decays the effect back toward 0 over real wall-clock time (see
  // GrassDecal.js, cfg.grassDecalHalfLifeS/grassDecalRegrowth) unless disabled -- the decal is never
  // "permanent until explicit clear" by default anymore, it fades on its own.
  function markScorched(worldX, worldZ, radius, strength) {
    const r = decalStore.markScorched(worldX, worldZ, radius, strength)
    _decalVersion = -1   // force uniform refresh on the very next update(), even if the camera hasn't moved
    return r
  }

  // Regrowth needs the decal uniform array to be periodically re-derived from decalStore's live decayed
  // strengths EVEN WHILE THE CAMERA IS COMPLETELY STILL -- the version-gate below only catches a discrete
  // mutation (markScorched, or a decay-driven PRUNE once a stamp crosses the near-zero cutoff), not the
  // smooth in-between decay a standing/AFK player should still visually see recovering. DECAL_REFRESH_MS
  // is deliberately coarse (regrowth plays out over minutes, not frames) so this adds negligible per-frame
  // cost even during a long idle/still period.
  const DECAL_REFRESH_MS = 2000
  let _lastDecalRefreshMs = -Infinity

  // tickWind(dt): see Vegetation.js's tickWind for the full rationale -- update() itself runs on
  // PlacementScheduler.js's ~25Hz throttle (correct for the expensive chunk-streaming scan below), but
  // wind.uGrassTime is a per-material GPU uniform that is essentially free to advance every real frame,
  // and only doing so on the same ~25Hz ticks produced visibly jerky/stepped blade sway.
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
      // streamRing can commitChunk (real addInstances) even while the camera sits still near a chunk
      // boundary or mid-incremental-build -- same instance-bucket gap Vegetation.js's _streamMutated
      // guards against: a frozen autoUpdate=false mesh never re-buckets newly added instances.
      _streamMutated = (!!_inflight !== _beforeInflight) || (loaded.size !== _beforeLoaded)
      wind.uCamPosXZ.value.set(px, pz)
      // Refresh the decal uniform array when something that could change its content actually happened:
      // the store mutated (a fresh markScorched, _decalVersion forced to -1), a decay-driven prune bumped
      // version, the camera moved enough for streamRing's own still-camera epsilon to register movement
      // (cameraStill false), OR the periodic regrowth refresh interval elapsed (smooth in-between decay,
      // which does NOT bump version, still needs to reach the uniforms on some cadence or a standing/AFK
      // player never visually sees regrowth progress) -- avoids an O(stampCount) nearestStamps scan every
      // single frame while standing still, while still keeping regrowth visible during long idle periods.
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
    // Chunk-granularity frustum cull: only re-tested when the camera actually moved/rotated (same
    // still-camera freeze gate as above -- a static camera's per-chunk in/out-of-frustum verdict cannot
    // change). Real per-chunk AABB (see commitChunk) vs THREE.Frustum.intersectsBox, O(loaded chunk
    // count) instead of O(instance count); toggles every blade in a chunk that crossed the frustum
    // boundary via the same setVisibilityAt applyOcclusion already uses (fail-open: an in-frustum chunk
    // stays visible-per-occlusion-state, never double-negated against the occluded flag).
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
        // Only touch instance visibility if the chunk isn't ALSO occlusion-hidden -- occlusion and
        // frustum culling are two independent hide-reasons over the same setVisibilityAt bit, so a
        // chunk that's occluded must stay invisible even while re-entering the frustum (applyOcclusion
        // will re-show it once occlusion itself clears, same fail-open contract as before).
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
  }

  function warmShaders(camera) { if (!camera) return 0; try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {} return 1 }

  // Same contract as Vegetation.js/Rocks.js getOcclusionCandidates/applyOcclusion -- grass is a candidate
  // to be culled, never an occluder (thin/transparent geometry). One box proxy per loaded chunk (not
  // per-blade, too many candidates for the query budget). Before this, grass had ZERO occlusion
  // registration and relied purely on the raw GPU z-test against the terrain depth-writeback, which
  // false-negatives (renders through hills) at steep/grazing view angles -- same defect class the shared
  // impostor billboard had before its BVH/occlusion fix.
  function getOcclusionCandidates() {
    if (_occCands) return _occCands
    const out = []
    for (const [key, cell] of loaded) {
      if (cell.pending) continue   // in-flight cursor build has no real extent yet; skip until commitChunk lands
      if (!cell._occProxy) {
        const root = new THREE.Object3D()
        // must have a real (unit-box) mesh child: OcclusionQueryTier's Box3.setFromObject walks geometry not transforms, so a bare Object3D yields an empty box and the candidate never queries
        const perProxyOccBoxGeo = _occBoxGeo.clone()
        const boxMesh = new THREE.Mesh(perProxyOccBoxGeo, _occBoxMat)
        boxMesh.visible = false
        boxMesh.raycast = () => {}
        root.add(boxMesh)
        // margin+lift: a box flush with the exact ground-anchored AABB false-occludes at steep downward
        // viewing angles / close range (mirrors Vegetation.js/Rocks.js/TerrainOcclusion.js's elevation-
        // envelope fix). aabbMin/aabbMax bracket the REAL placed-blade elevation extent (see commitChunk),
        // so LIFT only needs to cover half the box's own height (proportional) instead of a flat constant.
        const rawH = cell.aabbMax[1] - cell.aabbMin[1]
        const MARGIN = 2, LIFT = Math.max(1, rawH * 0.5)
        const size = [cell.aabbMax[0] - cell.aabbMin[0] + MARGIN * 2, rawH + MARGIN * 2, cell.aabbMax[2] - cell.aabbMin[2] + MARGIN * 2]
        root.position.set((cell.aabbMin[0] + cell.aabbMax[0]) / 2, (cell.aabbMin[1] + cell.aabbMax[1]) / 2 + LIFT, (cell.aabbMin[2] + cell.aabbMax[2]) / 2)
        root.scale.set(Math.max(size[0], 1e-3), Math.max(size[1], 1e-3), Math.max(size[2], 1e-3))
        root.updateMatrixWorld(true)
        cell._occProxy = { root, key }
      }
      // instanceCount refreshed every call so SceneOcclusion.js's shared anomaly guard can weight the
      // occluded-fraction check by real instance density, not raw chunk count (same fix as Vegetation.js/Rocks.js).
      cell._occProxy.instanceCount = cell.entries.length
      out.push(cell._occProxy)
    }
    _occCands = out
    return out
  }
  // fail-open by construction: a key absent from occludedKeys leaves entities at their last visible state.
  // Combines with the chunk-frustum cull above over the same setVisibilityAt bit: a chunk is only shown
  // when BOTH in-frustum AND not occluded (cell.inFrustum defaults true until the first update() cull pass runs).
  function applyOcclusion(occludedKeys) {
    for (const [key, cell] of loaded) {
      if (cell.pending) continue
      const shouldHide = occludedKeys.has(key)
      if (shouldHide === cell.occluded) continue
      cell.occluded = shouldHide
      if (!cell.inFrustum) continue   // frustum-culled already hides these; don't fight that state
      const mesh = cell.mesh || im
      for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, !shouldHide) } catch (_) {} }
    }
  }

  function dispose() {
    try { scene.remove(im); scene.remove(imMid) } catch (e) { _dbgGrass('scene.remove failed on dispose:', e?.message || e) }
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
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(cx + ',' + cz)) continue
      loadChunk(cx, cz, px, pz); n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  // Same rebuild-everything discipline as Vegetation.js/Rocks.js's rebuildPlacement: drop any in-flight
  // incremental chunk build FIRST (it was cursoring the pre-repaint anchorField and its placeholder
  // `{entries:[],pending:true}` loaded-map entry would otherwise survive the sweep below with nothing to
  // unload), then unload every committed chunk and reset the streamRing scan-cache so the next update()
  // re-visits every currently-in-range chunk fresh through the now-repainted anchorField.
  function rebuildPlacement() { _inflight = null; for (const key of [...loaded.keys()]) unloadChunk(key); _ringClean = false; _scanCx = NaN; _scanCz = NaN }
  // Applies an authoritative paint-biome stroke (see the matching Vegetation.js repaintBiome) to this
  // client's own override layer, then rebuilds placement so visible blade density/tint genuinely changes.
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, tickWind, prewarm, warmShaders, dispose, _im: im, _imMid: imMid, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, setBenders, get benderCount() { return wind.uBenderCount.value }, get benderPosXZ() { return wind.uBenderPosXZ.value }, markScorched, decalStore, get decalCount() { return wind.uDecalCount.value }, get decalPosXZRS() { return wind.uDecalPosXZRS.value }, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__grass = api
  return api
}
