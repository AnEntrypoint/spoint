// Dense near-only instanced ground grass: two InstancedMesh2 tiers of crossed tapered blades (near
// full-curve geometry, mid flat-quad geometry, assigned per-chunk by distance -- see createGrass's LOD
// block), GPU wind sway, chunk-streamed within a short ring, chunk-granularity manual frustum culling
// (perObjectFrustumCulled off, no per-blade BVH). Visual-only, no collider. window.__grass / window.__grassProfile.
// Two independent per-blade shader-uniform effects on top of placement: player/actor BEND (transient,
// see MAX_BENDERS below) and burn/flatten DECALS (persistent world-state, api.markScorched, backed by
// src/terrain/GrassDecal.js -- see MAX_DECALS below).
import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createGrassChunkCursor, GRASS } from '/src/terrain/GrassPlacement.js'
import { createCachedAnchorField } from '/src/terrain/ClimateCache.js'
import { createBiomeOverride } from '/src/terrain/BiomeOverride.js'
import { createModelExclusionField } from '/src/terrain/ModelExclusionField.js'
import { createGrassDecal } from '/src/terrain/GrassDecal.js'
import { dbg } from './debug-log.js'
import { MAX_BENDERS, MAX_DECALS, makeBladeGeo, makeWind, makeGrassMaterial } from './GrassMaterial.js'
import { spiralOffsets, chunkKey, resolveCameraPose } from './PlacementScheduler.js'
import { createOcclusionSuperCells } from './OcclusionPolicy.js'
import { installInstancedMesh2Perf } from './VegetationBuild.js'

// Re-exported from GrassMaterial.js for backward compatibility (RenderGraph.nodes.js references
// Grass.MAX_BENDERS in its own comments; no current importer reaches these, kept for API stability).
export { MAX_BENDERS, MAX_DECALS }

const _dbgGrass = dbg('grass')

const DROP_MARGIN = 16
const _v = new THREE.Vector3(), _q = new THREE.Quaternion()
const _now = (typeof performance !== 'undefined') ? () => performance.now() : () => Date.now()
// ONE debug gate for every window.__grass* live knob -- see Vegetation.js's _dbgOn (window.__sceneryDebug = true).
const _dbgOn = (typeof window !== 'undefined') ? () => window.__sceneryDebug === true : () => false

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
  installInstancedMesh2Perf()

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
  // beyond `ringRadius` and the vertex shader ring-fades blade scale to zero approaching that edge
  // (uGrassRing) -- a chunk-streamed system's "far tier" IS the unload boundary.
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
    // already tracked per-chunk (see commitChunk's aabbMin/aabbMax). At 40k blades, per-instance BVH/
    // linear frustum culling every frame is pure CPU overhead once the GPU has headroom to just
    // draw+depth-discard off-screen blades -- so perObjectFrustumCulled stays OFF (frustumCulling() takes
    // the cheap updateIndexArray() path: active+visibility bits only, confirmed in @three.ez's
    // FrustumCulling.js). Per-CHUNK visibility is instead driven in updateVisibility() by testing each
    // loaded chunk's real AABB against the camera frustum and toggling every blade in an off-frustum
    // chunk invisible via the same setVisibilityAt applyOcclusion uses.
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

  const CH = GRASS.CHUNK
  const loaded = new Map()   // chunkKey(cx,cz) -> { key, cx, cz, entries, mesh, aabbMin, aabbMax, occluded, inFrustum }
  // 128m super-cell occlusion candidates -- see OcclusionPolicy.createOcclusionSuperCells. Grass is a candidate to be culled, never an occluder (thin geometry).
  const occ = createOcclusionSuperCells({ prefix: 'g', cellsPerSide: 4, margin: 2, liftMin: 1, countOf: c => c.entries.length })
  let totalInstances = 0
  const profile = { totalInstances: 0, loads: 0, unloads: 0, updateMs: 0, grassDrawCalls: 2, ringScans: 0, cullMs: 0, chunksCulled: 0, commitSlices: 0, loadMsMax: 0, loadMsTotal: 0 }
  if (typeof window !== 'undefined') window.__grassProfile = profile   // stable object: mirror once
  const _frustum = new THREE.Frustum(), _projMat = new THREE.Matrix4(), _cullBox = new THREE.Box3()

  // LOD-tier pick: PER-CHUNK, not per-blade -- a chunk is 32m across (GRASS.CHUNK) vs a 44m default
  // render distance, so per-blade tier assignment inside one chunk would barely matter while doubling
  // the addInstances bookkeeping; the whole chunk goes to whichever tier its CENTER falls into at
  // commit time, using the player position captured when the chunk's build started (an out-of-band call
  // with no position is treated as near-tier -- conservative: more detail, never less).
  function _tierFor(cx, cz, px, pz) {
    const centerX = cx * CH + CH * 0.5, centerZ = cz * CH + CH * 0.5
    let useMid = false
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const ddx = centerX - px, ddz = centerZ - pz
      useMid = (ddx * ddx + ddz * ddz) > LOD_NEAR_DIST * LOD_NEAR_DIST
    }
    return useMid ? imMid : im
  }

  // A chunk build is a small state machine driven under one per-tick wall-clock budget:
  //   place  -> the GrassPlacement cursor classifies cells (bit-identical, ordered output)
  //   commit -> the blade list is pushed into the InstancedMesh2 in SLICES (addInstances + the three
  //             per-blade uniforms as ONE texture row write each), so a lush ~1800-blade chunk never
  //             lands as a single burst in one tick; ids come out identical to one big addInstances call
  //             (@three.ez consumes freeIds from the end then fresh ids, in both cases in blade order).
  // The chunk is registered (occlusion candidate, frustum cull, unload) only once fully committed.
  const COMMIT_SLICE = 96
  function _beginCommit(job) {
    const list = job.cursor.blades
    job.list = list
    job.batch = Math.min(list.length, MAX_INSTANCES - totalInstances)
    job.mesh = _tierFor(job.cx, job.cz, job.px, job.pz)
    job.ci = 0
    job.entries = []
    job.minY = Infinity; job.maxY = -Infinity
    job.phase = 'commit'
  }
  function _commitSlice(job, deadline) {
    const list = job.list, mesh = job.mesh, ut = mesh.uniformsTexture
    while (job.ci < job.batch) {
      const n = Math.min(COMMIT_SLICE, job.batch - job.ci)
      let k = job.ci
      const startCi = job.ci
      mesh.addInstances(n, (e, id) => {
        const p = list[k++]
        e.position.set(p.x, p.y, p.z)
        _q.setFromAxisAngle(_v.set(0, 1, 0), p.yaw)
        e.quaternion.copy(_q)
        e.scale.set(1, p.scale, 1)
        job.entries.push({ id, windPhase: p.windPhase, tint: p.tint, shadow: Number.isFinite(p.shadow) ? p.shadow : 1 })
        if (p.y < job.minY) job.minY = p.y
        if (p.y + p.scale > job.maxY) job.maxY = p.y + p.scale
      })
      for (let i = startCi; i < startCi + n; i++) {
        const en = job.entries[i]
        try { ut.setUniformAt(en.id, 'windPhase', en.windPhase); ut.setUniformAt(en.id, 'tint', en.tint); ut.setUniformAt(en.id, 'instShadow', en.shadow); ut.enqueueUpdate(en.id) } catch (_) {}
      }
      job.ci += n
      totalInstances += n
      profile.commitSlices++
      _mutated = true
      if (_now() >= deadline) return false
    }
    return true
  }
  function _finalize(job) {
    const cx = job.cx, cz = job.cz
    let _minY = job.minY, _maxY = job.maxY
    // Fall back to a sampled ground height (not a hardcoded guess) when the chunk placed zero blades,
    // so an empty-but-still-registered cell's box still fronts the real local terrain.
    if (_minY === Infinity) {
      let gh = 0
      try { gh = frame.groundHeightLocal(cx * CH + CH * 0.5, cz * CH + CH * 0.5) } catch (_) {}
      if (!Number.isFinite(gh)) gh = 0
      _minY = gh - 1; _maxY = gh + 1
    }
    const cell = { key: job.key, cx, cz, entries: job.entries, mesh: job.mesh, aabbMin: [cx * CH, _minY, cz * CH], aabbMax: [(cx + 1) * CH, _maxY, (cz + 1) * CH], occluded: false, inFrustum: true }
    loaded.set(job.key, cell)
    occ.add(job.key, cx, cz, cell)
    profile.loads++
    const ms = _now() - job.t0
    profile.loadMsTotal += ms; if (ms > profile.loadMsMax) profile.loadMsMax = ms
    _mutated = true
  }
  function _newJob(cx, cz, px, pz) {
    return { key: chunkKey(cx, cz), cx, cz, cursor: createGrassChunkCursor(cx, cz, frame, anchorField, worldSeed), px, pz, phase: 'place', t0: _now() }
  }
  // Runs a job until the deadline; returns true when the chunk is fully committed + registered.
  function _runJob(job, deadline) {
    if (job.phase === 'place') {
      if (!job.cursor.step(Math.max(0, deadline - _now()))) return false
      _beginCommit(job)
    }
    if (!_commitSlice(job, deadline)) return false
    _finalize(job)
    return true
  }

  // Synchronous full load (prewarm): completes an in-flight job for this chunk, else a fresh one.
  function loadChunk(cx, cz, px, pz) {
    const key = chunkKey(cx, cz)
    if (loaded.has(key)) return
    let job
    if (_inflight && _inflight.key === key) { job = _inflight; _inflight = null }
    else job = _newJob(cx, cz, px, pz)
    _runJob(job, Infinity)
  }

  function unloadChunk(cell) {
    if (!loaded.has(cell.key)) return
    const mesh = cell.mesh || im
    // ONE variadic removeInstances per chunk (its trailing array-count trim runs once, not once per blade)
    if (cell.entries.length) {
      const ids = new Array(cell.entries.length)
      for (let i = 0; i < ids.length; i++) ids[i] = cell.entries[i].id
      try { mesh.removeInstances(...ids); totalInstances -= ids.length } catch (_) {}
    }
    loaded.delete(cell.key); occ.remove(cell.key); profile.unloads++
    _mutated = true
  }

  let _ringClean = false, _scanCx = NaN, _scanCz = NaN
  let _spiral = null, _spiralSpan = -1
  // One in-flight chunk at a time, built incrementally under a per-tick wall-clock budget to avoid stalling the rAF (a lush chunk can take ~960ms if done in one frame).
  const LOAD_BUDGET = Number.isFinite(cfg.grassLoadBudgetMs) ? cfg.grassLoadBudgetMs : 4
  let _inflight = null  // job (see _newJob)
  function streamRing(px, pz) {
    const deadline = _now() + LOAD_BUDGET
    if (_inflight) {
      if (!_runJob(_inflight, deadline)) { _ringClean = false; return }
      _inflight = null
    }
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    if (_ringClean && cCx === _scanCx && cCz === _scanCz) return
    profile.ringScans++
    const span = Math.ceil(ringRadius / CH)
    if (span !== _spiralSpan) { _spiral = spiralOffsets(span); _spiralSpan = span }
    let didLoad = false, didDrop = false
    if (totalInstances < MAX_INSTANCES) {
      for (const [dx, dz] of _spiral) {
        const cx = cCx + dx, cz = cCz + dz
        const key = chunkKey(cx, cz)
        const ddx = cx * CH - px, ddz = cz * CH - pz
        if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(key)) continue
        const job = _newJob(cx, cz, px, pz)
        if (!_runJob(job, deadline)) _inflight = job
        didLoad = true; break
      }
    }
    for (const cell of loaded.values()) {
      const ddx = cell.cx * CH - px, ddz = cell.cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > dropRadiusSq) { unloadChunk(cell); didDrop = true; break }
    }
    _scanCx = cCx; _scanCz = cCz; _ringClean = !didLoad && !didDrop && !_inflight
  }

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
  // this createGrass() instance. Regrowth (decal strength decaying back toward 0 over real wall-clock
  // time) is built into the store itself -- cfg.grassDecalHalfLifeS overrides the default half-life,
  // cfg.grassDecalRegrowth:false disables decay entirely via a half-life so large no real play session
  // reaches even one half-life (1e12 s is >30,000 years -- inert without float edge cases at Infinity).
  const decalHalfLifeS = (cfg.grassDecalRegrowth === false) ? 1e12 : (Number.isFinite(cfg.grassDecalHalfLifeS) && cfg.grassDecalHalfLifeS > 0 ? cfg.grassDecalHalfLifeS : undefined)
  const decalStore = createGrassDecal(null, { halfLifeS: decalHalfLifeS })
  let _decalVersion = -1   // last uDecalPosXZRS refresh's decalStore.version; refresh only on real change

  // Pushes the up-to-MAX_DECALS nearest decal stamps (within decalScanRadius of px,pz) into the
  // uDecalPosXZRS/uDecalCount uniforms. Only does real work when the camera moved past the ring-scan
  // granularity OR the store itself changed -- see the version-gate in updateStreaming() below.
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
  // affected blades shrink/re-tint on the NEXT update (no chunk rebuild needed, purely a shader-uniform
  // effect). Regrowth then decays the effect back toward 0 over real wall-clock time unless disabled.
  function markScorched(worldX, worldZ, radius, strength) {
    const r = decalStore.markScorched(worldX, worldZ, radius, strength)
    _decalVersion = -1   // force uniform refresh on the very next update, even if the camera hasn't moved
    return r
  }

  // Regrowth needs the decal uniform array to be periodically re-derived from decalStore's live decayed
  // strengths EVEN WHILE THE CAMERA IS COMPLETELY STILL -- the version-gate below only catches a discrete
  // mutation, not the smooth in-between decay a standing/AFK player should still visually see recovering.
  // DECAL_REFRESH_MS is deliberately coarse (regrowth plays out over minutes, not frames).
  const DECAL_REFRESH_MS = 2000
  let _lastDecalRefreshMs = -Infinity

  // tickWind(dt): see Vegetation.js's tickWind for the full rationale -- streaming runs on
  // PlacementScheduler.js's ~25Hz throttle, but wind.uGrassTime is a per-material GPU uniform that is
  // essentially free to advance every real frame, and 25Hz sway was visibly stepped.
  function tickWind(dt) {
    wind.uGrassTime.value += dt
    if (_dbgOn() && window.__grassWind != null) wind.uGrassWind.value = +window.__grassWind
  }

  let _mutated = false
  const _ownPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  let _lastSx = NaN, _lastSz = NaN

  // updateStreaming(dt, camera, playerPos, benders, pose): the ~25Hz half -- chunk build/eviction under
  // budget, bender + decal uniform maintenance, profile.
  function updateStreaming(dt, camera, playerPos, benders, pose) {
    const t0 = _now()
    if (_dbgOn() && window.__grassBend === false) setBenders(null)
    else setBenders(benders)
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    else if (pose) { px = pose.x; pz = pose.z }
    else if (camera) { resolveCameraPose(camera, _ownPose); px = _ownPose.x; pz = _ownPose.z }
    if (Number.isFinite(px) && Number.isFinite(pz)) {
      const mdx = px - _lastSx, mdz = pz - _lastSz
      const cameraStill = Number.isFinite(mdx) && (mdx * mdx + mdz * mdz) < 0.05 * 0.05
      _lastSx = px; _lastSz = pz
      streamRing(px, pz)
      wind.uCamPosXZ.value.set(px, pz)
      // Refresh the decal uniform array when something that could change its content actually happened:
      // the store mutated (a fresh markScorched / decay-driven prune bumped version), the focus moved,
      // OR the periodic regrowth refresh interval elapsed -- avoids an O(stampCount) nearestStamps scan
      // every tick while standing still, while still keeping regrowth visible during long idle periods.
      const decalOff = _dbgOn() && window.__grassDecal === false
      const nowMs = t0
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
    profile.loadedChunks = loaded.size
    profile.occSuperCells = occ.superCount
    profile.occHiddenSuperCells = occ.hiddenCount
    profile.updateMs = _now() - t0
  }

  // updateVisibility(camera, pose): the every-frame half.
  // Still-camera cull-freeze (same rationale as Vegetation.js): autoUpdate=true re-runs the library's
  // updateIndexArray() active+visibility rebuild every frame regardless of whether the camera moved --
  // cheap with perObjectFrustumCulled off, but still a real per-instance array pass worth gating. Also
  // gates this file's OWN manual chunk-frustum cull below. Re-arm ONLY on real movement or a streaming
  // mutation (a frozen mesh never re-buckets newly added instances) -- no periodic re-arm.
  // Chunk-granularity frustum cull: real per-chunk AABB vs THREE.Frustum.intersectsBox, O(loaded chunk
  // count) instead of O(instance count); toggles every blade in a chunk that CROSSED the frustum boundary
  // via the same setVisibilityAt applyOcclusion uses (fail-open: an in-frustum chunk stays at its
  // occlusion-state visibility, never double-negated against the occluded flag).
  let _cullFrozen = false
  let _lastPx = NaN, _lastPz = NaN, _idleFrames = 0
  const IDLE_EPS = 0.05
  let _lastQx = NaN, _lastQy = NaN, _lastQz = NaN, _lastQw = NaN
  const ROT_COS_EPS = 0.999985
  function updateVisibility(camera, pose) {
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
    const wantFrozen = cameraStill && rotationStill && _idleFrames > 0 && !_mutated
    const mutated = _mutated
    _mutated = false
    if (wantFrozen !== _cullFrozen) {
      _cullFrozen = wantFrozen
      im.autoUpdate = !wantFrozen; imMid.autoUpdate = !wantFrozen
      profile.cullFrozen = wantFrozen
    }
    if ((!wantFrozen || mutated) && camera) {
      const tc0 = _now()
      _projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projMat)
      let culledCount = 0
      for (const cell of loaded.values()) {
        _cullBox.min.set(cell.aabbMin[0], cell.aabbMin[1], cell.aabbMin[2])
        _cullBox.max.set(cell.aabbMax[0], cell.aabbMax[1], cell.aabbMax[2])
        const inFrustum = _frustum.intersectsBox(_cullBox)
        if (inFrustum === cell.inFrustum) { if (!inFrustum) culledCount++; continue }
        cell.inFrustum = inFrustum
        if (!inFrustum) culledCount++
        // Only touch instance visibility if the chunk isn't ALSO occlusion-hidden -- occlusion and
        // frustum culling are two independent hide-reasons over the same setVisibilityAt bit.
        if (cell.occluded) continue
        const mesh = cell.mesh || im
        for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, inFrustum) } catch (_) {} }
      }
      profile.chunksCulled = culledCount
      profile.cullMs = _now() - tc0
    }
  }

  function update(dt, camera, playerPos, benders, pose) {
    updateStreaming(dt, camera, playerPos, benders, pose)
    updateVisibility(camera, pose)
  }

  function warmShaders(camera) { if (!camera) return 0; try { renderer.render(scene, camera); renderer.render(scene, camera) } catch (_) {} return 1 }

  function getOcclusionCandidates() { return occ.candidates() }
  // Delta-applied per flipped super-cell (see createOcclusionSuperCells). Combines with the chunk-frustum
  // cull over the same setVisibilityAt bit: a chunk is shown only when BOTH in-frustum AND not occluded.
  function _setCellHidden(cell, hide) {
    if (cell.occluded === hide) return
    cell.occluded = hide
    if (!cell.inFrustum) return   // frustum-culled already hides these; don't fight that state
    const mesh = cell.mesh || im
    for (const en of cell.entries) { try { mesh.setVisibilityAt(en.id, !hide) } catch (_) {} }
  }
  function applyOcclusion(occludedKeys) { occ.applyOcclusion(occludedKeys, _setCellHidden) }

  function dispose() {
    try { scene.remove(im); scene.remove(imMid) } catch (e) { _dbgGrass('scene.remove failed on dispose:', e?.message || e) }
    try { geoNear.dispose(); geoMid.dispose(); mat.dispose(); im.dispose && im.dispose(); imMid.dispose && imMid.dispose() } catch (e) { _dbgGrass('geo/mat/im dispose failed:', e?.message || e) }
    loaded.clear(); occ.clear(); totalInstances = 0; _inflight = null
    if (typeof window !== 'undefined' && window.__grass && window.__grass._im === im) delete window.__grass
  }

  const _yieldFrame = () => new Promise(r => (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(() => r()) : setTimeout(r, 0))
  async function prewarm(px, pz, budgetMs = 60000) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 0
    const t0 = _now()
    const cCx = Math.round(px / CH), cCz = Math.round(pz / CH)
    const span = Math.ceil(ringRadius / CH)
    if (span !== _spiralSpan) { _spiral = spiralOffsets(span); _spiralSpan = span }
    let n = 0
    for (const [dx, dz] of _spiral) {
      if (totalInstances >= MAX_INSTANCES) break
      if (_now() - t0 > budgetMs) break
      const cx = cCx + dx, cz = cCz + dz
      const ddx = cx * CH - px, ddz = cz * CH - pz
      if ((ddx * ddx + ddz * ddz) > ringRadiusSq || loaded.has(chunkKey(cx, cz))) continue
      loadChunk(cx, cz, px, pz); n++
      if (n % 8 === 0) await _yieldFrame()
    }
    return n
  }

  // Same rebuild-everything discipline as Vegetation.js/Rocks.js's rebuildPlacement: drop any in-flight
  // incremental chunk build FIRST (it was cursoring the pre-repaint anchorField; a partially committed
  // slice is removed from its mesh so no orphan blades survive), then unload every committed chunk and
  // reset the streamRing scan-cache so the next update re-visits every in-range chunk fresh.
  function rebuildPlacement() {
    if (_inflight) {
      const job = _inflight; _inflight = null
      if (job.entries && job.entries.length) { try { job.mesh.removeInstances(...job.entries.map(e => e.id)); totalInstances -= job.entries.length } catch (_) {} }
    }
    for (const cell of [...loaded.values()]) unloadChunk(cell)
    _ringClean = false; _scanCx = NaN; _scanCz = NaN
  }
  // Applies an authoritative paint-biome stroke (see the matching Vegetation.js repaintBiome) to this
  // client's own override layer, then rebuilds placement so visible blade density/tint genuinely changes.
  function repaintBiome(x, z, radius, target, strength) { biomeOverride.applyPaintBrush(x, z, radius, target, strength); rebuildPlacement() }

  const api = { update, updateStreaming, updateVisibility, tickWind, prewarm, warmShaders, dispose, _im: im, _imMid: imMid, get totalInstances() { return totalInstances }, get profile() { return profile }, rebuildPlacement, repaintBiome, biomeOverride, getOcclusionCandidates, applyOcclusion, setBenders, get benderCount() { return wind.uBenderCount.value }, get benderPosXZ() { return wind.uBenderPosXZ.value }, markScorched, decalStore, get decalCount() { return wind.uDecalCount.value }, get decalPosXZRS() { return wind.uDecalPosXZRS.value }, cfg, renderDistance }
  if (typeof window !== 'undefined') window.__grass = api
  return api
}
