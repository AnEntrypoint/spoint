export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick

    const snapshotForBuffer = {
      tick: data.tick || 0,
      timestamp: data.timestamp || Date.now(),
      players: [],
      entities: []
    }

    const seenPlayers = new Set()
    for (const p of data.players || []) {
      const playerId = Array.isArray(p) ? p[0] : (p.id || p.i)
      seenPlayers.add(playerId)
      const state = this._parsePlayerNew(p)
      if (!this._playerStates.has(playerId)) {
        this._callbacks.onPlayerJoined?.(playerId, state)
      }
      this._playerStates.set(playerId, state)
      snapshotForBuffer.players.push(state)
    }

    for (const playerId of this._playerStates.keys()) {
      if (!seenPlayers.has(playerId)) {
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
        const state = this._parseEntityNew(e)
        if (!this._entityStates.has(entityId)) {
          this._callbacks.onEntityAdded?.(entityId, state)
        }
        this._entityStates.set(entityId, state)
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
      const seen = new Set()
      for (const e of data.entities || []) {
        const entityId = Array.isArray(e) ? e[0] : e.id
        seen.add(entityId)
        const state = this._parseEntityNew(e)
        if (!this._entityStates.has(entityId)) {
          this._callbacks.onEntityAdded?.(entityId, state)
        }
        this._entityStates.set(entityId, state)
        snapshotForBuffer.entities.push(state)
      }
      for (const eid of this._entityStates.keys()) {
        if (!seen.has(eid)) {
          this._entityStates.delete(eid)
          this._callbacks.onEntityRemoved?.(eid)
        }
      }
    }
  }

  _parsePlayerNew(p) {
    const TAU = 2 * Math.PI
    if (Array.isArray(p)) {
      return { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13], crouch: p[14] || 0, lookPitch: ((p[15] || 0) >> 4) / 15 * TAU - Math.PI, lookYaw: ((p[15] || 0) & 0xF) / 15 * TAU }
    }
    return { id: p.id || p.i, position: p.position ? [...p.position] : [0, 0, 0], rotation: p.rotation ? [...p.rotation] : [0, 0, 0, 1], velocity: p.velocity ? [...p.velocity] : [0, 0, 0], onGround: p.onGround ?? false, health: p.health ?? 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 }
  }


  _parseEntityNew(e) {
    if (Array.isArray(e)) {
      return { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], velocity: [e[9], e[10], e[11]], bodyType: e[12], custom: e[13], scale: [e[14] ?? 1, e[15] ?? 1, e[16] ?? 1] }
    }
    return { id: e.id, model: e.model, position: e.position ? [...e.position] : [0, 0, 0], rotation: e.rotation ? [...e.rotation] : [0, 0, 0, 1], velocity: e.velocity ? [...e.velocity] : [0, 0, 0], bodyType: e.bodyType || 'static', custom: e.custom || null, scale: e.scale ? [...e.scale] : [1, 1, 1] }
  }


  getPlayerState(playerId) {
    return this._playerStates.get(playerId)
  }

  getAllPlayerStates() {
    return this._playerStates
  }

  getEntity(entityId) {
    return this._entityStates.get(entityId)
  }

  getAllEntities() {
    return this._entityStates
  }

  removePlayer(playerId) {
    this._playerStates.delete(playerId)
  }

  clear() {
    this._playerStates.clear()
    this._entityStates.clear()
  }
}
