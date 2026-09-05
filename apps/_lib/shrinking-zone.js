// defineShrinkingZone(spec, appCtx) -> a generic shrinking-boundary ("battle royale ring") primitive:
// a circular safe zone centered at a configurable point that shrinks over time on a configurable
// curve (continuous linear/eased shrink, or discrete stepped phases like real battle-royale games),
// damages and/or pushes back any player or dynamic entity caught outside the current radius, and owns
// a visual boundary entity (a flat ring-like disc, spawned via ctx.world.spawnChild) so the caller does
// not have to hand-roll a marker mesh. No jello-royale-specific prototype code exists in this repo to
// generalize from (deleted with the rest of that unmerged work) -- built fresh from the
// build-shrinking-zone-primitive requirements, following the createDestructible/definePickup
// factory-with-tick() shape used throughout apps/_lib.
//
// Visual ring: spawns one companion entity (app: 'shrinking-zone-ring', see
// apps/shrinking-zone-ring/index.js) carrying custom.mesh = 'cylinder' -- a thin flat disc baked as a
// fixed r=0.5 unit geometry at spawn (client/EntityLoader.js bakes custom.r into geometry ONCE, never
// rebuilds it -- the established convention every custom-mesh primitive in this codebase follows). The
// ring's LIVE world-space radius is instead tracked purely via entity.scale.x/scale.z (== liveRadius /
// 0.5), mutated every tick through the live entity reference returned by ctx.world.getEntity(id)
// (entities are plain objects read straight into the snapshot encoder, so no extra sync path is needed
// -- see src/apps/AppRuntime.js:getEntity). No new client-side rendering code was added: 'cylinder' is
// an existing MESH_BUILDERS kind in client/EntityLoader.js.
//
// Damage/push mechanic: per spec.outsidePenalty, an entity/player outside the current radius either
// takes damage-per-second (health ramp, matching tps-game's own health-mutation pattern), gets pushed
// back toward the zone center (a continuous dt-scaled radial force -- not a one-shot impulse -- applied
// via direct state.velocity mutation for players, mirroring tps-game/server.js's own
// knockback-by-direct-velocity-mutation pattern, or via ctx.world.applyImpulse per-tick for dynamic
// entities), or both.
//
// Shrink curve: either 'linear' (a single continuous shrink from startRadius to endRadius over
// durationSec) or 'phases' (an explicit stepped list of { radius, holdSec, shrinkSec } phases -- hold at
// a radius, then shrink to the next phase's radius over shrinkSec, matching real battle-royale "circle
// phases"). Both curves converge on the same live `radius` getter/`center` so callers and the damage
// scan never need to know which curve mode is active.
//
// Call zone.tick(dt) once per server tick from the owning app's update(ctx, dt).
//
// Integration note: 'shrinking-zone-ring' is only ever spawned dynamically via ctx.world.spawnChild,
// never referenced in a world def's entities[] -- singleplayer's BrowserServer only prefetches apps
// named in worldDef.entities[].app/placeableApps/trustedApps, so any world def wiring up
// defineShrinkingZone (with showRing !== false) must add 'shrinking-zone-ring' to that world's
// placeableApps (see client/singleplayer-world.json / apps/world/tps-game.js for the existing pattern),
// or the ring silently fails to attach server-side app logic (loud console.error, but degrades to a
// static, non-tracking entity rather than a hard crash).

function _isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function _isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v) }

function _isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(_isFiniteNum) }

const VALID_PENALTIES = new Set(['damage', 'push', 'both'])

function _validatePhase(p, i) {
  if (!_isPlainObject(p)) throw new TypeError(`[shrinking-zone] phases[${i}] must be an object`)
  if (!_isFiniteNum(p.radius) || p.radius < 0) throw new TypeError(`[shrinking-zone] phases[${i}].radius must be a non-negative finite number`)
  if (p.holdSec != null && (!_isFiniteNum(p.holdSec) || p.holdSec < 0)) throw new TypeError(`[shrinking-zone] phases[${i}].holdSec must be a non-negative finite number`)
  if (p.shrinkSec != null && (!_isFiniteNum(p.shrinkSec) || p.shrinkSec < 0)) throw new TypeError(`[shrinking-zone] phases[${i}].shrinkSec must be a non-negative finite number`)
}

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[shrinking-zone] spec must be an object')
  const s = spec || {}
  if (s.center != null && !_isVec3(s.center)) throw new TypeError('[shrinking-zone] center must be a [x,y,z] finite-number array')
  if (s.curve != null && s.curve !== 'linear' && s.curve !== 'phases') throw new TypeError('[shrinking-zone] curve must be "linear" or "phases"')
  const curve = s.curve ?? 'linear'
  if (curve === 'linear') {
    if (s.startRadius != null && (!_isFiniteNum(s.startRadius) || s.startRadius <= 0)) throw new TypeError('[shrinking-zone] startRadius must be a positive finite number')
    if (s.endRadius != null && (!_isFiniteNum(s.endRadius) || s.endRadius < 0)) throw new TypeError('[shrinking-zone] endRadius must be a non-negative finite number')
    if (s.durationSec != null && (!_isFiniteNum(s.durationSec) || s.durationSec <= 0)) throw new TypeError('[shrinking-zone] durationSec must be a positive finite number')
    const start = s.startRadius ?? 100, end = s.endRadius ?? 5
    if (end > start) throw new TypeError('[shrinking-zone] endRadius must not exceed startRadius')
  } else {
    if (!Array.isArray(s.phases) || s.phases.length === 0) throw new TypeError('[shrinking-zone] phases must be a non-empty array when curve is "phases"')
    s.phases.forEach(_validatePhase)
  }
  if (s.startDelaySec != null && (!_isFiniteNum(s.startDelaySec) || s.startDelaySec < 0)) throw new TypeError('[shrinking-zone] startDelaySec must be a non-negative finite number')
  if (s.outsidePenalty != null && !VALID_PENALTIES.has(s.outsidePenalty)) throw new TypeError('[shrinking-zone] outsidePenalty must be "damage", "push", or "both"')
  if (s.damagePerSec != null && (!_isFiniteNum(s.damagePerSec) || s.damagePerSec < 0)) throw new TypeError('[shrinking-zone] damagePerSec must be a non-negative finite number')
  if (s.pushForce != null && (!_isFiniteNum(s.pushForce) || s.pushForce < 0)) throw new TypeError('[shrinking-zone] pushForce must be a non-negative finite number')
  if (s.affectDynamicEntities != null && typeof s.affectDynamicEntities !== 'boolean') throw new TypeError('[shrinking-zone] affectDynamicEntities must be a boolean')
  if (s.showRing != null && typeof s.showRing !== 'boolean') throw new TypeError('[shrinking-zone] showRing must be a boolean')
  if (s.ringColor != null && (!Number.isInteger(s.ringColor) || s.ringColor < 0)) throw new TypeError('[shrinking-zone] ringColor must be a non-negative integer (hex color)')
  if (s.ringHeight != null && (!_isFiniteNum(s.ringHeight) || s.ringHeight <= 0)) throw new TypeError('[shrinking-zone] ringHeight must be a positive finite number')
  if (s.onPhaseChange != null && typeof s.onPhaseChange !== 'function') throw new TypeError('[shrinking-zone] onPhaseChange must be a function')
  if (s.onComplete != null && typeof s.onComplete !== 'function') throw new TypeError('[shrinking-zone] onComplete must be a function')
}

// linear ease-free interpolation, t clamped to [0,1]
function _lerp(a, b, t) {
  const ct = t < 0 ? 0 : t > 1 ? 1 : t
  return a + (b - a) * ct
}

// spec = {
//   center?: [x,y,z]                -- zone center, world space (default [0,0,0])
//   curve?: 'linear' | 'phases'     -- shrink mode (default 'linear')
//   // curve === 'linear':
//   startRadius?: number            -- initial safe radius (default 100)
//   endRadius?: number               -- final safe radius, must be <= startRadius (default 5)
//   durationSec?: number             -- seconds for the full linear shrink (default 120)
//   // curve === 'phases': explicit stepped battle-royale-style circle phases
//   phases?: [{ radius, holdSec?, shrinkSec? }]  -- radius at the END of this phase's shrink; the
//                                      zone starts at phases[0].radius, holds holdSec, then shrinks
//                                      to phases[1].radius over phases[1].shrinkSec, and so on.
//   startDelaySec?: number          -- seconds before shrinking begins at all (default 0)
//   outsidePenalty?: 'damage'|'push'|'both'  -- what happens to an out-of-bounds target (default 'damage')
//   damagePerSec?: number           -- health drained per second while outside (default 5)
//   pushForce?: number              -- radial push-back acceleration (m/s^2, applied continuously via
//                                      dt-scaling for as long as the target stays outside) (default 8)
//   affectDynamicEntities?: boolean -- also scan/penalize non-player dynamic entities via
//                                      ctx.world.nearby, not just players (default false)
//   showRing?: boolean              -- spawn+maintain the visual boundary ring entity (default true)
//   ringColor?: number              -- hex color for the ring mesh (default 0x00ffff)
//   ringHeight?: number             -- ring disc thickness in meters (default 0.2)
//   onPhaseChange?: (ctx, zone) => void  -- fires once curve==='phases' advances to a new phase
//   onComplete?: (ctx, zone) => void     -- fires once when the shrink reaches its final radius
// }
export function defineShrinkingZone(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[shrinking-zone] appCtx is required')

  const center = spec.center ? [...spec.center] : [0, 0, 0]
  const curve = spec.curve ?? 'linear'
  const startDelaySec = spec.startDelaySec ?? 0
  const outsidePenalty = spec.outsidePenalty ?? 'damage'
  const damagePerSec = spec.damagePerSec ?? 5
  const pushForce = spec.pushForce ?? 8
  const affectDynamicEntities = !!spec.affectDynamicEntities
  const showRing = spec.showRing ?? true
  const ringColor = spec.ringColor ?? 0x00ffff
  const ringHeight = spec.ringHeight ?? 0.2

  // linear-mode bounds
  const startRadius = spec.startRadius ?? 100
  const endRadius = spec.endRadius ?? 5
  const durationSec = spec.durationSec ?? 120

  // phases-mode bounds
  const phases = curve === 'phases' ? spec.phases.map(p => ({ radius: p.radius, holdSec: p.holdSec ?? 0, shrinkSec: p.shrinkSec ?? 30 })) : null

  let _elapsed = 0
  let _radius = curve === 'phases' ? phases[0].radius : startRadius
  let _phaseIndex = 0
  let _completed = false
  let _ringId = null

  function _ringEntityId() { return `${appCtx.entity.id}_zone_ring` }

  function _spawnRing() {
    if (!showRing || _ringId) return
    const id = _ringEntityId()
    appCtx.world.spawnChild(id, {
      position: [center[0], center[1], center[2]],
      bodyType: 'static',
      app: 'shrinking-zone-ring',
      config: { r: _radius, h: ringHeight, color: ringColor }
    })
    _ringId = id
  }

  function _syncRing() {
    if (!showRing || !_ringId) return
    const e = appCtx.world.getEntity(_ringId)
    if (!e) return
    e.position[0] = center[0]; e.position[1] = center[1]; e.position[2] = center[2]
    // ring geometry is a fixed r=0.5 unit disc (see apps/shrinking-zone-ring/index.js); scale.x/z ==
    // liveRadius / 0.5 is the only live lever for its world-space size (custom.r is baked once, never
    // rebuilt post-spawn).
    const s = _radius / 0.5
    e.scale[0] = s; e.scale[2] = s
  }

  function _despawnRing() {
    if (!_ringId) return
    appCtx.world.destroy(_ringId)
    _ringId = null
  }

  function _computeLinearRadius(activeSec) {
    if (durationSec <= 0) return endRadius
    return _lerp(startRadius, endRadius, activeSec / durationSec)
  }

  // returns the radius for the given elapsed-since-shrink-start time under 'phases' mode, and
  // advances _phaseIndex as boundaries are crossed (fires onPhaseChange on each advance). _phaseIndex
  // semantics: the index of the phase currently being held at, OR (once shrinking away from it has
  // started) the index of the phase being shrunk TOWARD -- i.e. it always names "where we are/heading",
  // never "where we started this segment from". This must advance to i+1, not i, the moment the shrink
  // window for i->i+1 begins, or a shrink-in-progress never reports as having left phase i (a real bug
  // caught by a live re-tick regression check: ticking repeatedly mid-shrink produced 0 onPhaseChange
  // fires instead of the expected 1 transition-into-shrink event).
  function _computePhaseRadius(activeSec) {
    let acc = 0
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i]
      const holdEnd = acc + ph.holdSec
      const shrinkEnd = holdEnd + (i + 1 < phases.length ? phases[i + 1].shrinkSec : 0)
      if (activeSec < holdEnd) {
        if (i !== _phaseIndex) { _phaseIndex = i; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
        return ph.radius
      }
      if (i + 1 < phases.length && activeSec < shrinkEnd) {
        if (i + 1 !== _phaseIndex) { _phaseIndex = i + 1; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
        const t = (activeSec - holdEnd) / Math.max(1e-6, phases[i + 1].shrinkSec)
        return _lerp(ph.radius, phases[i + 1].radius, t)
      }
      acc = shrinkEnd
    }
    const last = phases.length - 1
    if (_phaseIndex !== last) { _phaseIndex = last; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
    return phases[last].radius
  }

  function _isFinalRadiusReached() {
    // radius-value-based for both curves (not _phaseIndex for 'phases': _phaseIndex advances to the
    // final phase as soon as the shrink TOWARD it begins, which is before the final radius is actually
    // reached -- checking phaseIndex here would fire onComplete mid-shrink instead of on arrival).
    return curve === 'linear' ? _radius <= endRadius : _radius <= phases[phases.length - 1].radius
  }

  // dt-scaled continuous radial push (a per-second rate applied over this tick's dt), not a one-shot
  // impulse -- appropriate for "keep shoving while outside," unlike tps-game's event-triggered
  // one-shot hitKnockback. Directly mutates vel in place (matching tps-game/server.js's own
  // direct-velocity-mutation knockback pattern) when vel is provided.
  // Closure-level scratch: _penalizeTarget returns a boolean and publishes the push direction through
  // _outDirX/_outDirZ instead of allocating a fresh result object per scanned target per tick (the two
  // former return literals were also two distinct object shapes at the same read site). Non-re-entrant
  // by construction: the only callers are the two sequential loops below, each of which reads the
  // scratch immediately after its own call and before the next; neither players.send nor
  // world.applyImpulse re-enters tick().
  let _outDirX = 0, _outDirZ = 0
  const _impulse = [0, 0, 0]
  function _penalizeTarget(pos, vel, dt, applyPush) {
    const dx = pos[0] - center[0], dz = pos[2] - center[2]
    const dist = Math.hypot(dx, dz)
    if (dist <= _radius) return false
    const dirX = dist > 1e-6 ? -dx / dist : 0, dirZ = dist > 1e-6 ? -dz / dist : 0
    if (applyPush && vel) { vel[0] += dirX * pushForce * dt; vel[2] += dirZ * pushForce * dt }
    _outDirX = dirX; _outDirZ = dirZ
    return true
  }

  function _scanPlayers(dt) {
    const applyDamage = outsidePenalty === 'damage' || outsidePenalty === 'both'
    const applyPush = outsidePenalty === 'push' || outsidePenalty === 'both'
    for (const player of appCtx.players.getAll()) {
      const st = player.state; if (!st || !st.position) continue
      if ((st.health ?? 1) <= 0) continue
      if (!_penalizeTarget(st.position, st.velocity, dt, applyPush)) continue
      if (applyDamage && damagePerSec > 0) {
        const before = st.health ?? 100
        st.health = Math.max(0, before - damagePerSec * dt)
        if (st.health <= 0 && before > 0) appCtx.players.send(player.id, { type: 'zone_death' })
      }
      // supplementary client-feedback signal (e.g. camera shake/edge vignette) alongside the already-
      // applied server-authoritative velocity mutation above -- not the sole push mechanism.
      if (applyPush && pushForce > 0) appCtx.players.send(player.id, { type: 'zone_push', dirX: _outDirX, dirZ: _outDirZ })
    }
  }

  function _scanDynamicEntities(dt) {
    if (!affectDynamicEntities) return
    const applyPush = outsidePenalty === 'push' || outsidePenalty === 'both'
    if (!applyPush) return
    // wide-net proximity query at a radius generous enough to cover anything currently outside the
    // shrinking zone but still reasonably nearby; a global unbounded scan is not available via ctx.world.
    const scanRadius = Math.max(_radius * 3, _radius + 200)
    const nearbyIds = appCtx.world.nearby(center, scanRadius)
    for (const id of nearbyIds) {
      if (id === appCtx.entity.id || id === _ringId) continue
      const e = appCtx.world.getEntity(id)
      if (!e || e.bodyType !== 'dynamic' || !e.position) continue
      if (!_penalizeTarget(e.position, null, dt, false)) continue
      if (pushForce > 0) {
        // dynamic entities go through the real impulse path (ctx.world.applyImpulse), not a direct
        // velocity mutation, since their velocity may be physics-body-owned rather than a plain field.
        // reused scratch, not a fresh [x,y,z] per outside entity per tick: World.addImpulse (src/physics/
        // World.js:465) copies im[0..2] into its own Jolt _tmpVec3 and never retains the array.
        _impulse[0] = _outDirX * pushForce * dt; _impulse[2] = _outDirZ * pushForce * dt
        appCtx.world.applyImpulse(id, _impulse)
      }
      // dynamic entities have no generic health field in this engine (that is app-specific state), so
      // 'damage' against non-player dynamic entities is a no-op unless the caller inspects zone.isOutside
      // itself and applies their own app-specific damage -- documented in the module header's scope.
    }
  }

  const zone = {
    get radius() { return _radius },
    get center() { return [...center] },
    get elapsed() { return _elapsed },
    get phaseIndex() { return _phaseIndex },
    get completed() { return _completed },
    get ringEntityId() { return _ringId },

    // true if the given world-space position is currently outside the safe zone (x/z distance only --
    // the zone is a vertical cylinder of infinite height, matching every real battle-royale ring).
    isOutside(pos) {
      if (!_isVec3(pos)) return false
      const dx = pos[0] - center[0], dz = pos[2] - center[2]
      return Math.hypot(dx, dz) > _radius
    },

    // moves the zone center (e.g. a "next circle" random recenter between phases); does not affect radius.
    setCenter(pos) {
      if (!_isVec3(pos)) throw new TypeError('[shrinking-zone] setCenter requires a [x,y,z] finite-number array')
      center[0] = pos[0]; center[1] = pos[1]; center[2] = pos[2]
    },

    // call once per server tick from update(ctx, dt)
    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return
      _elapsed += dt
      _spawnRing()
      const activeSec = _elapsed - startDelaySec
      if (activeSec > 0) {
        _radius = curve === 'linear' ? _computeLinearRadius(activeSec) : _computePhaseRadius(activeSec)
        if (!_completed && _isFinalRadiusReached()) {
          _completed = true
          if (typeof spec.onComplete === 'function') spec.onComplete(appCtx, zone)
        }
        _scanPlayers(dt)
        _scanDynamicEntities(dt)
      }
      _syncRing()
    },

    // tears down the visual ring entity; call on the owning app's teardown/round-end.
    destroy() {
      _despawnRing()
    },

    // resets the shrink clock and radius back to the initial state (does not move the ring until the
    // next tick() call); the ring entity itself is left in place if already spawned.
    reset() {
      _elapsed = 0
      _phaseIndex = 0
      _completed = false
      _radius = curve === 'phases' ? phases[0].radius : startRadius
    }
  }

  return zone
}

export default defineShrinkingZone
