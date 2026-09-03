// The kill-plane floor Y. A world with no terrain/floor under the spawn point (a common
// early-development state) lets a player fall forever, and at extreme depth a real Jolt
// character's readCharacterPosition can hand back a non-finite (literally null) Y. Both the
// real-body and no-body paths MUST enforce this identically -- see _applyKillPlane.
const KILL_PLANE_Y = -100

// Swim state constants. Mirrors apps/_lib/buoyancy.js's vertical-capsule-submersion model (same
// documented approximation precedent: treat the player capsule as submerged from its FEET up, linear
// 0..1 over the capsule's full height) so a player entering water and a buoyant prop entering water
// read the same "how submerged" signal, even though this is a distinct code path (player capsules are
// Jolt CharacterVirtual, not dynamic rigid bodies -- addForce/setVelocity semantics differ, so this
// cannot literally reuse defineBuoyancy(), only its documented shape).
// SWIM_GRAVITY_MUL: fraction of normal gravity applied while swimming (not full buoyant cancel --
// leaves a gentle sink so a player must actively swim-up, matching most third-person shooters' feel).
// SWIM_DRAG: submerged velocity damping coefficient (1/s), applied to ALL three axes (water resists
// horizontal swimming too, not just vertical bobbing -- distinct from buoyancy.js's horizontal-plus-
// vertical drag, same rationale).
// SWIM_UP_SPEED: target vertical speed while holding jump underwater (a swim-up stroke, not a jump
// impulse -- jumpImpulse is a single-tick velocity spike meant for a ground launch, applying it
// underwater every tick would rocket the player out of the water instantly).
const SWIM_GRAVITY_MUL = 0.15
const SWIM_DRAG = 1.5
const SWIM_UP_SPEED = 2.2
const SWIM_SINK_SPEED = -0.6

export class PhysicsIntegration {
  constructor(config = {}) {
    this.physicsWorld = config.physicsWorld || null
    // Root cause of fresh-scaffold-project-player-falls-through-static-floor-to-kill-plane: this used to be
    // `{ gravity: config.gravity || DEFAULT, ..., ...config }` -- spreading the raw `config` object LAST
    // meant an explicitly-present-but-undefined key (e.g. `new PhysicsIntegration({capsuleHalfHeight:
    // playerConfig.capsuleHalfHeight})` from WorkerEntry.js/RegionWorkerEntry.js, where playerConfig =
    // worldDef.player || {} for any world-def with no `player` block) clobbered the default straight back
    // to `undefined`, since `{...a, key: undefined}` OVERWRITES `a.key` (own-property presence wins over
    // `||` defaults already applied one line above -- the final spread doesn't know those were defaults).
    // That undefined halfHeight reached CharacterManager.addCharacter's `new J.CapsuleShape(halfHeight,
    // radius)` as a degenerate/zero-height capsule -- Jolt's CharacterVirtual.ExtendedUpdate never
    // registered ground contact for it and the character free-fell straight through a real, correctly-
    // placed static floor collider to the -100 kill-plane (live-witnessed: readCharacterPosition returning
    // a literal non-finite `null` Y after ~12 ticks of otherwise-normal freefall, nowhere near any
    // collider). Fix: resolve each field independently with `??` against the SAME already-defaulted
    // config object, so an explicit `undefined` in the caller's config is treated exactly like an omitted
    // key -- never spread the raw input object over the resolved defaults again.
    this.config = {
      gravity: config.gravity ?? [0, -9.81, 0],
      capsuleRadius: config.capsuleRadius ?? 0.4,
      capsuleHalfHeight: config.capsuleHalfHeight ?? 0.9,
      crouchHalfHeight: config.crouchHalfHeight ?? 0.45,
      playerMass: config.playerMass ?? 120
    }
    this.playerBodies = new Map()
    this._crouchStates = new Map()
  }

  setPhysicsWorld(world) {
    this.physicsWorld = world
  }

  // Real per-world sea-level Y in local scene-space, identical formula to AppContext.js's `seaLevel`
  // getter (frame.offsetY - frame.anchorHeight, the same PlanetFrame the underwater fog-tint shader and
  // apps/_lib/buoyancy.js already key off) -- NOT a re-derived constant. null when no terrain/frame is
  // streaming (flat test world), meaning "no water" to every caller.
  getSeaLevel() {
    const frame = this.physicsWorld?._planetFrame
    if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight)) return null
    return frame.offsetY - frame.anchorHeight
  }

  // submersionFrac: 0 (feet at/above sea level) .. 1 (head fully submerged), linear across the capsule's
  // full height (2*capsuleHalfHeight), same shape as buoyancy.js's vertical-capsule model. Returns 0 (not
  // swimming) when there is no sea level for this world. x/z feed the curvature sagitta: the ocean surface
  // is a sphere of radius frame.radius while local Y is tangent-plane height, so the effective waterline
  // drops by d^2/(2R) with horizontal distance from the anchor (same term PlanetFrame.groundHeightLocal
  // folds into terrain heights and UnderwaterTint.js now applies -- all three must agree, else the player
  // swims at a different height than the rendered shoreline, ~4 m off at the tps-game map edge).
  _submersionFrac(y, x = 0, z = 0) {
    const seaLevel = this.getSeaLevel()
    if (seaLevel == null) return 0
    const frame = this.physicsWorld._planetFrame
    const radius = Number.isFinite(frame?.radius) && frame.radius > 0 ? frame.radius : Infinity
    const waterlineY = seaLevel - (x * x + z * z) / (2 * radius)
    const halfHeight = this.config.capsuleHalfHeight
    const bottomY = y - halfHeight
    const span = 2 * halfHeight
    return Math.max(0, Math.min(1, (waterlineY - bottomY) / span))
  }

  // Computes this tick's vertical velocity (vy) and horizontal drag multiplier given submersion at the
  // player's CURRENT (pre-step) position, evaluated fresh each tick rather than reusing gravity/onGround
  // branching a caller already computed -- keeps swim a single, order-independent decision point instead
  // of requiring every caller (real-body path, fallback path) to separately special-case it. jumpHeld
  // drives a swim-up stroke (a per-tick target velocity, not a one-shot impulse -- applying jumpImpulse
  // underwater every held tick would rocket the player out instantly). Mutates state.swimming and
  // returns the resolved {vy, dragMul}; horizontal velocity (vx/vz) is the caller's to scale by dragMul
  // since the real-body path routes vx/vz through Jolt's setCharacterVelocity, not a direct add here.
  _resolveSwimVelocity(state, deltaTime, gravityVy, jumpHeld) {
    const submersionFrac = this._submersionFrac(state.position[1], state.position[0], state.position[2])
    const swimming = submersionFrac > 0.5
    state.swimming = swimming
    if (!swimming) return { vy: gravityVy, dragMul: 1 }
    const g = this.config.gravity[1]
    let vy = state.velocity[1] + g * SWIM_GRAVITY_MUL * deltaTime
    if (jumpHeld) vy = Math.max(vy, SWIM_UP_SPEED)
    // Passive sink is already produced by the reduced-gravity step above; just floor it at
    // SWIM_SINK_SPEED so an idle swimmer settles to a gentle terminal sink instead of free-falling at
    // reduced-but-still-unbounded gravity forever.
    else vy = Math.max(SWIM_SINK_SPEED, vy)
    const dragMul = Math.max(0, 1 - SWIM_DRAG * deltaTime)
    return { vy, dragMul }
  }

  addPlayerCollider(playerId, radius = 0.4) {
    // non-finite/<=0 radius is UB in Jolt's native character shape
    if (!Number.isFinite(radius) || radius <= 0) radius = 0.4
    if (this.playerBodies.has(playerId)) {
      this.removePlayerCollider(playerId)
    }
    if (!this.physicsWorld) {
      this.playerBodies.set(playerId, { id: playerId, charId: null, onGround: false })
      return
    }
    const charId = this.physicsWorld.addPlayerCharacter(
      radius,
      this.config.capsuleHalfHeight,
      [0, 5, 0],
      this.config.playerMass
    )
    this.playerBodies.set(playerId, { id: playerId, charId, onGround: false })
  }

  removePlayerCollider(playerId) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      this.physicsWorld.removeCharacter(data.charId)
    }
    this.playerBodies.delete(playerId)
  }

  // rollback-tickhandler-resimulate-loop: re-syncs the JS-side `state` mirror (position/velocity/onGround)
  // AND this.playerBodies' own `data.onGround` cache from the Jolt character AFTER an external
  // physicsWorld.restoreCharacters() call -- a real bug found+fixed while building RollbackLoop.js's live
  // witness. restoreCharacters only writes the Jolt-native CharacterVirtual's position/velocity; it does NOT
  // touch `state.position`/`state.velocity` (only updatePlayerPhysics's own read-back, further down, does
  // that) or `data.onGround` (a hidden per-player cache updatePlayerPhysics also owns). Without this call, a
  // resimulated tick's FIRST updatePlayerPhysics call starts its gravity/onGround-branch integration from
  // the STALE pre-rollback state.velocity/data.onGround (whatever the world was doing at the moment rollback
  // was triggered, e.g. mid-air at a LATER tick than the one being rewound to) instead of the just-restored
  // tick's real values -- live-reproduced as a 0.27m/1.6(m/s) resim divergence even when replaying the
  // IDENTICAL scripted input the original forward run used. A caller with no player characters (fully
  // non-player-driven rollback) can skip this; RollbackLoop.js calls it once per connected player right after
  // physics.restoreCharacters() in every resimulateFrom.
  resyncPlayerFromPhysics(playerId, state) {
    const data = this.playerBodies.get(playerId)
    if (!data || !data.charId || !this.physicsWorld) return
    this.physicsWorld.readCharacterPosition(data.charId, state.position)
    this.physicsWorld.readCharacterVelocity(data.charId, state.velocity)
    data.onGround = state.swimming ? false : this.physicsWorld.getCharacterGroundState(data.charId)
    state.onGround = data.onGround
  }

  updatePlayerPhysics(playerId, state, deltaTime) {
    const data = this.playerBodies.get(playerId)
    if (!data || !data.charId || !this.physicsWorld) {
      return this._fallbackPhysics(playerId, state, deltaTime)
    }
    const charId = data.charId
    const onGround = data.onGround
    let vy = onGround ? (state.velocity[1] > 0 ? state.velocity[1] : 0) : state.velocity[1] + this.config.gravity[1] * deltaTime
    const swim = this._resolveSwimVelocity(state, deltaTime, vy, !!state._jumpHeld)
    vy = swim.vy
    const vx = state.velocity[0] * swim.dragMul, vz = state.velocity[2] * swim.dragMul
    this.physicsWorld.setCharacterVelocity(charId, [vx, vy, vz])
    this.physicsWorld.updateCharacter(charId, deltaTime)
    this.physicsWorld.readCharacterPosition(charId, state.position)
    this.physicsWorld.readCharacterVelocity(charId, state.velocity)
    // onGround is meaningless while swimming (Jolt ground-contact against a lake/sea bed reads as
    // grounded even mid-water-column) -- force it false so applyMovement's next-tick ground-locomotion
    // branch (friction/accel tuned for walking) doesn't fight the swim velocity this function just set.
    data.onGround = state.swimming ? false : this.physicsWorld.getCharacterGroundState(charId)
    state.onGround = data.onGround
    // Enforce the kill-plane the same way the no-body fallback does -- one shared helper so the two
    // paths cannot drift (they once did: only the fallback floored Y, letting a real character fall
    // forever). The real path additionally re-teleports the Jolt body, since setCharacterPosition is
    // the only way to move a real character; setting state.position alone would desync the
    // authoritative body from the wire-visible position.
    if (this._applyKillPlane(state)) {
      this.physicsWorld.setCharacterPosition(charId, state.position)
    }
    return state
  }

  // Floor the player at the kill-plane. Non-finite (NaN/null) position or velocity must be treated as
  // already-fallen-through and checked FIRST: a plain `< KILL_PLANE_Y` magnitude test never fires on
  // NaN (every comparison against NaN is false), so an unclamped non-finite value reaches the wire
  // (serializing as null) and the client derives a NaN camera position, permanently hiding every
  // entity via EntityLoader's distance cull (NaN comparisons are always false). Returns whether it
  // clamped. Sanitizes all three axes and zeroes all velocity so no non-finite component escapes.
  //
  // Anti-cheat/robustness note (anticheat-server-envelope-checks): the original version of this guard
  // only inspected p[1], so a non-finite X or Z with a still-finite Y never triggered the clamp branch
  // at all -- that axis stayed NaN/Infinity in the AUTHORITATIVE in-memory state.position, which
  // lagCompensator.recordPlayerPosition then threads into every OTHER shooter's rewind hit-test for
  // this player every tick (rayVsCapsule against a NaN target coordinate simply never intersects,
  // making the corrupted player silently unhittable rather than crashing -- a real, if narrow,
  // advantage a malicious/buggy client could still reach even with InputGuard's yaw/pitch
  // sanitization in place, e.g. via a future ctx.physics force call or a Jolt-native edge case this
  // guard is the last line of defense against, not just malicious wire input). Now checks all three
  // axes independently so any one going non-finite floors the WHOLE position at the kill-plane
  // (same fail-safe the Y-only branch already used), instead of leaving the other two axes silently
  // corrupted in-place.
  _applyKillPlane(state) {
    const p = state.position
    const badY = !Number.isFinite(p[1]) || p[1] < KILL_PLANE_Y
    const badX = !Number.isFinite(p[0])
    const badZ = !Number.isFinite(p[2])
    if (badY || badX || badZ) {
      p[0] = Number.isFinite(p[0]) ? p[0] : 0
      p[1] = KILL_PLANE_Y
      p[2] = Number.isFinite(p[2]) ? p[2] : 0
      state.velocity[0] = 0; state.velocity[1] = 0; state.velocity[2] = 0
      return true
    }
    return false
  }

  _fallbackPhysics(playerId, state, deltaTime) {
    const gravityVy = state.velocity[1] + this.config.gravity[1] * deltaTime
    const swim = this._resolveSwimVelocity(state, deltaTime, gravityVy, !!state._jumpHeld)
    state.velocity[0] *= swim.dragMul
    state.velocity[1] = swim.vy
    state.velocity[2] *= swim.dragMul
    state.position[0] += state.velocity[0] * deltaTime
    state.position[1] += state.velocity[1] * deltaTime
    state.position[2] += state.velocity[2] * deltaTime
    // _applyKillPlane must still run even while swimming -- it is the last-line non-finite/fell-through
    // safety floor, independent of the swim state it may itself just have zeroed velocity for.
    state.onGround = this._applyKillPlane(state)
    return state
  }

  setPlayerPosition(playerId, position) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      this.physicsWorld.setCharacterPosition(data.charId, position)
    }
  }

  getPlayerPosition(playerId) {
    const data = this.playerBodies.get(playerId)
    if (data?.charId && this.physicsWorld) {
      return this.physicsWorld.getCharacterPosition(data.charId)
    }
    return [0, 0, 0]
  }

  raycast(origin, direction, maxDistance) {
    if (!this.physicsWorld) return { hit: false, distance: maxDistance }
    return this.physicsWorld.raycast(origin, direction, maxDistance)
  }

  validateMovement(playerId, newPosition, oldPosition) {
    const distance = Math.hypot(
      newPosition[0] - oldPosition[0],
      newPosition[1] - oldPosition[1],
      newPosition[2] - oldPosition[2]
    )
    if (distance > 2.0) return { valid: false, reason: 'move_too_far', distance }
    return { valid: true }
  }

  setCrouch(playerId, isCrouching) {
    const data = this.playerBodies.get(playerId)
    if (!data?.charId || !this.physicsWorld) return
    const currentState = this._crouchStates.get(playerId)
    if (currentState === isCrouching) return
    this.physicsWorld.setCharacterCrouch(data.charId, isCrouching)
    this._crouchStates.set(playerId, isCrouching)
  }
}
