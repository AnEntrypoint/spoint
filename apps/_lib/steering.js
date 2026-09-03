// defineSteering(spec, appCtx) -> a lightweight scripted-unit movement helper (seek / arrive toward a
// target, optional waypoint-follow, optional separation from peers, optional terrain ground-clamp).
// Every game with scripted units (tower-defense minions, MOBA lanes, wave-defense, escort, pet-follow)
// hand-rolls this; here it produces a velocity / next-position once per tick so the app just applies it.
// Pure kinematics -- no physics/wire touch; the caller decides whether to write ctx.entity.position or
// drive a kinematic body with the returned velocity.
//
// spec = {
//   speed?: number,                    // max move speed m/s (default 3)
//   arriveRadius?: number,             // slow-then-stop distance from target (default 0.5)
//   separation?: number,               // push-apart radius from peers (0 = off, default 0)
//   clampToTerrain?: boolean,          // snap Y to ctx.terrainHeightAt(x,z) each step (default false)
//   yOffset?: number,                  // added to the clamped terrain height (feet->origin, default 0)
// }
// Returns { step(from, target, dt, peers?) -> { position, velocity, arrived },
//           followPath(from, waypoints, dt, state, peers?) -> { position, velocity, done, state } }.

import { createComponentPool } from './ComponentPool.js'

// Data-oriented storage: the per-instance CONFIG (speed/arriveRadius/separation/yOffset -- immutable
// after creation, no setter exists on the public API) lives in shared contiguous columns addressed by
// an opaque slot, instead of each defineSteering() call being its own closure with its own captured
// constants scattered across the heap. clampToTerrain is a 0/1 column for the same reason (SoA
// uniformity); sep2 is NOT its own column, it is separation*separation recomputed from the separation
// column on demand (derived value, storing it separately would just be a second copy that could drift
// out of sync with separation).
//
// Columns are 'f64' (Float64Array), not 'f32': a game designer's literal config decimal (yOffset:0.9,
// arriveRadius:0.5, ...) is read on EVERY step() call and feeds directly into the returned position --
// storing it in an f32 column perturbs it by ~1e-8 per read (Float32Array's ~7-significant-digit
// precision), which live-diffed as a real, compounding position drift across ticks (see
// ComponentPool.js's header comment for the general precision caveat this discovery produced). Unlike
// health.js's hp/max/alive (already integer-range values, HEALTH_SCHEMA itself only ever wire-encodes
// them as u16/bool, so f32's precision margin is moot there), steering's config has no such native
// low-precision contract, so 'f64' is the correct column kind here -- the DOD win is still real
// (contiguous per-field storage instead of N scattered closures), just without the byte-width halving.
// step()/followPath() themselves stay pure functions of their arguments (from/target/dt/peers) --
// there is no PER-TICK mutable numeric state to pool here (unlike health.js's hp/alive/lastHitAt);
// followPath's cursor is already caller-owned (`state`), not instance-owned.
const _pool = createComponentPool({ fields: { speed: 'f64', arriveRadius: 'f64', separation: 'f64', clampToTerrain: 'f64', yOffset: 'f64', useNavCost: 'f64' } })
// Cached column references + the epoch they were captured at -- see health.js/ComponentPool.js's
// header comment for why (plain fixed-length typed arrays are ~2.5x faster per-access than the
// identity-stable resizable-ArrayBuffer alternative this module tried first and reverted; every hot-path
// entry point calls `_sync()` first -- a single integer compare in the common case, only re-fetching the
// five column references on the rare epoch mismatch that means a grow() just happened).
let _speed = _pool.column('speed'), _arriveRadius = _pool.column('arriveRadius'), _separation = _pool.column('separation')
let _clampToTerrain = _pool.column('clampToTerrain'), _yOffset = _pool.column('yOffset'), _useNavCost = _pool.column('useNavCost')
let _epoch = _pool.epoch
function _sync() {
  if (_epoch === _pool.epoch) return
  _speed = _pool.column('speed'); _arriveRadius = _pool.column('arriveRadius'); _separation = _pool.column('separation')
  _clampToTerrain = _pool.column('clampToTerrain'); _yOffset = _pool.column('yOffset'); _useNavCost = _pool.column('useNavCost')
  _epoch = _pool.epoch
}

// _clampY/_stepImpl are MODULE-LEVEL functions taking (slot, appCtx, ...) explicitly, not per-instance
// closures -- V8 JITs and inline-caches ONE shared function body across every defineSteering() instance
// this way, instead of N structurally-identical-but-distinct closures each needing their own
// optimization (the shape every OLD per-entity-closure instance already had, and which a naive
// per-instance _clampY closure inside defineSteering would have re-introduced even with pool-backed
// storage underneath). Live-measured: this shared-function-body form is what actually closes the gap to
// the OO-closure baseline for the hot per-tick step() path (see AGENTS.md commit for exact numbers) --
// keeping _clampY as a per-instance closure (an earlier version of this file) left a real ~16%
// regression on the table despite the pool-backed storage being correct and grow-safe.
function _clampY(slot, appCtx, x, y, z) {
  if (_clampToTerrain[slot] !== 1 || typeof appCtx.terrainHeightAt !== 'function') return y
  const h = appCtx.terrainHeightAt(x, z)
  return (typeof h === 'number' && Number.isFinite(h)) ? h + _yOffset[slot] : y
}

function _stepImpl(slot, appCtx, from, target, dt, peers) {
  _sync()
  const speed = _speed[slot]
  const arriveRadius = _arriveRadius[slot]
  const separation = _separation[slot]
  const sep2 = separation * separation
  const fx = from[0], fy = from[1], fz = from[2]
  let vx = target[0] - fx, vz = target[2] - fz
  const dist = Math.hypot(vx, vz)
  let sp = speed
  if (dist <= arriveRadius) sp = dist > 1e-4 ? speed * (dist / arriveRadius) : 0   // arrive: ease to a stop
  if (_useNavCost[slot] === 1 && typeof appCtx.navCostAt === 'function' && dist > 1e-4) {
    const cost = appCtx.navCostAt(fx, fz)
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) sp = sp / cost
  }
  if (dist > 1e-4) { vx = (vx / dist) * sp; vz = (vz / dist) * sp } else { vx = 0; vz = 0 }
  // separation: sum push-away from nearby peers
  if (separation > 0 && peers && peers.length) {
    let sx = 0, sz = 0, n = 0
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i]; const dx = fx - p[0], dz = fz - p[2]; const d2 = dx * dx + dz * dz
      if (d2 > 1e-6 && d2 < sep2) { const d = Math.sqrt(d2); sx += (dx / d) * (1 - d / separation); sz += (dz / d) * (1 - d / separation); n++ }
    }
    if (n) { vx += sx * speed; vz += sz * speed }
  }
  const nx = fx + vx * dt, nz = fz + vz * dt
  const ny = _clampY(slot, appCtx, nx, fy + (vx === 0 && vz === 0 ? 0 : 0), nz)
  return { position: [nx, ny, nz], velocity: [vx, 0, vz], arrived: dist <= arriveRadius }
}

export function defineSteering(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[steering] appCtx is required')
  if (spec.speed != null && (typeof spec.speed !== 'number' || !Number.isFinite(spec.speed) || spec.speed < 0)) {
    throw new TypeError('[steering] speed must be a non-negative finite number')
  }
  const slot = _pool.alloc()
  _sync() // alloc() may have just grown the pool -- pick up the fresh column references before writing initial config
  _speed[slot] = spec.speed ?? 3
  _arriveRadius[slot] = spec.arriveRadius ?? 0.5
  _separation[slot] = spec.separation ?? 0
  _clampToTerrain[slot] = spec.clampToTerrain ? 1 : 0
  _yOffset[slot] = spec.yOffset ?? 0
  _useNavCost[slot] = spec.useNavCost ? 1 : 0
  let _disposed = false

  const steering = {
    // One seek/arrive step from `from` toward `target`. Optional `peers` (array of [x,y,z]) add separation.
    step(from, target, dt, peers) { return _stepImpl(slot, appCtx, from, target, dt, peers) },
    // Follow a list of [x,y,z] waypoints. `state` is a caller-owned { i:0 } cursor (returned updated).
    followPath(from, waypoints, dt, state, peers) {
      const st = state || { i: 0 }
      if (!waypoints || st.i >= waypoints.length) return { position: [...from], velocity: [0, 0, 0], done: true, state: st }
      const r = _stepImpl(slot, appCtx, from, waypoints[st.i], dt, peers)
      const arriveRadius = _arriveRadius[slot]
      if (r.arrived && Math.hypot(waypoints[st.i][0] - r.position[0], waypoints[st.i][2] - r.position[2]) <= arriveRadius) st.i++
      return { position: r.position, velocity: r.velocity, done: st.i >= waypoints.length, state: st }
    },
  }
  // Release the pool slot when this entity's app is detached -- see health.js's identical disposer
  // wiring comment for why this is the one always-fired per-instance lifecycle hook available.
  if (typeof appCtx._registerDisposer === 'function') {
    appCtx._registerDisposer(() => { if (_disposed) return; _disposed = true; _pool.free(slot) })
  }
  return steering
}

export default defineSteering
