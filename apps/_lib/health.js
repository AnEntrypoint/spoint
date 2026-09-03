// defineHealth(spec, appCtx) -> a reusable HP / damage / death / respawn primitive. Every game that
// has damageable things (wave-defense enemies, laser-tag players, boss-raid bosses, defend-the-core,
// deathmatch) re-implements the same clamp-hp / fire-on-death / respawn loop; this wraps it once so
// core / barricade / enemy / player all share ONE implementation. Pure state machine -- the caller
// decides when to damage() and reads .alive / .hp; nothing here touches physics or the wire.
//
// spec = {
//   max: number,                       // full HP (required, > 0)
//   hp?: number,                       // starting HP (defaults to max)
//   onDamage?(ctx, { amount, hp, max, source }),  // fired after each non-fatal damage
//   onDeath?(ctx, { source }),         // fired once when hp reaches 0
//   onRespawn?(ctx),                   // fired when respawn() restores hp
//   invulnMs?: number,                 // i-frames after taking damage (default 0)
// }
// Returns { hp, max, alive, damage(amount, source?), heal(amount), kill(source?), respawn(hp?), setMax(m) }.
//
// HEALTH_SCHEMA: the declarative replicated-field schema for this component (see
// apps/_lib/ComponentSchema.js), consumed by SnapshotEncoder's schema-driven custom-field codec so a
// caller mirroring a health instance's state into entity.custom (e.g. entity.custom.health = {hp, max,
// alive}) gets compact typed wire encoding instead of a raw JSON blob. hp/max are u16 (health totals
// comfortably fit 0-65535, matching this component's own Number-only contract -- no fractional HP is
// ever exposed by defineHealth's public API); alive is a 1-byte bool.

import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'
import { createComponentPool } from './ComponentPool.js'

export const HEALTH_SCHEMA = defineComponentSchema({
  hp: { type: 'u16', tier: 'full' },
  max: { type: 'u16', tier: 'full' },
  alive: { type: 'bool', tier: 'full' },
})
registerComponentSchema('health', HEALTH_SCHEMA)

// Data-oriented storage: every live defineHealth() instance across the WHOLE process shares these
// five columns (hp/max/alive/lastHitAt/invulnMs), addressed by an opaque integer slot, instead of each
// instance being its own heap object + closure cells scattered across the heap in allocation order.
// SoA layout so a future batch pass (e.g. "tick every alive entity's regen") can stream just the
// columns it needs. invulnMs is IMMUTABLE after creation (no setter on the public API) but still lives
// in a column, not a captured closure constant -- see below for why.
//
// lastHitAt is 'f64' (Float64Array), not 'f32': it stores a Date.now() ms epoch (13 digits), and
// Float32Array's ~7 significant digits truncates that by tens of thousands of ms -- confirmed live,
// see ComponentPool.js's header comment -- which silently breaks invulnMs i-frame gating.
const _pool = createComponentPool({ fields: { hp: 'f32', max: 'f32', alive: 'f32', lastHitAt: 'f64', invulnMs: 'f64' } })
// Cached column references + the epoch they were captured at -- see ComponentPool.js's header comment
// for why (plain fixed-length typed arrays are ~2.5x faster per-access than the identity-stable
// resizable-ArrayBuffer alternative this module tried first and reverted; plain arrays get swapped out
// wholesale on grow(), so every hot-path entry point calls `_sync()` first -- a single integer compare
// in the common case where no grow happened since the last call, only re-fetching the column
// references on the rare epoch mismatch).
let _hp = _pool.column('hp'), _max = _pool.column('max'), _alive = _pool.column('alive')
let _lastHitAt = _pool.column('lastHitAt'), _invulnMs = _pool.column('invulnMs')
let _epoch = _pool.epoch
function _sync() {
  if (_epoch === _pool.epoch) return
  _hp = _pool.column('hp'); _max = _pool.column('max'); _alive = _pool.column('alive')
  _lastHitAt = _pool.column('lastHitAt'); _invulnMs = _pool.column('invulnMs')
  _epoch = _pool.epoch
}

// damage/heal/kill/respawn/setMax are MODULE-LEVEL functions taking (slot, spec, appCtx, ...)
// explicitly, not per-instance closures -- V8 JITs and inline-caches ONE shared function body across
// every defineHealth() instance this way, instead of N structurally-identical-but-distinct closures
// each needing their own optimization (the exact shape every OLD per-entity-closure instance already
// had, which an earlier version of this pool-backed rewrite still had by putting these bodies as
// closures inside defineHealth -- measured live to leave a real regression on the table vs this shared
// form; see AGENTS.md commit for exact numbers). `spec`/`appCtx` are still per-instance (the onDamage/
// onDeath/onRespawn callbacks + terrain lookup genuinely differ per instance) so they're passed as
// plain arguments, cheap since they're just object-reference passes, not per-access indirection.

function _damageImpl(slot, spec, appCtx, amount, source) {
  _sync()
  if (_alive[slot] !== 1) return _hp[slot]
  if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _hp[slot]
  const now = Date.now()
  const invulnMs = _invulnMs[slot]
  if (invulnMs > 0 && now - _lastHitAt[slot] < invulnMs) return _hp[slot]
  _lastHitAt[slot] = now
  const newHp = Math.max(0, _hp[slot] - amount)
  _hp[slot] = newHp
  if (newHp <= 0) {
    _alive[slot] = 0
    // onDeath may call respawn()/heal()/etc SYNCHRONOUSLY on this SAME instance (e.g. combat-bot's
    // _onDeath calls ctx.state.health.respawn() immediately) -- matching the OLD closure-based
    // implementation's `return _hp` (a fresh read of the live closure variable, which a synchronous
    // respawn-inside-onDeath already mutated by the time damage() returns), the return value below
    // reads _hp[slot] FRESH, not the `newHp` local captured before onDeath ran. Returning the stale
    // local here was a REAL bug caught live (bot appeared to stay at 0 HP to any caller reading the
    // return value, even though the instance's actual .hp getter correctly showed the post-respawn
    // value) -- see AGENTS.md commit for the live reproduction.
    if (typeof spec.onDeath === 'function') spec.onDeath(appCtx, { source })
  } else if (typeof spec.onDamage === 'function') {
    spec.onDamage(appCtx, { amount, hp: newHp, max: _max[slot], source })
  }
  _sync() // onDeath/onDamage may have triggered a grow() on THIS or another component's pool via reentrant alloc()
  return _hp[slot]
}

function _healImpl(slot, amount) {
  _sync()
  if (_alive[slot] !== 1) return _hp[slot]
  if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _hp[slot]
  const newHp = Math.min(_max[slot], _hp[slot] + amount)
  _hp[slot] = newHp
  return newHp
}

function _killImpl(slot, spec, appCtx, source) {
  _sync()
  if (_alive[slot] !== 1) return
  _hp[slot] = 0; _alive[slot] = 0
  if (typeof spec.onDeath === 'function') spec.onDeath(appCtx, { source })
}

function _respawnImpl(slot, spec, appCtx, hp) {
  _sync()
  const max = _max[slot]
  const newHp = (typeof hp === 'number' && Number.isFinite(hp)) ? Math.max(0, Math.min(max, hp)) : max
  _hp[slot] = newHp
  const alive = newHp > 0
  _alive[slot] = alive ? 1 : 0
  _lastHitAt[slot] = -Infinity
  // onRespawn may reentrantly call damage()/heal()/etc SYNCHRONOUSLY on this SAME instance -- same fresh
  // -read-after-callback discipline as _damageImpl's onDeath handling above (matches OLD's `return _hp`,
  // a live closure-variable read that a reentrant mutation would already reflect).
  if (alive && typeof spec.onRespawn === 'function') spec.onRespawn(appCtx)
  _sync()
  return _hp[slot]
}

function _setMaxImpl(slot, m) {
  _sync()
  if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
    _max[slot] = m
    if (_hp[slot] > m) _hp[slot] = m
  }
  return _max[slot]
}

export function defineHealth(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[health] appCtx is required')
  if (typeof spec.max !== 'number' || !Number.isFinite(spec.max) || spec.max <= 0) {
    throw new TypeError('[health] max must be a positive finite number')
  }
  if (spec.invulnMs != null && (typeof spec.invulnMs !== 'number' || !Number.isFinite(spec.invulnMs) || spec.invulnMs < 0)) {
    throw new TypeError('[health] invulnMs must be a non-negative finite number')
  }

  const slot = _pool.alloc()
  _sync() // alloc() may have just grown the pool -- pick up the fresh column references before writing initial state
  const startHp = (typeof spec.hp === 'number' && Number.isFinite(spec.hp)) ? Math.max(0, Math.min(spec.max, spec.hp)) : spec.max
  _hp[slot] = startHp
  _max[slot] = spec.max
  _alive[slot] = startHp > 0 ? 1 : 0
  _lastHitAt[slot] = -Infinity
  _invulnMs[slot] = spec.invulnMs ?? 0
  let _disposed = false

  const health = {
    get hp() { _sync(); return _hp[slot] },
    get max() { _sync(); return _max[slot] },
    get alive() { _sync(); return _alive[slot] === 1 },
    get fraction() { _sync(); const max = _max[slot]; return max > 0 ? _hp[slot] / max : 0 },
    // Apply damage. No-op while dead or within i-frames. Fires onDeath once at 0, else onDamage.
    damage(amount, source = null) { return _damageImpl(slot, spec, appCtx, amount, source) },
    // Restore HP (clamped to max); does not revive a dead target -- use respawn() for that.
    heal(amount) { return _healImpl(slot, amount) },
    // Force death regardless of remaining HP (fires onDeath once).
    kill(source = null) { return _killImpl(slot, spec, appCtx, source) },
    // Revive to `hp` (default max) and fire onRespawn.
    respawn(hp) { return _respawnImpl(slot, spec, appCtx, hp) },
    setMax(m) { return _setMaxImpl(slot, m) },
  }
  // Release the pool slot when this entity's app is detached (destroyEntity, hot-reload reattach,
  // editor detach) so a churny spawn/despawn loop doesn't leak slots. Guarded single-shot: detachApp
  // is the only caller, but defensive against any future direct-call path.
  if (typeof appCtx._registerDisposer === 'function') {
    appCtx._registerDisposer(() => { if (_disposed) return; _disposed = true; _pool.free(slot) })
  }
  return health
}

export default defineHealth
