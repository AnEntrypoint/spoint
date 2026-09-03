// Statistical outlier flags for weapon-hitscan events (anticheat-server-envelope-checks, docs/anticheat.md
// "Tractable dedicated-server mitigations" item 3). NON-BLOCKING: this never rejects a hit, damages a
// player's own state, or auto-bans -- it only writes an eventLog entry an operator can query
// (ctx.eventLog.query({type:'anticheat_outlier'})), same discipline as the movement-envelope clamp in
// TickHandler.js. A false positive here costs nothing (no visible in-game effect); a false negative just
// means one more shot goes unflagged -- the honest tradeoff for a detect-only signal with no ground truth
// to calibrate against.
//
// Two rolling per-shooter windows, both keyed off data that ALREADY flows through a real hit-registration
// call (apps/tps-game/server.js's handleFire / apps/_lib/weapon.js's fire()) -- no new client message, no
// new trust boundary:
//
// 1. Headshot% over a rolling window of recent hits: a sustained headshot ratio far above what human
//    aim achieves (even a very good human rarely holds >70-80% headshot ratio over dozens of consecutive
//    hits) is the classic aimbot signature. Flagged once the window is full enough to be statistically
//    meaningful (avoids flagging a brand-new player's first 2-3 lucky headshots) AND the ratio clears a
//    high bar.
// 2. Shot-to-shot interval anomaly: the tightest defensible "reaction time"-adjacent signal buildable from
//    data this codebase actually has (there is no target-visibility/appeared-in-view timestamp tracked
//    anywhere -- confirmed via codesearch -- so a literal "time from enemy-appears to hit" reaction-time
//    metric is not honestly measurable yet). What IS measurable: the wall-clock interval between this
//    shooter's consecutive HITS, specifically when every shot in a burst lands as a headshot. A human
//    landing several sub-100ms-apart consecutive headshots is consistent with an aim-lock/silent-aimbot,
//    not real target-tracking reaction time -- flagged as 'suspiciously_fast_headshot_streak', named
//    honestly for what it actually measures rather than overclaiming general "reaction time" detection.

const HEADSHOT_WINDOW_SIZE = 20        // hits considered for the rolling headshot ratio
const HEADSHOT_MIN_SAMPLES = 10        // don't flag until the window has at least this many hits
const HEADSHOT_RATIO_THRESHOLD = 0.75  // flag if >=75% of the last N hits were headshots
const FAST_STREAK_INTERVAL_MS = 100    // consecutive-headshot gap below this is "suspiciously fast"
const FAST_STREAK_MIN_LENGTH = 4       // need this many consecutive sub-threshold-gap headshots to flag
const FLAG_COOLDOWN_MS = 5000          // don't re-flag the same shooter more than once per this window (log-spam guard)

const _shooterWindows = new Map() // shooterId -> { hits:[bool,...] (headshot flags, oldest first), lastHeadshotAt, fastStreak, lastFlagAt }

function _getWindow(shooterId) {
  let w = _shooterWindows.get(shooterId)
  if (!w) { w = { hits: [], lastHeadshotAt: 0, fastStreak: 0, lastFlagAt: 0 }; _shooterWindows.set(shooterId, w) }
  return w
}

// Call once per resolved hit (not per shot fired -- misses don't count toward headshot ratio, matching
// how a human would describe "headshot percentage"). `eventLog` may be null/undefined (some callers, e.g.
// apps/_lib/weapon.js's generic primitive, always have ctx.eventLog from AppContext, but this stays
// defensive so a caller without one just skips recording rather than throwing).
export function recordHit(eventLog, shooterId, { headshot, timestampMs = Date.now(), targetId } = {}) {
  if (shooterId == null) return
  const w = _getWindow(shooterId)

  // (1) rolling headshot ratio
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

  // (2) consecutive-fast-headshot streak
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

// Called on player disconnect/removePlayer so a churned numeric shooterId never inherits a previous
// occupant's rolling window (same discipline as InputGuard.js's clearInputBucket).
export function clearOutlierWindow(shooterId) {
  _shooterWindows.delete(shooterId)
}
