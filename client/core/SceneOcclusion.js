import * as THREE from 'three'
import { OcclusionQueryTier } from 'streaming-gltf/occlusion-query-tier'
import { createOcclusionPolicy } from './OcclusionPolicy.js'
import { dbg } from './debug-log.js'

const _dbgOcclusion = dbg('occlusion')

export function createSceneOcclusion(renderer, opts = {}) {
  const tier = new OcclusionQueryTier(renderer, { minCandidates: opts.minCandidates ?? 32, maxQueriesPerFrame: opts.maxQueriesPerFrame ?? 16 })
  const subsystems = []
  const _occludedBySub = []
  const _policy = createOcclusionPolicy({
    hideStreak: 2,
    unhideStreak: 2,
    stabilityGate: 6,
    enableEyeExpiry: false,
    staleResolveFrames: 60,
    anomalyFraction: 0.30,
    anomalyMinCandidates: 32,
  })
  let _frameCounter = 0
  let _liveInstancesCached = 0
  let _occludedInstances = 0
  let _syncGen = 0
  let _candCache = null
  const _combined = []
  const _lastSubArrays = []
  const _subWeight = []
  const _subDirty = []
  const _uniform = { failOpens: 0, anomalyTrips: 0, flips: 0 }

  function register(name, subsystem) {
    if (!subsystem || typeof subsystem.getOcclusionCandidates !== 'function' || typeof subsystem.applyOcclusion !== 'function') return
    subsystems.push({ name, subsystem })
    _lastSubArrays.push(undefined); _subWeight.push(0); _subDirty.push(false); _occludedBySub.push(new Set()); _candCache = null
  }

  function unregister(name) {
    const i = subsystems.findIndex(s => s.name === name)
    if (i < 0) return
    _syncSubsystem(i, null)
    subsystems.splice(i, 1); _lastSubArrays.splice(i, 1); _subWeight.splice(i, 1); _subDirty.splice(i, 1); _occludedBySub.splice(i, 1)
    for (let j = i; j < _lastSubArrays.length; j++) { const arr = _lastSubArrays[j]; if (arr) for (let k = 0; k < arr.length; k++) arr[k]._occSub = j }
    _rebuildCombined()
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

  const candidateWeight = (c) => Number.isFinite(c.instanceCount) ? c.instanceCount : 1

  function _hide(c, st) {
    st._w = candidateWeight(c)
    _occludedInstances += st._w
    _occludedBySub[c._occSub].add(c.key)
    _subDirty[c._occSub] = true
  }

  function _unhide(c, st) {
    _occludedInstances -= st._w || 0
    st._w = 0
    _occludedBySub[c._occSub].delete(c.key)
    _subDirty[c._occSub] = true
  }

  function _syncSubsystem(i, next) {
    const prev = _lastSubArrays[i]
    const gen = ++_syncGen
    let weight = 0
    if (next) {
      for (let k = 0; k < next.length; k++) {
        const c = next[k]
        c._occGen = gen
        weight += candidateWeight(c)
        if (c._occSub !== i || !c._occStreak) { c._occSub = i; c._occStreak = _policy.ensureRecord({}) }
      }
    }
    if (prev) {
      for (let k = 0; k < prev.length; k++) {
        const c = prev[k]
        if (c._occGen === gen) continue
        const st = c._occStreak
        if (st && st.hidden) _unhide(c, st)
        c._occStreak = null; c._occSub = -1
        try { tier.release(c) } catch (_) {}
      }
    }
    _liveInstancesCached += weight - (_subWeight[i] || 0)
    _subWeight[i] = weight
    _lastSubArrays[i] = next
    _subDirty[i] = true
  }

  function _rebuildCombined() {
    _combined.length = 0
    for (let i = 0; i < subsystems.length; i++) {
      const arr = _lastSubArrays[i]
      if (arr) for (let k = 0; k < arr.length; k++) _combined.push(arr[k])
    }
    _candCache = _combined
  }

  function _resetAllHidden() {
    for (let k = 0; k < _combined.length; k++) {
      const st = _combined[k]._occStreak
      if (!st) continue
      _policy.resetRecord(st); st._w = 0; st._anomalySkippedFrame = _frameCounter
    }
    for (let i = 0; i < _occludedBySub.length; i++) { _occludedBySub[i].clear(); _subDirty[i] = true }
    _occludedInstances = 0
  }

  function runQueries(camera) {
    if (!tier.supported()) return
    while (_occludedBySub.length < subsystems.length) _occludedBySub.push(new Set())
    let changed = !_candCache
    for (let i = 0; i < subsystems.length; i++) {
      let arr
      try { arr = subsystems[i].subsystem.getOcclusionCandidates() } catch (e) { _dbgOcclusion('getOcclusionCandidates failed:', e?.message || e); arr = null }
      if (arr !== _lastSubArrays[i]) { changed = true; _syncSubsystem(i, arr) }
    }
    if (changed) _rebuildCombined()
    const candidates = _combined
    if (candidates.length < (opts.minCandidates ?? 32)) return
    _frameCounter++
    const still = _cameraStillFor(camera) && !changed
    tier.maxQueriesPerFrame = still ? 0 : _configuredBudget
    tier.runQueries(camera, candidates)
    _uniform.failOpens = 0; _uniform.flips = 0
    for (let k = 0; k < candidates.length; k++) {
      const c = candidates[k]
      const st = c._occStreak
      const wasHidden = st.hidden
      const result = _policy.advance(st, tier.getResolveCount(c), tier.isOccluded(c))
      if (result.flipped) _uniform.flips++
      if (result.failOpen) { _uniform.failOpens++; st._lastFailOpenFrame = _frameCounter }
      if (st.hidden !== wasHidden) { if (st.hidden) _hide(c, st); else _unhide(c, st) }
    }
    if (_policy.isAnomalousBatch(candidates.length, _liveInstancesCached, _occludedInstances)) {
      _resetAllHidden()
      _uniform.anomalyTrips++
    }
    for (let i = 0; i < subsystems.length; i++) {
      if (!_subDirty[i]) continue
      try { subsystems[i].subsystem.applyOcclusion(_occludedBySub[i]); _subDirty[i] = false } catch (_) {}
    }
  }

  function getStats() {
    const candidateCount = getCandidateCount()
    let oldestPendingFrames = 0
    for (let k = 0; k < _combined.length; k++) { const st = _combined[k]._occStreak; if (st && st.hidden && st.staleFrames > oldestPendingFrames) oldestPendingFrames = st.staleFrames }
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
      const st = c._occStreak
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

  function snapshotOccludedKeys() {
    const out = new Set()
    for (let i = 0; i < _occludedBySub.length; i++) for (const k of _occludedBySub[i]) out.add(i + ':' + k)
    return out
  }

  return { register, unregister, runQueries, getStats, getCandidateCount, dispose, supported: () => tier.supported(), snapshotOccludedKeys, setMaxQueriesPerFrame, getMaxQueriesPerFrame, getDebugBoxes }
}
