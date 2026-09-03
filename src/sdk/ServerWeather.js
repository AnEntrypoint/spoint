// Server-authoritative weather state: the server-side counterpart to client/core/Weather.js's
// previously-only-local `type`/`intensity` state (see AGENTS.md/PRD
// weather-server-driven-state-and-multiplayer-sync). Distinct SHAPE from ServerTimeOfDay.js's model
// even though it follows the same overall pattern (lazy getConfig() accessor, ctx.serverX mirror,
// join-time backfill send): weather is a DISCRETE state (type/intensity) that changes rarely -- on
// world-config load, or a future admin/game-mode toggle -- not a continuously-advancing clock, so this
// module has no tick()/per-frame-advance step at all. It only tracks "has the state changed since the
// last broadcast" (a dirty flag), broadcasting ON CHANGE rather than on a fixed wall-clock cadence like
// TIME_OF_DAY_SYNC's ~5s heartbeat -- a weather state that never changes for the whole session should
// never re-broadcast, unlike a clock fraction which always drifts.
//
// LAZY CONFIG READ (same real bug class ServerTimeOfDay.js's header documents and fixes): takes a
// getConfig() ACCESSOR, not a pre-resolved config object, and re-reads it on every isEnabled()/
// getSyncPayload() call rather than resolving type/intensity once at construction time -- TickHandler.js
// is built inside wireServerHandlers(ctx)/WorkerEntry.js's init(), both of which run BEFORE
// server.js's boot() calls server.loadWorld(worldDef) (real multiplayer path) resolves the final
// worldDef, so a construction-time-only config read would risk the exact same permanently-disabled
// bug ServerTimeOfDay.js already found and fixed live.
//
// Enabled only when a world opts in: worldDef.terrain.weather.serverAuthoritative === true (mirrors
// terrain.timeOfDay.serverAuthoritative's own opt-in shape exactly, per this row's explicit ask for a
// world-config flag that doesn't regress the existing static-per-world singleplayer/testing default).
// Absent/false leaves every client reading its own static world-config `weather` block exactly as
// shipped (client/app.js's _ensureWeather, unchanged) -- this module is inert (isEnabled()/
// getSyncPayload() both no-op-safe, setState() still callable but broadcast is gated on isEnabled() by
// the caller) when disabled.
export function createServerWeather(getConfig) {
  const _getConfig = typeof getConfig === 'function' ? getConfig : () => null
  let enabled = false
  let type = 'clear'
  let intensity = 1
  let _initialized = false
  let _dirty = false

  function _clampType(t) { return (t === 'rain' || t === 'snow' || t === 'clear') ? t : 'clear' }
  function _clampIntensity(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1 }

  function _resolve() {
    const cfg = _getConfig()
    const nowEnabled = !!(cfg && cfg.serverAuthoritative === true)
    if (nowEnabled && !_initialized) {
      // First activation: seed type/intensity from the config that just turned this on (the world's own
      // `weather` block, e.g. { type:'rain', intensity:0.6, serverAuthoritative:true }) -- mirrors
      // ServerTimeOfDay.js's _resolve() seeding t/dayLengthSec only once on first activation, not
      // re-seeding every call (a later in-session setState() call, e.g. from a future admin/game-mode
      // toggle, must not be silently overwritten by re-reading the unchanged static config next tick).
      type = _clampType(cfg.type)
      intensity = _clampIntensity(cfg.intensity)
      _initialized = true
      _dirty = true // first activation always has something new to broadcast (the initial state itself)
    }
    enabled = nowEnabled
  }

  // Explicit state change (the real "server decides weather, not each client" primitive this row asks
  // for -- callable from EditorHandlers.js's future admin/game-mode weather-toggle handler, or directly
  // by an app's server-side onTick via ctx.serverWeather). No-op when disabled: a world that never opted
  // into serverAuthoritative mode has no server-side weather state to mutate, matching
  // ServerTimeOfDay.js's own tick()-is-a-no-op-when-disabled discipline.
  function setState(nextType, nextIntensity) {
    _resolve()
    if (!enabled) return false
    const t = nextType === undefined ? type : _clampType(nextType)
    const i = nextIntensity === undefined ? intensity : _clampIntensity(nextIntensity)
    if (t === type && i === intensity) return false
    type = t; intensity = i; _dirty = true
    return true
  }

  // Returns true (and clears the dirty flag) exactly once per real state change -- the caller broadcasts
  // on true. Distinct from ServerTimeOfDay's shouldBroadcast (a wall-clock-interval poll): this is a
  // pure change-detector, since re-sending an unchanged weather state on a timer would be pointless
  // bandwidth for a value that can go whole sessions without changing.
  function shouldBroadcast() {
    _resolve()
    if (!enabled || !_dirty) return false
    _dirty = false
    return true
  }

  function getSyncPayload() { _resolve(); return { type, intensity } }
  // Re-resolves so a caller checking isEnabled() BEFORE any setState()/shouldBroadcast() call (e.g.
  // ServerHandlers.js's onClientConnect join-time send, which can run before this world's first tick)
  // still sees the current config rather than the construction-time false default -- same rationale as
  // ServerTimeOfDay.js's own isEnabled().
  function isEnabled() { _resolve(); return enabled }
  function getType() { _resolve(); return type }
  function getIntensity() { _resolve(); return intensity }

  return { setState, shouldBroadcast, getSyncPayload, isEnabled, getType, getIntensity }
}
