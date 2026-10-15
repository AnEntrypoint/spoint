const HEADSHOT_WINDOW_SIZE = 20
const HEADSHOT_MIN_SAMPLES = 10
const HEADSHOT_RATIO_THRESHOLD = 0.75
const FAST_STREAK_INTERVAL_MS = 100
const FAST_STREAK_MIN_LENGTH = 4
const FLAG_COOLDOWN_MS = 5000

const _shooterWindows = new Map()

function _getWindow(shooterId) {
  let w = _shooterWindows.get(shooterId)
  if (!w) { w = { hits: [], lastHeadshotAt: 0, fastStreak: 0, lastFlagAt: 0 }; _shooterWindows.set(shooterId, w) }
  return w
}

export function recordHit(eventLog, shooterId, { headshot, timestampMs = Date.now(), targetId } = {}) {
  if (shooterId == null) return
  const w = _getWindow(shooterId)

  w.hits.push(!!headshot)
  if (w.hits.length > HEADSHOT_WINDOW_SIZE) w.hits.shift()
  if (w.hits.length >= HEADSHOT_MIN_SAMPLES) {
    const hsCount = w.hits.reduce((n, h) => n + (h ? 1 : 0), 0)
    const ratio = hsCount / w.hits.length
    if (ratio >= HEADSHOT_RATIO_THRESHOLD && timestampMs - w.lastFlagAt > FLAG_COOLDOWN_MS) {
      w.lastFlagAt = timestampMs
      eventLog?.record('anticheat_outlier', { shooterId, kind: 'high_headshot_ratio', ratio: Math.round(ratio * 1000) / 1000, sampleSize: w.hits.length }, { actor: shooterId, reason: 'statistical_outlier' })
    }
  }

  if (headshot) {
    const gap = timestampMs - w.lastHeadshotAt
    if (w.lastHeadshotAt > 0 && gap < FAST_STREAK_INTERVAL_MS) w.fastStreak++
    else w.fastStreak = 1
    w.lastHeadshotAt = timestampMs
    if (w.fastStreak >= FAST_STREAK_MIN_LENGTH && timestampMs - w.lastFlagAt > FLAG_COOLDOWN_MS) {
      w.lastFlagAt = timestampMs
      eventLog?.record('anticheat_outlier', { shooterId, kind: 'suspiciously_fast_headshot_streak', streakLength: w.fastStreak, intervalMs: gap, targetId: targetId ?? null }, { actor: shooterId, reason: 'statistical_outlier' })
    }
  } else {
    w.fastStreak = 0
  }
}

export function clearOutlierWindow(shooterId) {
  _shooterWindows.delete(shooterId)
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapOutlierDetector = (next) => {
  recordHit = next.recordHit
  clearOutlierWindow = next.clearOutlierWindow
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapOutlierDetector)
