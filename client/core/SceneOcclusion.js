import * as THREE from 'three'
import { OcclusionQueryTier } from 'streaming-gltf/occlusion-query-tier'
import { createOcclusionPolicy } from './OcclusionPolicy.js'
import { dbg } from './debug-log.js'

const _dbgOcclusion = dbg('occlusion')

export function createSceneOcclusion(renderer, opts = {}) {
  const tier = new OcclusionQueryTier(renderer, { minCandidates: opts.minCandidates ?? 32, maxQueriesPerFrame: opts.maxQueriesPerFrame ?? 16 })
  const subsystems = []
  const _occludedKeys = new Set()
  const _policy = createOcclusionPolicy({
    hideStreak: 2,
    unhideStreak: 2,
    stabilityGate: 6,
    enableEyeExpiry: false,
    staleResolveFrames: 60,
    anomalyFraction: 0.30,
    anomalyMinCandidates: 32,
  })
  const _streaks = new Map()
  let _frameCounter = 0
  const _lastCandByKey = new Map()
  const _liveKeys = new Set()
  let _liveInstancesCached = 0
  let _candCache = null
  const _lastSubArrays = []
  const _uniform = { failOpens: 0, anomalyTrips: 0, flips: 0 }

  function register(name, subsystem) {
    if (!subsystem || typeof subsystem.getOcclusionCandidates !== 'function' || typeof subsystem.applyOcclusion !== 'function') return
    subsystems.push({ name, subsystem })
    _lastSubArrays.push(undefined); _candCache = null
  }

  function unregister(name) {
    const i = subsystems.findIndex(s => s.name === name)
    if (i >= 0) { subsystems.splice(i, 1); _lastSubArrays.splice(i, 1); _candCache = null }
  }

  const _occCamPos = new THREE.Vector3(), _occCamQ = new THREE.Quaternion()
  let _occLastPx = NaN, _occLastPz = NaN, _occLastPy = NaN
  let _occLastQx = NaN, _occLastQy = NaN, _occLastQz = NaN, _occLastQw = NaN
  const OCC_IDLE_EPS = 0.05, OCC_ROT_COS_EPS = 0.999985
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
    if (changed) {
      _liveKeys.clear()
      _liveInstancesCached = 0
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        _liveKeys.add(c.key)
        _lastCandByKey.set(c.key, c)
        _liveInstancesCached += Number.isFinite(c.instanceCount) ? c.instanceCount : 1
        let st = _streaks.get(c.key)
        if (!st) { st = _policy.ensureRecord({}); _streaks.set(c.key, st) }
        c._occStreak = st
      }
      for (const key of _streaks.keys()) {
        if (_liveKeys.has(key)) continue
        _streaks.delete(key)
        const staleCand = _lastCandByKey.get(key)
        if (staleCand) { try { tier.release(staleCand) } catch (_) {} }
        _lastCandByKey.delete(key)
      }
    }
    const _liveInstances = _liveInstancesCached
    let _occludedInstances = 0
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      let st = c._occStreak
      if (!st) { st = _streaks.get(c.key); if (!st) { st = _policy.ensureRecord({}); _streaks.set(c.key, st) } c._occStreak = st }
      const resolves = tier.getResolveCount(c)
      const result = _policy.advance(st, resolves, tier.isOccluded(c))
      if (result.flipped) _uniform.flips++
      if (result.failOpen) { _uniform.failOpens++; st._lastFailOpenFrame = _frameCounter }
      if (st.hidden) { _occludedKeys.add(c.key); _occludedInstances += Number.isFinite(c.instanceCount) ? c.instanceCount : 1 }
    }
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
    const candidateCount = getCandidateCount()
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

  function getCandidateCount() {
    if (_candCache) return _candCache.length
    let n = 0
    for (let i = 0; i < subsystems.length; i++) { try { n += subsystems[i].subsystem.getOcclusionCandidates().length } catch (_) {} }
    return n
  }

  function dispose() { try { tier.dispose() } catch (_) {} subsystems.length = 0 }

  function setMaxQueriesPerFrame(n) { if (Number.isFinite(n) && n >= 0) _configuredBudget = n }
  function getMaxQueriesPerFrame() { return _configuredBudget }

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

  function snapshotOccludedKeys() { return new Set(_occludedKeys) }

  return { register, unregister, runQueries, getStats, getCandidateCount, dispose, supported: () => tier.supported(), snapshotOccludedKeys, setMaxQueriesPerFrame, getMaxQueriesPerFrame, getDebugBoxes }
}
