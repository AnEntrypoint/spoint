const TAU = 2 * Math.PI

export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick

    const snapshotForBuffer = {
      tick: data.tick || 0,
      timestamp: data.timestamp || Date.now(),
      players: [],
      entities: []
    }

    this._seenPlayers.clear()
    for (const p of data.players || []) {
      const playerId = Array.isArray(p) ? p[0] : (p.id || p.i)
      this._seenPlayers.add(playerId)
      const existing = this._playerStates.get(playerId)
      const state = this._parsePlayerInto(p, existing)
      if (!existing) {
        this._playerStates.set(playerId, state)
        this._callbacks.onPlayerJoined?.(playerId, state)
      }
      snapshotForBuffer.players.push(state)
    }

    for (const playerId of this._playerStates.keys()) {
      if (!this._seenPlayers.has(playerId)) {
        this._playerStates.delete(playerId)
        this._callbacks.onPlayerLeft?.(playerId)
      }
    }

    this._processEntities(data, snapshotForBuffer)
    return snapshotForBuffer
  }

  _processEntities(data, snapshotForBuffer) {
    if (data.delta) {
      for (const e of data.entities || []) {
        const entityId = Array.isArray(e) ? e[0] : e.id
        const existing = this._entityStates.get(entityId)
        const state = this._parseEntityInto(e, existing)
        if (!existing) {
          this._entityStates.set(entityId, state)
          this._callbacks.onEntityAdded?.(entityId, state)
        }
        snapshotForBuffer.entities.push(state)
      }
      if (data.removed) {
        for (const eid of data.removed) {
          if (this._entityStates.has(eid)) {
            this._entityStates.delete(eid)
            this._callbacks.onEntityRemoved?.(eid)
          }
        }
      }
    } else {
      this._seenEntities.clear()
      for (const e of data.entities || []) {
        const entityId = Array.isArray(e) ? e[0] : e.id
        this._seenEntities.add(entityId)
        const existing = this._entityStates.get(entityId)
        const state = this._parseEntityInto(e, existing)
        if (!existing) {
          this._entityStates.set(entityId, state)
          this._callbacks.onEntityAdded?.(entityId, state)
        }
        snapshotForBuffer.entities.push(state)
      }
      for (const eid of this._entityStates.keys()) {
        if (!this._seenEntities.has(eid)) {
          this._entityStates.delete(eid)
          this._callbacks.onEntityRemoved?.(eid)
        }
      }
    }
  }

  _parsePlayerInto(p, out) {
    if (Array.isArray(p)) {
      if (out) {
        out.id = p[0]
        out.position[0] = p[1]; out.position[1] = p[2]; out.position[2] = p[3]
        out.rotation[0] = p[4]; out.rotation[1] = p[5]; out.rotation[2] = p[6]; out.rotation[3] = p[7]
        out.velocity[0] = p[8]; out.velocity[1] = p[9]; out.velocity[2] = p[10]
        out.onGround = p[11] === 1; out.health = p[12]; out.inputSequence = p[13]; out.crouch = p[14] || 0
        out.lookPitch = ((p[15] || 0) >> 4) / 15 * TAU - Math.PI; out.lookYaw = ((p[15] || 0) & 0xF) / 15 * TAU
        return out
      }
      return { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13], crouch: p[14] || 0, lookPitch: ((p[15] || 0) >> 4) / 15 * TAU - Math.PI, lookYaw: ((p[15] || 0) & 0xF) / 15 * TAU }
    }
    if (out) {
      out.id = p.id || p.i
      const pos = p.position || [0,0,0]; out.position[0] = pos[0]; out.position[1] = pos[1]; out.position[2] = pos[2]
      const rot = p.rotation || [0,0,0,1]; out.rotation[0] = rot[0]; out.rotation[1] = rot[1]; out.rotation[2] = rot[2]; out.rotation[3] = rot[3]
      const vel = p.velocity || [0,0,0]; out.velocity[0] = vel[0]; out.velocity[1] = vel[1]; out.velocity[2] = vel[2]
      out.onGround = p.onGround ?? false; out.health = p.health ?? 100; out.inputSequence = 0; out.crouch = 0; out.lookPitch = 0; out.lookYaw = 0
      return out
    }
    return { id: p.id || p.i, position: p.position ? [...p.position] : [0, 0, 0], rotation: p.rotation ? [...p.rotation] : [0, 0, 0, 1], velocity: p.velocity ? [...p.velocity] : [0, 0, 0], onGround: p.onGround ?? false, health: p.health ?? 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 }
  }

  _parseEntityInto(e, out) {
    if (Array.isArray(e)) {
      if (out) {
        out.id = e[0]; out.model = e[1]
        out.position[0] = e[2]; out.position[1] = e[3]; out.position[2] = e[4]
        out.rotation[0] = e[5]; out.rotation[1] = e[6]; out.rotation[2] = e[7]; out.rotation[3] = e[8]
        out.velocity[0] = e[9]; out.velocity[1] = e[10]; out.velocity[2] = e[11]
        out.bodyType = e[12]; out.custom = e[13]
        out.scale[0] = e[14] ?? 1; out.scale[1] = e[15] ?? 1; out.scale[2] = e[16] ?? 1
        return out
      }
      return { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], velocity: [e[9], e[10], e[11]], bodyType: e[12], custom: e[13], scale: [e[14] ?? 1, e[15] ?? 1, e[16] ?? 1] }
    }
    if (out) {
      out.id = e.id; out.model = e.model
      const pos = e.position || [0,0,0]; out.position[0] = pos[0]; out.position[1] = pos[1]; out.position[2] = pos[2]
      const rot = e.rotation || [0,0,0,1]; out.rotation[0] = rot[0]; out.rotation[1] = rot[1]; out.rotation[2] = rot[2]; out.rotation[3] = rot[3]
      const vel = e.velocity || [0,0,0]; out.velocity[0] = vel[0]; out.velocity[1] = vel[1]; out.velocity[2] = vel[2]
      out.bodyType = e.bodyType || 'static'; out.custom = e.custom || null
      const sc = e.scale || [1,1,1]; out.scale[0] = sc[0]; out.scale[1] = sc[1]; out.scale[2] = sc[2]
      return out
    }
    return { id: e.id, model: e.model, position: e.position ? [...e.position] : [0, 0, 0], rotation: e.rotation ? [...e.rotation] : [0, 0, 0, 1], velocity: e.velocity ? [...e.velocity] : [0, 0, 0], bodyType: e.bodyType || 'static', custom: e.custom || null, scale: e.scale ? [...e.scale] : [1, 1, 1] }
  }

  getPlayerState(playerId) { return this._playerStates.get(playerId) }
  getAllPlayerStates() { return this._playerStates }
  getEntity(entityId) { return this._entityStates.get(entityId) }
  getAllEntities() { return this._entityStates }
  removePlayer(playerId) { this._playerStates.delete(playerId) }
  clear() { this._playerStates.clear(); this._entityStates.clear() }
}
