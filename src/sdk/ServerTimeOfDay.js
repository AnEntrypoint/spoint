// Server-authoritative day-cycle clock: the server-side counterpart to client/core/TimeOfDay.js's local
// `t` fraction model (see AGENTS.md/PRD server-clock-synced-time-of-day-network-sync). This module owns
// ONLY the fraction math (advance-and-wrap, same formula as TimeOfDay.js's own update()) -- it never
// touches THREE lights or the sun direction; the server has no renderer. TickHandler.js ticks this once
// per real tick (dt seconds) and periodically broadcasts {t, dayLengthSec} to connected clients, which
// apply it via TimeOfDay.setFraction() as a COARSE correction while their own local update(dt) keeps
// interpolating smoothly in between -- never a hard visual snap every sync tick, matching the existing
// entity-position reconciliation discipline elsewhere in netcode.
//
// Enabled only when a world opts in: worldDef.terrain.timeOfDay.serverAuthoritative === true. Absent/false
// leaves every client running its own free-running local clock exactly as shipped (singleplayer/testing
// default) -- this module is inert (tick()/shouldBroadcast() both no-op-safe) when disabled.
//
// LAZY CONFIG READ (real bug found+fixed live this session): takes a getConfig() ACCESSOR, not a
// pre-resolved config object, and re-reads it on every tick() call rather than resolving enabled/
// dayLengthSec/startFraction once at construction. TickHandler.js is built inside wireServerHandlers(ctx),
// which runs BEFORE server.js's boot() calls server.loadWorld(worldDef) -- ctx.currentWorldDef is still
// undefined at TickHandler-construction time, so a construction-time-only config read (the first version
// of this module) permanently baked in `enabled=false` regardless of what the world config said, and no
// world's server-authoritative time-of-day ever activated. Live-witnessed the failure with a real 2-client
// WebSocket harness against tps-game (which DOES set terrain.timeOfDay.serverAuthoritative=true): zero
// TIME_OF_DAY_SYNC messages ever arrived. Mirrors getRelevanceRadius's own established pattern in this
// same file (a live accessor called fresh on every use, never captured once).
const DEFAULT_BROADCAST_INTERVAL_SEC = 5

export function createServerTimeOfDay(getConfig) {
  const _getConfig = typeof getConfig === 'function' ? getConfig : () => null
  // Deferred init: enabled/dayLengthSec/startFraction/broadcastIntervalSec are resolved from the FIRST
  // config read that ever reports serverAuthoritative===true (typically the first real tick() call, by
  // which point ctx.currentWorldDef is guaranteed populated -- loadWorld() always completes before the
  // first onTick fires). Re-checking `enabled` on every tick (not just once) also means a world config
  // hot-reloaded to flip serverAuthoritative mid-session takes effect without a server restart.
  let enabled = false
  let dayLengthSec = 600
  let t = 0.3
  let broadcastIntervalSec = DEFAULT_BROADCAST_INTERVAL_SEC
  let _initialized = false
  let _accumSec = 0

  function _resolve() {
    const cfg = _getConfig()
    const nowEnabled = !!(cfg && cfg.serverAuthoritative === true)
    if (nowEnabled && !_initialized) {
      // First activation: seed t/dayLengthSec/broadcastIntervalSec from the config that just turned this
      // on. Only happens once -- a later config change to dayLengthSec while already running is picked
      // by the world-reload path re-creating the whole TickHandler (same discipline as every other
      // config-at-construction value in this file, e.g. tickRate itself), not by this module re-seeding
      // mid-flight and silently jumping the clock.
      dayLengthSec = Number.isFinite(cfg.dayLengthSec) && cfg.dayLengthSec > 0 ? cfg.dayLengthSec : 600
      // cfg.seed ({t, dayLengthSec, atMs}), set by WorkerEntry from BrowserServer's INIT payload,
      // reconstructs elapsed time across an in-page server rebuild (stall recovery / host migration):
      // a fresh worker used to reset the clock to startFraction (noon), live-witnessed as the day/night
      // cycle jumping BACKWARD on every refocus-after-background while models were mid-reload --
      // exactly the "flat lighting that later self-resolves" user report. Elapsed is measured from the
      // LAST sync the previous server actually delivered (the worker stops ticking while the tab is
      // throttled, so the preserved clock freezes through the stall instead of skipping ahead).
      // Only honored when the recorded dayLength matches the resolved one -- a different world's
      // config in the same page must never inherit the previous world's clock position.
      const seed = cfg.seed
      if (seed && Number.isFinite(seed.t) && Number.isFinite(seed.atMs) && seed.dayLengthSec === dayLengthSec) {
        t = (((seed.t % 1) + 1) % 1 + (Date.now() - seed.atMs) / 1000 / dayLengthSec) % 1
        if (t < 0) t += 1
      } else {
        t = Number.isFinite(cfg.startFraction) ? ((cfg.startFraction % 1) + 1) % 1 : 0.3
      }
      broadcastIntervalSec = Number.isFinite(cfg.broadcastIntervalSec) && cfg.broadcastIntervalSec > 0 ? cfg.broadcastIntervalSec : DEFAULT_BROADCAST_INTERVAL_SEC
      _initialized = true
    }
    enabled = nowEnabled
  }

  // dt in seconds (per-tick delta, matching TickHandler's onTick(tick, dt) contract). No-op when disabled.
  function tick(dt) {
    _resolve()
    if (!enabled || !Number.isFinite(dt) || dt <= 0) return
    t += dt / dayLengthSec
    t -= Math.floor(t)
    _accumSec += dt
  }

  // Returns true (and resets the accumulator) once broadcastIntervalSec of real tick time has elapsed
  // since the last broadcast -- caller broadcasts on true. Distinct from a tick-count modulo check (the
  // existing PEER_RTT_TABLE `tick % tickRate === 0` pattern) because dayLengthSec/broadcastIntervalSec are
  // both WALL-CLOCK-second quantities, not tick-count quantities -- accumulating real dt keeps the cadence
  // correct even if tickRate ever changes per-world (already true today: tps-game runs 64Hz, WorkerEntry's
  // singleplayer default is 60Hz).
  function shouldBroadcast() {
    if (!enabled) return false
    if (_accumSec < broadcastIntervalSec) return false
    _accumSec = 0
    return true
  }

  function getSyncPayload() { return { t, dayLengthSec } }
  // Re-resolves so a caller checking isEnabled() BEFORE the first tick() (e.g. ServerHandlers.js's
  // onClientConnect join-time send, which can run before this tick's onTick if a player connects between
  // TickHandler construction and the first tick) still sees the current config rather than the
  // construction-time false default.
  function isEnabled() { _resolve(); return enabled }
  function getFraction() { return t }

  return { tick, shouldBroadcast, getSyncPayload, isEnabled, getFraction }
}
