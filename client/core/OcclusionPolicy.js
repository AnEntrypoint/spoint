export function createOcclusionPolicy(config = {}) {
  const HIDE_STREAK = config.hideStreak ?? 2
  const UNHIDE_STREAK = config.unhideStreak ?? 2
  const ENABLE_EYE_EXPIRY = config.enableEyeExpiry ?? false
  const EXPIRE_MIN_M = config.expireMinM ?? 3
  const EXPIRE_SIZE_MULT = config.expireSizeMult ?? 1.5
  const STABILITY_GATE = config.stabilityGate ?? 2
  const STALE_RESOLVE_FRAMES = config.staleResolveFrames ?? 90
  const REBUILD_STOP_QUERY_FRAMES = config.rebuildStopQueryFrames ?? 8
  const REBUILD_FAIL_OPEN_FRAMES = config.rebuildFailOpenFrames ?? 16
  const ANOMALY_FRACTION = config.anomalyFraction ?? 0.30
  const ANOMALY_MIN_CANDIDATES = config.anomalyMinCandidates ?? 32

  const _advanceOut = { hidden: false, flipped: false, failOpen: null }
  const _rebuildOut = { skipQuery: false, failOpen: false }

  function ensureRecord(rec) {
    if (rec.streak === undefined) rec.streak = 0
    if (rec.unstreak === undefined) rec.unstreak = 0
    if (rec.hidden === undefined) rec.hidden = false
    if (rec.seen === undefined) rec.seen = 0
    if (rec.staleFrames === undefined) rec.staleFrames = 0
    if (rec.stableCount === undefined) rec.stableCount = 0
    return rec
  }

  function advance(rec, resolveCount, occludedThisResolve) {
    ensureRecord(rec)
    let flipped = false
    if (resolveCount !== rec.seen) {
      rec.seen = resolveCount
      rec.staleFrames = 0
      const verdictNow = occludedThisResolve ? 'hidden' : 'visible'
      const verdictBefore = rec.hidden ? 'hidden' : 'visible'
      if (verdictNow === verdictBefore) {
        rec.stableCount = (rec.stableCount || 0) + 1
      } else {
        rec.stableCount = 1
      }
      if (rec.stableCount >= STABILITY_GATE) {
        if (occludedThisResolve) {
          rec.streak++; rec.unstreak = 0
          if (rec.streak >= HIDE_STREAK && !rec.hidden) { rec.hidden = true; flipped = true }
        } else {
          rec.unstreak++; rec.streak = 0
          if (rec.unstreak >= UNHIDE_STREAK && rec.hidden) { rec.hidden = false; flipped = true }
        }
      }
    } else if (rec.hidden) {
      rec.staleFrames++
      if (rec.staleFrames > STALE_RESOLVE_FRAMES) {
        rec.hidden = false; rec.streak = 0; rec.unstreak = 0; rec.stableCount = 0; flipped = true
        _advanceOut.hidden = rec.hidden; _advanceOut.flipped = flipped; _advanceOut.failOpen = 'stale-resolve'
        return _advanceOut
      }
    }
    _advanceOut.hidden = rec.hidden; _advanceOut.flipped = flipped; _advanceOut.failOpen = null
    return _advanceOut
  }

  function checkEyeExpiry(rec, eyeNow, sizeHint) {
    if (!ENABLE_EYE_EXPIRY || !rec.hidden || !eyeNow || !rec.eyeAtIssue) return false
    if (!eyeMovedPastExpiry(rec, eyeNow, sizeHint)) return false
    rec.hidden = false; rec.streak = 0; rec.unstreak = 0
    return true
  }

  function eyeMovedPastExpiry(rec, eyeNow, sizeHint) {
    if (!eyeNow || !rec.eyeAtIssue) return false
    const px = eyeNow[0] - rec.eyeAtIssue[0], py = eyeNow[1] - rec.eyeAtIssue[1], pz = eyeNow[2] - rec.eyeAtIssue[2]
    const expireM = Math.max(EXPIRE_MIN_M, (sizeHint || 1) * EXPIRE_SIZE_MULT)
    return px * px + py * py + pz * pz > expireM * expireM
  }

  function checkRebuildStaleness(rec, framesSinceSeen) {
    const skipQuery = framesSinceSeen > REBUILD_STOP_QUERY_FRAMES
    let failOpen = false
    if (skipQuery && rec.hidden && framesSinceSeen > REBUILD_FAIL_OPEN_FRAMES) {
      rec.hidden = false; rec.streak = 0; rec.unstreak = 0
      failOpen = true
    }
    _rebuildOut.skipQuery = skipQuery; _rebuildOut.failOpen = failOpen
    return _rebuildOut
  }

  function isAnomalousBatch(liveCount, liveWeight, occludedWeight) {
    if (liveCount < ANOMALY_MIN_CANDIDATES) return false
    const fraction = liveWeight > 0 ? occludedWeight / liveWeight : 0
    return fraction >= ANOMALY_FRACTION
  }

  function resetRecord(rec) {
    rec.streak = 0; rec.unstreak = 0; rec.hidden = false; rec.staleFrames = 0; rec.stableCount = 0
  }

  return {
    ensureRecord,
    advance,
    checkEyeExpiry,
    eyeMovedPastExpiry,
    checkRebuildStaleness,
    isAnomalousBatch,
    resetRecord,
    config: { HIDE_STREAK, UNHIDE_STREAK, ENABLE_EYE_EXPIRY, EXPIRE_MIN_M, EXPIRE_SIZE_MULT, STALE_RESOLVE_FRAMES, REBUILD_STOP_QUERY_FRAMES, REBUILD_FAIL_OPEN_FRAMES, ANOMALY_FRACTION, ANOMALY_MIN_CANDIDATES },
  }
}
