export function mixinPhysics(runtime) {
  runtime._registerPhysicsCallbacks = function() {
    this._physics.onBodyActivated = (physicsBodyId) => {
      const entityId = this._physicsBodyToEntityId.get(physicsBodyId)
      if (!entityId) return
      const e = this.entities.get(entityId)
      if (e?.bodyType === 'kinematic') return
      this._activeDynamicIds.add(entityId)
      this._sleepingDynamicIds.delete(entityId)
      if (e) e._dynSleeping = false
    }
    this._physics.onBodyDeactivated = (physicsBodyId) => {
      const entityId = this._physicsBodyToEntityId.get(physicsBodyId)
      if (!entityId) return
      const e = this.entities.get(entityId)
      if (e?.bodyType === 'kinematic') return
      this._activeDynamicIds.delete(entityId)
      this._sleepingDynamicIds.add(entityId)
      if (e) { e._dynSleeping = true; this._physics.syncDynamicBody(physicsBodyId, e) }
    }
  }

  runtime._pushKinematicBody = function(e) {
    const p = e.position, b = this._physics.getBodyPosition(e._physicsBodyId)
    const bodyAlreadyThere = b[0] === Math.fround(p[0]) && b[1] === Math.fround(p[1]) && b[2] === Math.fround(p[2])
    if (!bodyAlreadyThere) this._physics.setBodyPosition(e._physicsBodyId, p)
  }

  runtime._syncDynamicBodies = function() {
    if (!this._physics) return
    for (const id of this._activeDynamicIds) {
      const e = this.entities.get(id)
      if (!e || e._physicsBodyId === undefined) continue
      if (e.bodyType === 'kinematic') this._pushKinematicBody(e)
      else this._physics.syncDynamicBody(e._physicsBodyId, e)
    }
    for (const id of this.getUnmanagedDynamicIds()) {
      const e = this.entities.get(id)
      if (e && e._physicsBodyId !== undefined && (e.bodyType === 'kinematic' || this._movedStaticIds.has(id))) this._pushKinematicBody(e)
    }
  }

  const KINEMATIC_RING_RADIUS_MULT = 100 / 30

  runtime._tickPhysicsLOD = function(players) {
    if (!this._physics || !this._physicsLODRadius || this._dynamicEntityIds.size === 0) return
    const rPhys = this._physicsLODRadius
    const rKin = rPhys * KINEMATIC_RING_RADIUS_MULT
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
      const isVehicleChassis = e._vehicleId != null
      const tier = isVehicleChassis ? 'physical' : (nearest2 <= rPhys2 ? 'physical' : nearest2 <= rKin2 ? 'kinematic' : 'dataonly')

      if (tier !== 'dataonly' && e._bodyActive === false) {
        const d = e._bodyDef
        const createType = tier === 'kinematic' && d.motionType === 'dynamic' ? 'kinematic' : d.motionType
        const bid = this._physics.addBody(d.shapeType, d.params, e.position, createType, { ...d.opts, rotation: e.rotation })
        e._physicsBodyId = bid; e._bodyActive = true; e._bodyTier = tier
        this._physicsBodyToEntityId.set(bid, entityId)
        this._activeDynamicIds.add(entityId)
        this._sleepingDynamicIds.delete(entityId)
        this._suspendedEntityIds.delete(entityId)
      } else if (tier === 'dataonly' && e._bodyActive !== false && e._physicsBodyId !== undefined) {
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

  runtime._enforceBodyBudget = function() {
    const budget = this._physicsBodyBudget
    if (!budget || !this._physics || typeof this._physics.deactivateBody !== 'function') return
    const active = this._activeDynamicIds
    if (active.size <= budget) return
    const over = active.size - budget
    const candidates = []
    for (const id of active) {
      const e = this.entities.get(id)
      if (!e || e._physicsBodyId === undefined) continue
      const isVehicleChassis = e._vehicleId != null
      if (isVehicleChassis) continue
      candidates.push({ id, e, d2: e._nearestPlayerDist2 ?? Infinity })
    }
    candidates.sort((a, b) => b.d2 - a.d2)
    for (let i = 0; i < over && i < candidates.length; i++) {
      const { id, e } = candidates[i]
      if (!this._physics.isBodyActive(e._physicsBodyId)) continue
      this._physics.deactivateBody(e._physicsBodyId)
    }
  }

  runtime.applyImpulseToEntity = function(entityId, impulse, worldPoint) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics) return false
    this._physics.addImpulse(e._physicsBodyId, impulse, worldPoint)
    return true
  }

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
    if (!e || e._physicsBodyId === undefined || !this._physics) return true
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

  runtime.setEntityBodyActive = function(entityId, active) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics) return false
    if (active) {
      if (typeof this._physics.setBodyPosition === 'function') this._physics.setBodyPosition(e._physicsBodyId, e.position)
      return true
    }
    this._physics.setBodyVelocity?.(e._physicsBodyId, [0, 0, 0])
    this._physics.setBodyAngularVelocity?.(e._physicsBodyId, [0, 0, 0])
    if (typeof this._physics.deactivateBody === 'function') return this._physics.deactivateBody(e._physicsBodyId)
    return false
  }

  runtime.addEntityConstraint = function(entityIdA, entityIdB, opts) {
    const ea = this.entities.get(entityIdA), eb = this.entities.get(entityIdB)
    if (!ea || !eb || ea._physicsBodyId === undefined || eb._physicsBodyId === undefined || !this._physics || typeof this._physics.addConstraint !== 'function') return null
    return this._physics.addConstraint(ea._physicsBodyId, eb._physicsBodyId, opts)
  }
  runtime.removeConstraint = function(constraintId) {
    if (!this._physics || typeof this._physics.removeConstraint !== 'function') return false
    return this._physics.removeConstraint(constraintId)
  }

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

  runtime.createTrackedVehicleForEntity = function(entityId, wheelDefs, opts) {
    const e = this.entities.get(entityId)
    if (!e || e._physicsBodyId === undefined || !this._physics || typeof this._physics.createTrackedVehicle !== 'function') return null
    if (e._vehicleId != null) { console.warn(`[vehicle] entity ${entityId} already has a vehicle (${e._vehicleId}); call destroyVehicleForEntity first`); return null }
    const vid = this._physics.createTrackedVehicle(e._physicsBodyId, wheelDefs, opts)
    if (vid != null) { e._vehicleId = vid; e._vehicleWheelCount = wheelDefs.length }
    return vid
  }
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
