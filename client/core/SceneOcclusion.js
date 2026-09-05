// Shared, chunk-grained occlusion-query culling for vegetation/rocks (terrain is wired separately via TerrainBackdrop). Reuses streaming-gltf's OcclusionQueryTier; vegetation/rocks are candidates (culled), never occluders.
import * as THREE from 'three'
import { OcclusionQueryTier } from 'streaming-gltf/occlusion-query-tier'
import { createOcclusionPolicy } from './OcclusionPolicy.js'
import { dbg } from './debug-log.js'

const _dbgOcclusion = dbg('occlusion')

export function createSceneOcclusion(renderer, opts = {}) {
  // maxQueriesPerFrame 16, not the vendor OcclusionQueryTier's own default of 32 (streaming-gltf's
  // occlusion-query-tier.js) and not TerrainOcclusion.js's own independent MAX_QUERIES_PER_FRAME=32 --
  // deliberate, not drift: commit 448bc828 (2026-07-05 fullscreen-30fps diagnosis) measured GPU command
  // execution ~92% saturated and halved this consumer's per-frame query-issue budget as part of that
  // fix. TerrainOcclusion.js's 32 covers a different candidate set (terrain tiles, not veg/rock chunks)
  // and was not part of that measurement -- the two budgets are allowed to differ, this just isn't why.
  const tier = new OcclusionQueryTier(renderer, { minCandidates: opts.minCandidates ?? 32, maxQueriesPerFrame: opts.maxQueriesPerFrame ?? 16 })
  const subsystems = []   // { name, getOcclusionCandidates(), applyOcclusion(Set) }
  const _occludedKeys = new Set()
  // Verdict policy (streak hysteresis, stale-resolve fail-open, anomaly-fraction guard) now lives in
  // the shared client/core/OcclusionPolicy.js -- see that file's header for why each constant below
  // is set the way it is (this consumer's own hand-tuned history is preserved as config, not
  // reimplemented here). _streaks stays a local Map<key, record>; OcclusionPolicy reads/writes the
  // record fields it owns (streak/unstreak/hidden/seen/staleFrames) via ensureRecord/advance.
  const _policy = createOcclusionPolicy({
    hideStreak: 2,
    unhideStreak: 2,          // symmetric un-hide: query-budget-starved sparse resolves must not flicker on one noisy read
    stabilityGate: 6,         // require 6 consecutive frames with same query result before verdict flip; dampens depth-jitter oscillation on close geometry (stumps, near trees)
    enableEyeExpiry: false,   // this consumer's candidates don't track per-candidate eyeAtIssue/size (TerrainOcclusion-specific)
    staleResolveFrames: 60,   // reduced from 90 to 60 frames: fail-open stale verdicts faster under budget starvation to eliminate transient hide-on-camera-move flicker
    anomalyFraction: 0.30,    // see cull-false-occlusion-root-cause: hide rate measured 49.0-51.4% across two thresholds already
    anomalyMinCandidates: 32,
  })
  const _streaks = new Map()   // key -> { streak, unstreak, hidden, seen: last tier resolve count, staleFrames: frames since seen last advanced }
  let _frameCounter = 0   // local frame counter for getDebugBoxes' one-cycle failed-open/anomaly-skipped highlighting
  // key -> candidate object last seen for that key. Neither Vegetation.js/Rocks.js nor this module ever
  // called tier.release() for a chunk that unloads -- its gl.createQuery() handle (and _records Map entry)
  // lived forever: one leaked live WebGL query object per chunk EVER streamed through the session, growing
  // without bound over a long play session. (Investigated as a candidate root cause for a separately
  // discovered severe false-occlusion rate on vegetation/rocks -- ruled OUT as the primary cause, since the
  // false-occlusion rate is already high from the very first resolved batch, before any leak could
  // accumulate; that issue is unresolved and tracked separately. This fix stands on its own merits as a
  // real unbounded-resource-growth bug independent of that investigation.)
  const _lastCandByKey = new Map()
  // Live-key set, persistent across frames rather than a fresh `new Set()` per frame. It is only ever
  // read for (a) isAnomalousBatch's liveCount and (b) the tier-release sweep below, and its CONTENTS are
  // a pure function of the candidate array -- so while `changed` is false (the same identity-stable
  // arrays, the overwhelming majority of frames once streaming settles) the set this loop would rebuild
  // is byte-for-byte the one already held. Rebuilding it was ~N Set.add + N Map.set string-hash
  // operations per frame (N = ~450 live veg/rock chunks measured in tps-game) plus one Set allocation,
  // all discarded unchanged.
  const _liveKeys = new Set()
  // Anomaly fail-open: a real view never legitimately occludes ~every candidate at once (that would mean
  // the entire streamed world is behind something, impossible short of the camera being inside solid
  // geometry). Live-witnessed root cause of "impostors invisible except certain angles": at altitude,
  // looking down at vegetation, the box-vs-depth ANY_SAMPLES_PASSED_CONSERVATIVE query
  // (streaming-gltf's OcclusionQueryTier) resolves EVERY candidate occluded simultaneously (100% of
  // ~1750 loaded chunks, confirmed via live occludedKeys.size===candidateCount), hiding all vegetation
  // instead of the legitimate subset actually behind terrain. See cull-false-occlusion-root-cause /
  // cull-anomaly-stopgap-reeval (docs/rendering.md) for the current root-cause status and whether this
  // guard (now delegated to OcclusionPolicy.isAnomalousBatch, same 0.30/32 constants) still earns its
  // keep. Stats below track anomalyTrips so a live session can see how often this guard actually fires.
  // Each subsystem's getOcclusionCandidates() returns an IDENTITY-STABLE cached array (Vegetation.js/
  // Rocks.js/Grass.js all null it only on a real loaded-set change) -- so re-concatenating + rebuilding
  // the _liveKeys Set and _lastCandByKey Map every frame is wasted work on every frame no subsystem's
  // set actually changed (the overwhelming majority of frames; loaded chunks change only on streaming
  // load/unload, not every frame). Cache the per-subsystem array reference and the flattened result;
  // skip straight to tier.runQueries with the cached candidates array when every reference is unchanged.
  // tier.runQueries still does its own real per-frame work (resolve poll + round-robin query issue) --
  // this only removes the redundant candidate-list flatten/rebuild, not the actual query budget.
  let _candCache = null      // flattened candidates array from the last rebuild
  const _lastSubArrays = []  // parallel to `subsystems`, last-seen array reference per subsystem
  // Uniform stats accumulators (cull-stats-uniform-shape): reset once per runQueries() call, read by getStats().
  const _uniform = { failOpens: 0, anomalyTrips: 0, flips: 0 }

  function register(name, subsystem) {
    if (!subsystem || typeof subsystem.getOcclusionCandidates !== 'function' || typeof subsystem.applyOcclusion !== 'function') return
    subsystems.push({ name, subsystem })
    _lastSubArrays.push(undefined); _candCache = null   // membership changed -- force a rebuild next frame
  }

  function unregister(name) {
    const i = subsystems.findIndex(s => s.name === name)
    if (i >= 0) { subsystems.splice(i, 1); _lastSubArrays.splice(i, 1); _candCache = null }
  }

  // Still-camera issue-throttle: tier.runQueries always does two things -- (1) poll-resolve any
  // in-flight queries from a prior frame (cheap: gl.getQueryParameter, no GL state change, no draw)
  // and (2) issue up to maxQueriesPerFrame NEW queries (per-issue: useProgram/bindVertexArray/
  // colorMask/depthMask/polygonOffset state changes + a real drawElements + gl.flush()) -- see
  // streaming-gltf/occlusion-query-tier.js runQueries(). This ran unconditionally every rendered
  // frame with zero gating, unlike every OTHER veg/rock/grass per-frame cull path (Vegetation.js/
  // Grass.js/Rocks.js all freeze their own InstancedMesh2/BatchedMesh cull walk once camera position
  // AND rotation go still) -- unlike those, this module had no still-camera concept at all, so its
  // ~7.7%-of-frame GL query-issue cost kept paying in full even while the player stood
  // completely motionless staring at nothing new. A still, non-rotating camera with an unchanged
  // candidate set cannot possibly need a fresh occlusion verdict (nothing the query tests -- camera
  // frustum vs static world geometry -- has changed), so drop the issue budget to 0 while idle:
  // resolve-polling for in-flight queries STILL runs every frame (never starves a pending verdict
  // mid-flight, no permanent stuck-hidden risk), only the real per-frame draw-submission cost is
  // skipped. Re-arms to the configured budget the instant camera position/rotation moves OR the
  // candidate set itself changes (a streamed-in/out chunk needs its own fresh query, camera or not).
  const _occCamPos = new THREE.Vector3(), _occCamQ = new THREE.Quaternion()
  let _occLastPx = NaN, _occLastPz = NaN, _occLastPy = NaN
  let _occLastQx = NaN, _occLastQy = NaN, _occLastQz = NaN, _occLastQw = NaN
  const OCC_IDLE_EPS = 0.05, OCC_ROT_COS_EPS = 0.999985
  // Mutable (not const): setMaxQueriesPerFrame below (the existing external-arbiter setter, see
  // OcclusionQueryBudget.js's cull-shared-query-budget wiring) must update THIS value, not
  // tier.maxQueriesPerFrame directly -- the idle-throttle below temporarily zeroes
  // tier.maxQueriesPerFrame every still frame and restores it from _configuredBudget on the next
  // real movement, so a configured-budget change landing only on the tier field would get silently
  // clobbered back to the stale pre-arbiter default the very next idle frame.
  let _configuredBudget = opts.maxQueriesPerFrame ?? 16
  function _cameraStillFor(camera) {
    camera.getWorldPosition(_occCamPos)
    const mdx = _occCamPos.x - _occLastPx, mdy = _occCamPos.y - _occLastPy, mdz = _occCamPos.z - _occLastPz
    const posStill = Number.isFinite(mdx) && (mdx * mdx + mdy * mdy + mdz * mdz) < OCC_IDLE_EPS * OCC_IDLE_EPS
    _occLastPx = _occCamPos.x; _occLastPy = _occCamPos.y; _occLastPz = _occCamPos.z
    camera.getWorldQuaternion(_occCamQ)
    let rotStill = false
    if (Number.isFinite(_occLastQw)) {
      const dot = _occCamQ.x * _occLastQx + _occCamQ.y * _occLastQy + _occCamQ.z * _occLastQz + _occCamQ.w * _occLastQw
      rotStill = Math.abs(dot) >= OCC_ROT_COS_EPS
    }
    _occLastQx = _occCamQ.x; _occLastQy = _occCamQ.y; _occLastQz = _occCamQ.z; _occLastQw = _occCamQ.w
    return posStill && rotStill
  }

  // Must run AFTER renderer.render(scene,camera) (same timing as modelPool.runOcclusionQueries) so depth holds every opaque occluder for this frame.
  function runQueries(camera) {
    if (!tier.supported()) return
    let changed = !_candCache
    for (let i = 0; i < subsystems.length; i++) {
      let arr
      try { arr = subsystems[i].subsystem.getOcclusionCandidates() } catch (_) { arr = null }
      if (arr !== _lastSubArrays[i]) { changed = true; _lastSubArrays[i] = arr }
    }
    let candidates
    if (changed) {
      candidates = []
      for (const { subsystem } of subsystems) {
        try { candidates.push(...subsystem.getOcclusionCandidates()) } catch (e) { _dbgOcclusion('getOcclusionCandidates failed:', e?.message || e) }
      }
      _candCache = candidates
    } else {
      candidates = _candCache
    }
    if (candidates.length < (opts.minCandidates ?? 32)) return
    _frameCounter++
    const still = _cameraStillFor(camera) && !changed
    tier.maxQueriesPerFrame = still ? 0 : _configuredBudget
    tier.runQueries(camera, candidates)
    _occludedKeys.clear()
    _uniform.failOpens = 0; _uniform.flips = 0
    // _liveKeys only -- _lastCandByKey must NOT be cleared here: the release sweep below looks up
    // exactly the keys that dropped OUT of the candidate set, so clearing it would silently skip every
    // tier.release() and reinstate the unbounded gl.createQuery() leak this map exists to close.
    if (changed) _liveKeys.clear()
    let _liveInstances = 0, _occludedInstances = 0
    for (const c of candidates) {
      // Key-set bookkeeping only has to run on a frame where the candidate SET actually changed -- see
      // _liveKeys' declaration. instanceCount is NOT cached the same way: Vegetation.js refreshes it on
      // every getOcclusionCandidates() call even when the array identity is stable, so the weight sum
      // below stays a real per-frame read.
      if (changed) { _liveKeys.add(c.key); _lastCandByKey.set(c.key, c) }
      const weight = Number.isFinite(c.instanceCount) ? c.instanceCount : 1
      _liveInstances += weight
      let st = _streaks.get(c.key)
      if (!st) { st = _policy.ensureRecord({}); _streaks.set(c.key, st) }
      // only advance on a FRESH resolve, or the per-frame query budget's stale verdict would collapse the hysteresis into a 2-frame delay
      const resolves = tier.getResolveCount(c)
      const result = _policy.advance(st, resolves, tier.isOccluded(c))
      if (result.flipped) _uniform.flips++
      if (result.failOpen) { _uniform.failOpens++; st._lastFailOpenFrame = _frameCounter }
      if (st.hidden) { _occludedKeys.add(c.key); _occludedInstances += weight }
    }
    // Release the tier's per-entity query/record for any key that dropped out of the live candidate set
    // (chunk unloaded) -- prevents an unbounded gl.createQuery() leak across a long streaming session.
    // Gated on `changed` because it is provably a no-op otherwise: this sweep leaves _streaks a subset of
    // _liveKeys, the loop above only ever ADDS keys drawn from that same candidate array, and while
    // `changed` is false the array (hence _liveKeys) is identical -- so no key can have dropped out. The
    // sweep was iterating every one of the ~450 streak records every frame to delete nothing.
    if (changed) for (const key of _streaks.keys()) {
      if (_liveKeys.has(key)) continue
      _streaks.delete(key)
      const staleCand = _lastCandByKey.get(key)
      if (staleCand) { try { tier.release(staleCand) } catch (_) {} }
      _lastCandByKey.delete(key)
    }
    // Anomaly guard: if this batch marks an implausibly large fraction of candidates occluded, the query
    // itself is in a bad state (see OcclusionPolicy.isAnomalousBatch / cull-false-occlusion-root-cause)
    // -- reset every streak (so a real legitimate occlusion re-earns its hysteresis fresh rather than
    // inheriting a poisoned streak) and fail open (apply an EMPTY set) instead of hiding the whole
    // visible world for a frame. Weighted by INSTANCE count, not raw chunk count: live-witnessed a real
    // case where only 1.7% of CHUNKS were in this resolve batch's occluded set yet 51.4% of actual
    // vegetation INSTANCES were hidden (occlusion concentrated in a few densely-packed chunks) -- a
    // chunk-count fraction alone silently missed this. Candidates lacking instanceCount (e.g. rocks)
    // weight 1 each, preserving prior chunk-count behavior for subsystems that haven't opted in yet.
    if (_policy.isAnomalousBatch(_liveKeys.size, _liveInstances, _occludedInstances)) {
      for (const st of _streaks.values()) { _policy.resetRecord(st); st._anomalySkippedFrame = _frameCounter }
      _occludedKeys.clear()
      _uniform.anomalyTrips++
    }
    for (const { subsystem } of subsystems) {
      try { subsystem.applyOcclusion(_occludedKeys) } catch (_) {}
    }
  }

  function getStats() {
    // Uniform shape (cull-stats-uniform-shape): {candidates, queriedThisFrame, resolved, occluded,
    // failOpens, anomalyTrips, flips, oldestPendingFrames}. tier.stats already carries
    // queried/occluded/resolved/supported; candidateCount/subsystems preserved for back-compat.
    const candidateCount = subsystems.reduce((n, s) => { try { return n + s.subsystem.getOcclusionCandidates().length } catch (_) { return n } }, 0)
    let oldestPendingFrames = 0
    for (const st of _streaks.values()) if (st.hidden && st.staleFrames > oldestPendingFrames) oldestPendingFrames = st.staleFrames
    return {
      ...tier.stats,
      subsystems: subsystems.map(s => s.name),
      candidateCount,
      candidates: candidateCount,
      queriedThisFrame: tier.stats.queried,
      failOpens: _uniform.failOpens,
      anomalyTrips: _uniform.anomalyTrips,
      flips: _uniform.flips,
      oldestPendingFrames,
    }
  }

  function dispose() { try { tier.dispose() } catch (_) {} subsystems.length = 0 }

  // cull-shared-query-budget: the arbiter's per-frame allocation now lands on _configuredBudget (the
  // still-camera idle-throttle's restore target), not tier.maxQueriesPerFrame directly -- see the
  // comment on _configuredBudget's declaration above for why a direct write would be clobbered.
  // getMaxQueriesPerFrame() intentionally reports the CONFIGURED value, not whatever
  // tier.maxQueriesPerFrame transiently holds this frame (0 while idle) -- an arbiter reading this
  // back to make a proportional-share decision must see the real budget, not an idle artifact.
  function setMaxQueriesPerFrame(n) { if (Number.isFinite(n) && n >= 0) _configuredBudget = n }
  function getMaxQueriesPerFrame() { return _configuredBudget }

  // cull-query-box-visualizer: candidate boxes derived from each candidate's own THREE.Object3D
  // proxy transform (Vegetation.js/Rocks.js build a unit-cube mesh scaled+positioned to the
  // candidate's real world AABB -- see getOcclusionCandidates in those files -- so root.position IS
  // the box center and root.scale IS the box half-size-ish extent directly, no separate bookkeeping
  // needed here). candidates without a `root` (a subsystem not following the Object3D-proxy
  // convention) are skipped rather than guessed at.
  function getDebugBoxes() {
    const out = []
    const cands = _candCache || []
    for (const c of cands) {
      if (!c || !c.root || !c.root.position) continue
      const st = _streaks.get(c.key)
      let state = 'visible'
      if (st) {
        if (st._anomalySkippedFrame === _frameCounter) state = 'anomaly-skipped'
        else if (st._lastFailOpenFrame === _frameCounter) state = 'failed-open'
        else if (st.hidden) state = 'occluded'
      }
      const p = c.root.position, s = c.root.scale
      out.push({ key: c.key, center: [p.x, p.y, p.z], size: Math.max(s.x, s.y, s.z) * 0.5, state })
    }
    return out
  }

  // Render-DAG visibility-resolve node reads this: a pure snapshot of _occludedKeys (the SAME set
  // already handed to each subsystem's applyOcclusion() this frame), exposed read-only so a DAG node
  // never needs its own occlusion pipeline to know what's hidden.
  function snapshotOccludedKeys() { return new Set(_occludedKeys) }

  return { register, unregister, runQueries, getStats, dispose, supported: () => tier.supported(), snapshotOccludedKeys, setMaxQueriesPerFrame, getMaxQueriesPerFrame, getDebugBoxes }
}
