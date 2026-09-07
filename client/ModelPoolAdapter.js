import { ModelPool } from 'streaming-gltf/model-pool'
import * as THREE from 'three'

const _debugBox = new THREE.Box3()
const _debugSize = new THREE.Vector3()
const _debugCenter = new THREE.Vector3()

export function progressiveUrl(modelUrl) {
  return modelUrl + '.prog/model.progressive.glb'
}

// Draws every cluster (no per-cluster frustum cull): the baked bounding-sphere cull false-culls thin flat slabs (floor/wall panels) at close range.
function _disableClusterCull(root) {
  if (!root || typeof root.traverse !== 'function') return
  root.traverse(o => {
    if (!o || !o.clusterSet || !o.clusterSet.clusters || o._spointCullDisabled) return
    o._spointNoClusterCull = true
    o._spointCullDisabled = true
  })
}

// vramBudgetMB / deviceInfo (both optional, 3rd param) feed the model-pool's own VRAM budget tracker
// (packages/streaming-gltf/src/model-pool.js -- byteBudget + LodUnloadManager, already fully wired to
// per-frame eviction; this adapter's job is only to make it CLIENT-configurable/discoverable, which it
// was not before -- see half-res-transparents-temporal-upscale-texture-vram-budget PRD row). deviceInfo
// is the exact shape client/core/MobileControls.js's detectDevice() returns; when passed, it replaces
// model-pool's own cruder UA-substring VRAM-size guess with a real WEBGL_debug_renderer_info-derived tier.
export function createModelPool(scene, renderer, camera, { vramBudgetMB, deviceInfo } = {}) {
  // useGlobalMaterialPool disabled: it collapses per-mesh textures onto one shared tier material, but spoint models are individually textured.
  // workerCount:2, not the cpu-scaled default: fewer workers frees network bandwidth for the critical env fetch during cold boot.
  // useImpostorFinalLod: below impostorPx on-screen, draw the whole entity as one octahedral-impostor
  // billboard instead of real geometry -- the generalized baker (packages/streaming-gltf/src/
  // octahedral-impostor-ez-tier.js) is model-agnostic (shares the lit MRT baker Vegetation.js already
  // uses for trees). This is the sole impostor tier as of
  // draw-call-audit-impostor-array-tier-deprecation-decision: a sibling unlit
  // sampler2DArray tier (octahedral-impostor.js/octahedral-impostor-tier.js,
  // selected via a since-removed useImpostorEz:false) was deleted after an
  // audit found it unreachable on every real serving path -- this adapter was
  // its only real (hardcoded true) caller, so the false branch was pure dead
  // code with no device-tier gating ever wired to reach it.
  // useBatchedFarTier: collapse every distinct far-tier asset's draw into ~1 real THREE.BatchedMesh
  // call instead of one InstancedMesh per asset -- live-measured this session at real WebGL2 scale
  // (300/3000/30000 instances of genuinely distinct geometries): draw calls collapse to 1 at every
  // scale with byte-identical triangle counts vs the unbatched baseline (proves full geometry draws,
  // not a degenerate subset). Was gated off pending exactly this kind of at-scale witness.
  // useMaterialBucketBatching: the runtime consumer for material-convergence.js's bake-time output
  // (packages/streaming-gltf/src/material-bucket-batcher.js) -- cluster-LOD entities whose baked
  // EP_cluster_lod.materialBucket hash matches EXACTLY (proven rendering-identical) share ONE real
  // THREE.BatchedMesh draw call at their coarsest cluster LOD once beyond materialBucketPx. This was
  // previously wired end-to-end in model-pool.js but never enabled from the client (dead code in
  // production) AND had a real bug found+fixed this session: a ClusterLodMesh's .material can be a
  // single-element ARRAY (GLTFLoader convention), which THREE.BatchedMesh silently accepts but can
  // never actually draw (its own geometry.groups stays empty, so WebGLRenderer's projectObject's
  // array-material render-list-push loop never runs -- zero draw calls, zero errors anywhere). Fixed
  // in material-bucket-batcher.js (_bucketFor unwraps seedMaterial[0]). Live-witnessed end-to-end
  // through the real Entity._updateMaterialBucketTier path (not a bypass): 40 far-placed entities of
  // a converged single-material asset, real renderer.info.render.calls 229 (off) -> 1 (on), byte-
  // identical instance count (40) confirmed via pool.getStats().materialBucketInstances.
  const pool = new ModelPool({ scene, renderer, camera, useGlobalMaterialPool: false, workerCount: 2, useOcclusionQuery: true, occlusionMinCandidates: 32, useImpostorFinalLod: true, impostorPx: 14, impostorTextureSize: 1024, impostorMaxAssets: 64, useBatchedFarTier: true, useMaterialBucketBatching: true, textureArrayAtlas: true, vramBudgetMB, deviceInfo })
  // ceilingLod=null removes the startup LOD cap so LOD0 is reachable at close range; the VRAM ratchet can still clamp down under memory pressure.
  try { pool.ceilingLod = null } catch (_) {}

  // VRAM budget event log: a small ring buffer of the pool's own real budget events (vram-warning,
  // vram-critical, budget-pressure, budget-relaxed, budget-adjust reason:'over-budget') so a debug
  // surface / HUD can show recent pressure history, not just an instantaneous ratio. Real events only --
  // no synthetic/periodic entries.
  const VRAM_LOG_CAP = 40
  const _vramLog = []
  function _logVramEvent(type, payload) {
    _vramLog.push({ type, t: Date.now(), ...payload })
    if (_vramLog.length > VRAM_LOG_CAP) _vramLog.shift()
  }
  if (pool.on) {
    pool.on('vram-warning', (p) => _logVramEvent('vram-warning', p))
    pool.on('vram-critical', (p) => _logVramEvent('vram-critical', p))
    pool.on('budget-pressure', (p) => _logVramEvent('budget-pressure', p))
    pool.on('budget-relaxed', (p) => _logVramEvent('budget-relaxed', p))
    pool.on('budget-adjust', (p) => { if (p && p.reason === 'over-budget') _logVramEvent('budget-adjust', p) })
  }
  function getVramLog() { return _vramLog.slice() }

  // Live budget override -- forwards to ModelPool.setVramBudgetMB (updates both pool.byteBudget and the
  // unload manager's mirrored copy in one call, see that method's own comment for why both exist).
  function setVramBudgetMB(mb) { return pool.setVramBudgetMB ? pool.setVramBudgetMB(mb) : null }

  const _entities = new Map()
  // A model routes through ModelPool only if its progressive (baked) asset exists; non-bakeable models stay on the legacy path.
  const _progReady = new Map()

  async function progressiveReady(modelUrl) {
    if (_progReady.has(modelUrl)) return _progReady.get(modelUrl)
    let ready = false
    const url = progressiveUrl(modelUrl)
    try {
      // HEAD not GET: ModelPool.spawn() re-fetches the root anyway, so a GET here would double-download.
      let r = await fetch(url, { method: 'HEAD' })
      if ((r.status === 405 || r.status === 501)) r = await fetch(url, { method: 'GET' })
      // GitHub Pages' static host intermittently 503s a bare HEAD probe while the same URL's GET
      // succeeds immediately after (witnessed live: HEAD 503 -> GET 200 on aim_sillos.glb.prog and
      // cleetus.vrm) -- a transient edge/CDN hiccup, not a real 404. One retry absorbs it instead of
      // wrongly routing an existing progressive asset onto the slower legacy path for this session.
      if (r.status >= 500) r = await fetch(url, { method: 'HEAD' })
      ready = r.ok
    } catch (_) { ready = false }
    // Only cache positives: a 404 may just mean still-baking, so re-probe next time.
    if (ready) _progReady.set(modelUrl, true)
    return ready
  }

  // Shared spawn lifecycle for a pool handle: apply spoint's quaternion+per-axis transform directly
  // (ModelPool's opts.rotation/scale are Euler/uniform-scalar, wrong for us), add the proxy root to
  // the scene now (ModelPool doesn't auto-add), hide until compiled, register the entity, and re-apply
  // + re-add on the ready-swap. readyHook runs on the real root; readyArg2 is the onReady 2nd arg.
  function _spawnPooled(entityId, handle, { position, rotation, scale } = {}, onReady, { readyHook, readyArg2 } = {}) {
    const applyTransform = (root) => {
      if (!root) return
      if (position) root.position.fromArray(position)
      if (rotation) root.quaternion.fromArray(rotation)   // quaternion [x,y,z,w]
      if (scale) root.scale.fromArray(scale)
    }
    applyTransform(handle.root)
    if (handle.root && handle.root.parent !== scene) scene.add(handle.root)
    _hideUntilCompiled(handle)
    _entities.set(entityId, { handle, root: handle.root })
    handle.on('ready', (e) => {
      const r = _entities.get(entityId)
      if (r) r.root = handle.root
      applyTransform(handle.root)
      if (handle.root && handle.root.parent !== scene) scene.add(handle.root)
      if (readyHook) readyHook(handle.root)
      if (onReady) onReady(handle.root, readyArg2 ? readyArg2(handle, e) : e)
    })
    return _entities.get(entityId)
  }

  function spawn(entityId, modelUrl, transform = {}, onReady) {
    const handle = pool.spawn(progressiveUrl(modelUrl), {})
    return _spawnPooled(entityId, handle, transform, onReady, { readyHook: _disableClusterCull })
  }

  // Hides a just-spawned root until app.js's compile gate clears it, or the frame stalls mid shader-link (ANGLE/D3D11). Timeout is the fail-safe.
  function _hideUntilCompiled(handle) {
    const r0 = handle.root
    if (!r0) return
    r0.visible = false
    r0.userData._compileHidden = true
    setTimeout(() => {
      for (const r of [r0, handle.root]) {
        if (r && r.userData._compileHidden) { r.userData._compileHidden = false; r.visible = true }
      }
    }, 8000)
  }

  // Spawns the raw VRM directly (not progressive-baked: baking risks stripping VRMC_vrm humanoid/spring data). driveVrm:false avoids double-driving vrm.update against spoint's own animator.
  function spawnVRM(entityId, vrmUrl, transform = {}, onReady) {
    const handle = pool.spawn(vrmUrl, { driveVrm: false })
    // VRM has no cluster-LOD (no readyHook), and reports its resolved entity as the onReady 2nd arg.
    return _spawnPooled(entityId, handle, transform, onReady, { readyArg2: (h) => h.actualEntity })
  }

  function remove(entityId) {
    const rec = _entities.get(entityId)
    if (!rec) return
    try { rec.handle?.dispose() } catch (_) {}
    _entities.delete(entityId)
  }

  function setTarget(entityId, x, y, z, durationMs = 300) {
    const rec = _entities.get(entityId)
    const ent = rec?.handle?.actualEntity
    if (ent) pool.setTarget(ent, x, y, z, durationMs)
  }

  // pool.setTarget only moves position, so rotation must be pushed separately or a pool-routed body never turns.
  function setRotation(entityId, qx, qy, qz, qw) {
    if (!(Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz) && Number.isFinite(qw))) return
    const rec = _entities.get(entityId)
    const ent = rec?.handle?.actualEntity
    if (ent && pool.setRotation) pool.setRotation(ent, qx, qy, qz, qw)
  }

  function update() { pool.update() }
  // Must run AFTER renderer.render() so occlusion queries read this frame's real depth buffer.
  function runOcclusionQueries() { pool.runOcclusionQueries?.() }

  // cull-shared-query-budget: ModelPool's occlusion tier is a THIRD independent
  // streaming-gltf OcclusionQueryTier instance (constructed inside packages/streaming-gltf's
  // model-pool.js, not this file) -- its maxQueriesPerFrame is a plain mutable instance property on
  // that tier object (occlusion-query-tier.js: this.maxQueriesPerFrame = opts.maxQueriesPerFrame ??
  // 32), so the shared budget arbiter can throttle it live from here without any vendored-source
  // edit. pool._occlusionTier may not exist yet (lazy-created on first runOcclusionQueries() call
  // once enough candidates accumulate, or absent entirely if WebGL2 occlusion queries aren't
  // supported) -- silently no-op until it appears, matching the tier's own fail-open philosophy.
  function setOcclusionQueryBudget(n) {
    if (!Number.isFinite(n) || n < 0) return
    const tier = pool._occlusionTier
    if (tier) tier.maxQueriesPerFrame = n
  }
  function getOcclusionQueryBudget() {
    const tier = pool._occlusionTier
    return tier ? tier.maxQueriesPerFrame : null
  }

  // cull-stats-uniform-shape: pool.getStats().occlusion is the vendored tier's own raw stats shape
  // ({queried, occluded, resolved, supported} -- see occlusion-query-tier.js), missing
  // candidates/failOpens/anomalyTrips/flips/oldestPendingFrames. The vendored tier has no fail-open/
  // hysteresis/anomaly-guard logic at all (entity-level occlusion there is a simple two-frame-latency
  // fail-open with no streak hysteresis -- see that file's own header comment), so failOpens/
  // anomalyTrips/flips are legitimately always 0 for this consumer, not an omission. This wrapper is
  // a CLIENT-SIDE translation only (packages/streaming-gltf is not edited) -- the uniform shape lives
  // here, not inside the vendored library.
  function getStats() {
    const raw = pool.getStats?.() || {}
    const occ = raw.occlusion || {}
    const candidateCount = Array.isArray(pool._occlusionCandidates) ? pool._occlusionCandidates.length : 0
    const tier = pool._occlusionTier
    const pendingCount = tier && tier._records ? tier._records.size : 0
    return {
      ...raw,
      candidates: candidateCount,
      queriedThisFrame: occ.queried || 0,
      resolved: occ.resolved || 0,
      occluded: occ.occluded || 0,
      failOpens: 0,       // vendored tier has no per-candidate fail-open path (see comment above)
      anomalyTrips: 0,    // vendored tier has no anomaly-fraction guard (see comment above)
      flips: 0,           // vendored tier has no hysteresis streak to flip (fail-open only, no streak)
      oldestPendingFrames: pendingCount > 0 ? 1 : 0,   // tier is one-frame-latency only, never multi-frame pending
    }
  }
  // Allocation-free per-frame read for the shared query-budget arbiter (getStats() spreads a fresh object).
  function getCandidateCount() { return Array.isArray(pool._occlusionCandidates) ? pool._occlusionCandidates.length : 0 }
  function has(entityId) { return _entities.has(entityId) }

  // Dedicated VRAM-tracker surface (half-res-transparents-temporal-upscale-texture-vram-budget PRD row):
  // pool.getStats().vram/.unloadManager already carry the real live numbers (model-pool.js's own
  // per-frame byteBudget/_totalBytes/_vramRatioMonitor tracking, wired since before this row -- the gap
  // this closes is DISCOVERABILITY + CONFIGURABILITY, not the underlying eviction mechanism itself,
  // which already runs every frame via _enforceBudget/LodUnloadManager.scanForUnload). Returns a flat,
  // purpose-built shape distinct from getStats()'s culling-oriented uniform-shape spread above.
  function getVramStats() {
    const raw = pool.getStats?.() || {}
    const vram = raw.vram || {}
    const um = raw.unloadManager || {}
    return {
      usedMB: vram.usedMB ?? 0,
      estimatedVramMB: vram.estimatedVramMB ?? 0,
      currentRatio: vram.currentRatio ?? 0,
      peakRatio: vram.peakRatio ?? 0,
      byteBudgetMB: pool.byteBudget != null ? pool.byteBudget / (1024 * 1024) : null,
      totalBytes: pool._totalBytes ?? 0,
      unloadedCount: um.unloadedCount ?? 0,
      visibleEntities: um.visibleEntities ?? 0,
      invisibleEntities: um.invisibleEntities ?? 0,
      recentEvents: getVramLog(),
    }
  }

  // cull-query-box-visualizer: derives a fresh world AABB per candidate the same way
  // occlusion-query-tier.js's own runQueries() does internally (Box3.setFromObject on the entity
  // root), since the tier's own cached rec.localBox is a private field on an object keyed by
  // `entity`, not exposed for external reads. Recomputing here is a debug-overlay cost only (this
  // function is never called from the hot per-frame occlusion path), same tradeoff ColliderDebug.js
  // already accepts for its own entity-collider overlay.
  function getDebugBoxes() {
    const out = []
    const candidates = pool._occlusionCandidates
    const tier = pool._occlusionTier
    if (!Array.isArray(candidates) || !tier) return out
    for (const entity of candidates) {
      if (!entity || !entity.root) continue
      try {
        _debugBox.setFromObject(entity.root)
        if (_debugBox.isEmpty()) continue
        _debugBox.getSize(_debugSize)
        _debugBox.getCenter(_debugCenter)
        const state = tier.isOccluded(entity) ? 'occluded' : 'visible'
        out.push({ key: entity.id || entity.uuid || null, center: [_debugCenter.x, _debugCenter.y, _debugCenter.z], size: Math.max(_debugSize.x, _debugSize.y, _debugSize.z) * 0.5, state })
      } catch (_) {}
    }
    return out
  }

  return { pool, spawn, spawnVRM, remove, setTarget, setRotation, update, runOcclusionQueries, getStats, getCandidateCount, setOcclusionQueryBudget, getOcclusionQueryBudget, getDebugBoxes, has, progressiveReady, _entities, getVramStats, setVramBudgetMB, getVramLog }
}
