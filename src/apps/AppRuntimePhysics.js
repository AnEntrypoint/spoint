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

  runtime._tickPhysicsLOD = function(players) {
    if (!this._physics || !this._physicsLODRadius || this._dynamicEntityIds.size === 0) return
    const r = this._physicsLODRadius
    const r2 = r * r
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const p of players) {
      const pp = p.state?.position; if (!pp) continue
      if (pp[0] - r < minX) minX = pp[0] - r
      if (pp[0] + r > maxX) maxX = pp[0] + r
      if (pp[2] - r < minZ) minZ = pp[2] - r
      if (pp[2] + r > maxZ) maxZ = pp[2] + r
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
      let inRange = false
      if (!noPlayers && e.position[0] >= minX && e.position[0] <= maxX && e.position[2] >= minZ && e.position[2] <= maxZ) {
        for (const p of players) {
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0] - e.position[0], dy = pp[1] - e.position[1], dz = pp[2] - e.position[2]
          if (dx * dx + dy * dy + dz * dz <= r2) { inRange = true; break }
        }
      }
      if (inRange && e._bodyActive === false) {
        const d = e._bodyDef
        const bid = this._physics.addBody(d.shapeType, d.params, e.position, d.motionType, { ...d.opts, rotation: e.rotation })
        e._physicsBodyId = bid; e._bodyActive = true
        this._physicsBodyToEntityId.set(bid, entityId)
        this._activeDynamicIds.add(entityId)
        this._sleepingDynamicIds.delete(entityId)
        this._suspendedEntityIds.delete(entityId)
      } else if (!inRange && e._bodyActive !== false && e._physicsBodyId !== undefined && !this._physics.isBodyActive(e._physicsBodyId)) {
        this._physicsBodyToEntityId.delete(e._physicsBodyId)
        this._activeDynamicIds.delete(entityId)
        this._sleepingDynamicIds.delete(entityId)
        this._physics.removeBody(e._physicsBodyId)
        e._physicsBodyId = undefined
        e._bodyActive = false
        this._suspendedEntityIds.add(entityId)
      }
    }
  }
}
