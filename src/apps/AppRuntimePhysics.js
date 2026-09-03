export function mixinPhysics(runtime) {
  runtime._registerPhysicsCallbacks = function() {
    this._physics.onBodyActivated = (physicsBodyId) => {
      const entityId = this._physicsBodyToEntityId.get(physicsBodyId)
      if (!entityId) return
      this._activeDynamicIds.add(entityId)
      this._sleepingDynamicIds.delete(entityId)
      const e = this.entities.get(entityId)
      if (e) e._dynSleeping = false
    }
    this._physics.onBodyDeactivated = (physicsBodyId) => {
      const entityId = this._physicsBodyToEntityId.get(physicsBodyId)
      if (!entityId) return
      this._activeDynamicIds.delete(entityId)
      this._sleepingDynamicIds.add(entityId)
      const e = this.entities.get(entityId)
      if (e) { e._dynSleeping = true; this._physics.syncDynamicBody(physicsBodyId, e) }
    }
  }

  runtime._syncDynamicBodies = function() {
    if (!this._physics) return
    for (const id of this._activeDynamicIds) {
      const e = this.entities.get(id)
      if (!e || e._physicsBodyId === undefined) continue
      this._physics.syncDynamicBody(e._physicsBodyId, e)
    }
  }

  // Hard activation rings, distance from the NEAREST player to each dynamic entity:
  //   < physicsLODRadius (default 30m)              -> PHYSICAL: real Jolt dynamic/kinematic body, fully simulated
  //   physicsLODRadius .. physicsLODRadius*KIN_MULT  -> KINEMATIC-FROZEN: real body kept, but forced kinematic +
  //                                                      zero velocity (position tracked, not integrated/collided-against-forces)
  //   beyond that                                    -> DATA-ONLY: body destroyed entirely, entity.position is the
  //                                                      sole source of truth, a body is recreated once a player re-enters range
  // World.js's addBody(motionType) already accepts 'kinematic' as a first-class Jolt EMotionType_Kinematic body
  // (CharacterManager-independent, see World.js:100-123) so "kinematic-frozen" reuses the SAME body/shape --
  // only bodyInterface.SetMotionType + zeroed velocity toggle it, no destroy/recreate churn at the 30-100m ring,
  // which is exactly the ring hard-activation exists to keep cheap.
  const KIN_MULT = 100 / 30 // 30m physical -> 100m kinematic boundary, expressed as a ratio of physicsLODRadius so a world tuning physicsRadius scales both rings together

  runtime._tickPhysicsLOD = function(players) {
    if (!this._physics || !this._physicsLODRadius || this._dynamicEntityIds.size === 0) return
    const rPhys = this._physicsLODRadius
    const rKin = rPhys * KIN_MULT
    const rPhys2 = rPhys * rPhys, rKin2 = rKin * rKin
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const p of players) {
      const pp = p.state?.position; if (!pp) continue
      if (pp[0] - rKin < minX) minX = pp[0] - rKin
      if (pp[0] + rKin > maxX) maxX = pp[0] + rKin
      if (pp[2] - rKin < minZ) minZ = pp[2] - rKin
      if (pp[2] + rKin > maxZ) maxZ = pp[2] + rKin
    }
    const noPlayers = minX === Infinity
    const ids = this._lodIds || (this._lodIds = [...this._dynamicEntityIds])
    if (ids.length !== this._dynamicEntityIds.size) { this._lodIds = [...this._dynamicEntityIds]; this._lodPointer = 0 }
    const batchSize = Math.min(500, ids.length)
    const start = (this._lodPointer || 0) % ids.length
    this._lodPointer = (start + batchSize) % ids.length
    for (let i = 0; i < batchSize; i++) {
      const entityId = ids[(start + i) % ids.length]
      const e = this.entities.get(entityId)
      if (!e || !e._bodyDef) continue
      // nearest-player distance^2, needed for both the tier decision and the proximity-priority sleep budget below
      let nearest2 = Infinity
      if (!noPlayers && e.position[0] >= minX && e.position[0] <= maxX && e.position[2] >= minZ && e.position[2] <= maxZ) {
        for (const p of players) {
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0] - e.position[0], dy = pp[1] - e.position[1], dz = pp[2] - e.position[2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < nearest2) nearest2 = d2
        }
      }
      e._nearestPlayerDist2 = nearest2
      // Vehicle-chassis exemption: a live VehicleConstraint (e._vehicleId != null, see
      // createVehicleForEntity in this file) holds a direct native reference to this entity's chassis
      // body. The kinematic-freeze ring would force the body kinematic while the constraint keeps
      // driving SetDriverInput-issued suspension/wheel forces against it every physics step (Jolt no
      // longer integrates a kinematic body under those forces -- the vehicle would appear to "drive"
      // with zero actual movement, a silent desync rather than a crash); the data-only ring's
      // removeBody call is worse -- it is a genuine DestroyBody on a body the constraint still
      // references, live-confirmed at World.js's removeVehicle to be the same use-after-free hazard
      // class as double-destroying the constraint/tester themselves. A parked/unattended vehicle far
      // from every player must therefore stay fully 'physical' regardless of the ring distance --
      // matching this codebase's existing per-entity-class-policy precedent (resolveCCD's per-class
      // override) rather than teaching the generic LOD system vehicle-specific ring math.
      const tier = e._vehicleId != null ? 'physical' : (nearest2 <= rPhys2 ? 'physical' : nearest2 <= rKin2 ? 'kinematic' : 'dataonly')

      if (tier !== 'dataonly' && e._bodyActive === false) {
        // (re)create the body -- physical entities create at their own declared motionType, kinematic-ring
        // entities are created directly as kinematic (no physical-then-demote round trip)
        const d = e._bodyDef
        const createType = tier === 'kinematic' && d.motionType === 'dynamic' ? 'kinematic' : d.motionType
        const bid = this._physics.addBody(d.shapeType, d.params, e.position, createType, { ...d.opts, rotation: e.rotation })
        e._physicsBodyId = bid; e._bodyActive = true; e._bodyTier = tier
        this._physicsBodyToEntityId.set(bid, entityId)
        this._activeDynamicIds.add(entityId)
        this._sleepingDynamicIds.delete(entityId)
        this._suspendedEntityIds.delete(entityId)
      } else if (tier === 'dataonly' && e._bodyActive !== false && e._physicsBodyId !== undefined) {
        // A kinematic body never naturally sleeps (Jolt only sleeps Dynamic bodies past a velocity
        // threshold), so gating removal on isBodyActive()===false -- as the old two-tier logic did --
        // would strand every kinematic-ring body forever once a player leaves the 100m ring entirely.
        // A genuinely still-falling/moving DYNAMIC body IS still worth waiting one pass on (avoids an
        // ugly mid-air pop when a player sprints away from a just-knocked prop), so the wait-for-settle
        // behavior is kept, but ONLY for dynamic bodies; kinematic and already-inactive dynamic bodies
        // remove immediately.
        const wasDynamic = e._bodyTier === 'physical' && e._bodyDef.motionType === 'dynamic'
        if (!wasDynamic || !this._physics.isBodyActive(e._physicsBodyId)) {
          this._physicsBodyToEntityId.delete(e._physicsBodyId)
          this._activeDynamicIds.delete(entityId)
          this._sleepingDynamicIds.delete(entityId)
          this._physics.removeBody(e._physicsBodyId)
          e._physicsBodyId = undefined
          e._bodyActive = false; e._bodyTier = 'dataonly'
          this._suspendedEntityIds.add(entityId)
        }
      } else if (tier !== e._bodyTier && e._bodyActive && e._physicsBodyId !== undefined) {
        // ring crossing between physical<->kinematic while a body already exists: flip motion type in place,
        // no destroy/recreate. Entering kinematic zeroes velocity so a moving prop doesn't drift forever
        // un-simulated; entering physical re-activates so gravity/collision resume immediately.
        const d = e._bodyDef
        if (tier === 'kinematic' && d.motionType === 'dynamic') {
          this._physics.setBodyVelocity(e._physicsBodyId, [0, 0, 0])
          if (typeof this._physics.setBodyMotionType === 'function') this._physics.setBodyMotionType(e._physicsBodyId, 'kinematic')
        } else if (tier === 'physical' && d.motionType === 'dynamic') {
          if (typeof this._physics.setBodyMotionType === 'function') this._physics.setBodyMotionType(e._physicsBodyId, 'dynamic')
        }
        e._bodyTier = tier
      }
    }
    this._enforceBodyBudget()
  }

  // Global active-Jolt-body cap: when the active-body count exceeds runtime._physicsBodyBudget, the
  // FARTHEST-from-any-player active bodies are put to sleep first (Jolt DeactivateBody keeps the body/shape
  // resident -- cheap to reactivate -- vs. removeBody which frees the shape). Reuses e._nearestPlayerDist2
  // computed by _tickPhysicsLOD above, so this is a pure sort+trim over already-live distance data, no extra
  // distance work. Runs every _tickPhysicsLOD pass (same cadence as the ring sweep, ~2x/sec by default).
  //
  // Vehicle exemption (vehicles-torque-not-reliably-reaching-drive-wheels, root-caused live via a real
  // AppRuntimePhysics+Jolt harness): a live vehicle (e._vehicleId != null) was NOT exempted here even
  // though _tickPhysicsLOD's OWN tier computation above already force-pins a vehicle chassis to
  // 'physical' -- this function is a SEPARATE sweep with its own independent deactivateBody call, and it
  // was never given the same exemption. The real per-tick order in AppRuntimeTick.js's tick() runs
  // _updateList (which calls apps/vehicle/index.js's update() -> ctx.physics.setVehicleInput ->
  // World.js's setVehicleDriverInput, which wakes a sleeping chassis via ActivateBody whenever non-zero
  // forward/right/handbrake input arrives) BEFORE _tickPhysicsLOD (-> this function) in the SAME tick --
  // so every _physicsLODInterval-th tick (~2x/sec), a just-woken, actively-driven vehicle chassis could
  // be IMMEDIATELY re-deactivated again by this sweep if e._nearestPlayerDist2 still read stale/large
  // (it is only refreshed by _tickPhysicsLOD's own round-robin batch sweep -- batchSize=min(500,ids.length)
  // -- so a specific entity's distance can lag many passes behind a player who just walked up and
  // mounted it). Live-reproduced: a driven vehicle with a deliberately-stale _nearestPlayerDist2 moved
  // only 6.43m over 10s of held-forward input (repeatedly re-slept, 19 deactivate events) vs 112.65m
  // unconstrained -- a ~94% reduction that reads exactly as the reported symptom ("chassis staying
  // active [only briefly, between checks], position essentially frozen at the post-spawn-settle resting
  // spot despite input correctly reaching the controller every tick"). Fix: skip any e._vehicleId != null
  // entity entirely when building the eviction candidate list, same per-entity-class-policy shape as
  // _tickPhysicsLOD's own exemption and resolveCCD's per-class CCD override -- a live vehicle constraint
  // must never be deactivated by ANY sweep in this file, not just the tier-transition one.
  runtime._enforceBodyBudget = function() {
    const budget = this._physicsBodyBudget
    if (!budget || !this._physics || typeof this._physics.deactivateBody !== 'function') return
    const active = this._activeDynamicIds
    if (active.size <= budget) return
    const over = active.size - budget
    // collect {id, dist2} for every active entity that actually has a body id (guards a mid-tick removal race)
    const candidates = []
    for (const id of active) {
      const e = this.entities.get(id)
      if (!e || e._physicsBodyId === undefined) continue
      if (e._vehicleId != null) continue // never a budget-eviction candidate -- see header comment above
      candidates.push({ id, e, d2: e._nearestPlayerDist2 ?? Infinity })
    }
    candidates.sort((a, b) => b.d2 - a.d2) // farthest first
    for (let i = 0; i < over && i < candidates.length; i++) {
      const { id, e } = candidates[i]
      if (!this._physics.isBodyActive(e._physicsBodyId)) continue // already asleep, nothing to do
      this._physics.deactivateBody(e._physicsBodyId)
      // deactivation fires the onBodyDeactivated listener synchronously in Jolt-physics' JS binding, which
      // already moves the id from _activeDynamicIds to _sleepingDynamicIds (see _registerPhysicsCallbacks
      // above) -- no duplicate bookkeeping needed here.
    }
  }

  // Cross-entity physics: resolves an ARBITRARY target entity's body (not the caller's own ctx.entity,
  // which AppPhysics.js's buildPhysicsAPI already covers) so one app's logic can affect another entity's
  // physics state -- knockback, explosions, launch pads. Reuses the same runtime._physics primitives
  // buildPhysicsAPI's addForce/setVelocity call, no duplicated impulse/velocity logic.
  runtime.applyImpulseToEntity = function(entityId, impulse, worldPoint) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics) return false
    this._physics.addImpulse(e._physicsBodyId, impulse, worldPoint)
    return true
  }

  // Cross-entity motion-type flip + rest-state read (same "not the caller's own ctx.entity" rationale as
  // applyImpulseToEntity above) -- lets one app's tick() drive another entity's physics-LOD lifecycle, e.g.
  // apps/_lib/destructible.js polling+freezing debris pieces it spawned as separate apps/destructible-debris
  // child entities. Mirrors AppPhysics.js's own setMotionType/isAtRest bodies exactly (same World.js calls),
  // just resolved against an arbitrary entityId instead of the caller's ctx.entity.
  runtime.setEntityMotionType = function(entityId, motionType) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics || typeof this._physics.setBodyMotionType !== 'function') return false
    if (motionType !== 'dynamic' && motionType !== 'kinematic' && motionType !== 'static') return false
    if (motionType !== 'dynamic') this._physics.setBodyVelocity?.(e._physicsBodyId, [0, 0, 0])
    const ok = this._physics.setBodyMotionType(e._physicsBodyId, motionType)
    if (ok) {
      e.bodyType = motionType
      if (e._bodyDef) e._bodyDef.motionType = motionType
      if (motionType === 'static') this._activeDynamicIds?.delete(entityId)
      else this._activeDynamicIds?.add(entityId)
    }
    return ok
  }
  runtime.isEntityAtRest = function(entityId, eps = 0.05) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics) return true // no live body = nothing left to settle
    const v = this._physics.getBodyVelocity(e._physicsBodyId) || [0, 0, 0]
    const a = this._physics.getBodyAngularVelocity?.(e._physicsBodyId) || [0, 0, 0]
    return (v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) < eps*eps && (a[0]*a[0]+a[1]*a[1]+a[2]*a[2]) < eps*eps
  }

  runtime.setEntityGravityFactor = function(entityId, factor) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics || typeof this._physics.setBodyGravityFactor !== 'function') return false
    this._physics.setBodyGravityFactor(e._physicsBodyId, factor)
    return true
  }

  // Cross-entity body activation toggle (ctx.physics.* is self-only, see AppPhysics.js's buildPhysicsAPI
  // header). Needed by any app that PARKS a dynamic entity for later reuse instead of destroying it
  // (pooled/instanced spawn -- see apps/_lib/destructible.js's debris pool) -- setPosition alone
  // reactivates a body (World.js's setBodyPosition uses EActivation_Activate unconditionally), so a
  // parked/pooled dynamic body left merely repositioned keeps simulating/falling forever at the park
  // position, a real measured cost live-witnessed while building this primitive (a "parked" debris piece
  // drifted 215m over 2s of stepping because nothing had ever told Jolt to deactivate it). Deactivating
  // also zeroes velocity/angular velocity first so the body doesn't carry stale momentum INTO its next
  // sleep (irrelevant while asleep, but keeps getBodyVelocity honest for any diagnostic reading it).
  runtime.setEntityBodyActive = function(entityId, active) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics) return false
    if (active) {
      if (typeof this._physics.setBodyPosition === 'function') this._physics.setBodyPosition(e._physicsBodyId, e.position) // ActivateBody has no standalone wrapper; reposition-to-self activates
      return true
    }
    this._physics.setBodyVelocity?.(e._physicsBodyId, [0, 0, 0])
    this._physics.setBodyAngularVelocity?.(e._physicsBodyId, [0, 0, 0])
    if (typeof this._physics.deactivateBody === 'function') return this._physics.deactivateBody(e._physicsBodyId)
    return false
  }

  // Constrain two entities' bodies (weld/joint). Returns a constraintId or null.
  runtime.addEntityConstraint = function(entityIdA, entityIdB, opts) {
    const ea = this.entities.get(entityIdA), eb = this.entities.get(entityIdB)
    if (!ea || !eb || ea._physicsBodyId === undefined || eb._physicsBodyId === undefined || !this._physics || typeof this._physics.addConstraint !== 'function') return null
    return this._physics.addConstraint(ea._physicsBodyId, eb._physicsBodyId, opts)
  }
  runtime.removeConstraint = function(constraintId) {
    if (!this._physics || typeof this._physics.removeConstraint !== 'function') return false
    return this._physics.removeConstraint(constraintId)
  }

  // Real Jolt WheeledVehicleController, driven off an entity's OWN physics body (must already be a
  // dynamic body -- addBoxCollider/addColliderFromConfig with dynamic:true, same precondition as any
  // other physics primitive here). wheelDefs shape: see World.js createWheeledVehicle's own header
  // comment. Stores the vehicleId on the entity (_vehicleId) so a second create call on the same
  // entity fails loudly instead of silently orphaning the first vehicle's native Jolt objects.
  runtime.createVehicleForEntity = function(entityId, wheelDefs, opts) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics || typeof this._physics.createWheeledVehicle !== 'function') return null
    if (e._vehicleId != null) { console.warn(`[vehicle] entity ${entityId} already has a vehicle (${e._vehicleId}); call destroyVehicleForEntity first`); return null }
    const vid = this._physics.createWheeledVehicle(e._physicsBodyId, wheelDefs, opts)
    if (vid != null) { e._vehicleId = vid; e._vehicleWheelCount = wheelDefs.length }
    return vid
  }
  runtime.setEntityVehicleDriverInput = function(entityId, forward, right, brake, handbrake) {
    const e = this.entities.get(entityId)
    if (!e || e._vehicleId == null || !this._physics) return false
    return this._physics.setVehicleDriverInput(e._vehicleId, forward, right, brake || 0, handbrake || 0)
  }

  // Real Jolt TrackedVehicleController, sibling to createVehicleForEntity above -- same _vehicleId
  // bookkeeping/already-has-a-vehicle guard, same dynamic-body precondition. wheelDefs shape: see
  // World.js createTrackedVehicle's header comment (WheelSettingsTV, not WheelSettingsWV -- no steer
  // angle field; wheels carry side:'left'|'right' + driven:bool instead of the wheeled steer/drive flags).
  runtime.createTrackedVehicleForEntity = function(entityId, wheelDefs, opts) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics || typeof this._physics.createTrackedVehicle !== 'function') return null
    if (e._vehicleId != null) { console.warn(`[vehicle] entity ${entityId} already has a vehicle (${e._vehicleId}); call destroyVehicleForEntity first`); return null }
    const vid = this._physics.createTrackedVehicle(e._physicsBodyId, wheelDefs, opts)
    if (vid != null) { e._vehicleId = vid; e._vehicleWheelCount = wheelDefs.length }
    return vid
  }
  // forward/leftRatio/rightRatio/brake -- see World.js setTrackedVehicleDriverInput's header comment for
  // why this is a distinct signature from setEntityVehicleDriverInput's forward/right/brake/handbrake.
  runtime.setEntityTrackedVehicleDriverInput = function(entityId, forward, leftRatio, rightRatio, brake) {
    const e = this.entities.get(entityId)
    if (!e || e._vehicleId == null || !this._physics) return false
    return this._physics.setTrackedVehicleDriverInput(e._vehicleId, forward, leftRatio, rightRatio, brake || 0)
  }
  runtime.getEntityVehicleWheelTransform = function(entityId, wheelIndex) {
    const e = this.entities.get(entityId)
    if (!e || e._vehicleId == null || !this._physics) return null
    return this._physics.getVehicleWheelTransform(e._vehicleId, wheelIndex)
  }
  runtime.getEntityVehicleWheelState = function(entityId, wheelIndex) {
    const e = this.entities.get(entityId)
    if (!e || e._vehicleId == null || !this._physics) return null
    return { grounded: this._physics.isVehicleWheelGrounded(e._vehicleId, wheelIndex), speed: this._physics.getVehicleWheelSpeed(e._vehicleId, wheelIndex) }
  }
  runtime.destroyVehicleForEntity = function(entityId) {
    const e = this.entities.get(entityId)
    if (!e || e._vehicleId == null || !this._physics) return false
    const ok = this._physics.removeVehicle(e._vehicleId)
    e._vehicleId = null
    return ok
  }

  // Teleport/kinematic-move an entity: updates the authoritative entity.position (so the wire + render
  // follow) AND, if it has a physics body, the body itself (so its collider tracks -- moving platforms,
  // escort waypoints, elevators). Rotation optional. Returns false if the entity is unknown.
  runtime.setEntityPosition = function(entityId, position, rotation) {
    const e = this.entities.get(entityId)
    if (!e || !Array.isArray(position) || position.length < 3) return false
    e.position = [position[0], position[1], position[2]]
    if (Array.isArray(rotation) && rotation.length >= 4) e.rotation = [rotation[0], rotation[1], rotation[2], rotation[3]]
    if (e._physicsBodyId !== undefined && this._physics && typeof this._physics.setBodyPosition === 'function') {
      this._physics.setBodyPosition(e._physicsBodyId, e.position)
      if (Array.isArray(rotation) && rotation.length >= 4 && typeof this._physics.setBodyRotation === 'function') this._physics.setBodyRotation(e._physicsBodyId, e.rotation)
    }
    return true
  }

  runtime.setEntityVelocity = function(entityId, velocity) {
    const e = this.entities.get(entityId)
    if (!e) return false
    if (this._physics && e._physicsBodyId !== undefined) this._physics.setBodyVelocity(e._physicsBodyId, velocity)
    e.velocity = [...velocity]
    return true
  }
}
