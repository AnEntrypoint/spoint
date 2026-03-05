export class NetworkState {
  constructor() {
    this.players = new Map()
    this.tick = 0
    this.timestamp = 0
  }

  addPlayer(playerId, initialState = {}) {
    this.players.set(playerId, {
      id: playerId,
      position: initialState.position || [0, 0, 0],
      rotation: initialState.rotation || [0, 0, 0, 1],
      velocity: initialState.velocity || [0, 0, 0],
      angularVelocity: initialState.angularVelocity || [0, 0, 0],
      onGround: initialState.onGround !== undefined ? initialState.onGround : true,
      health: initialState.health || 100,
      inputSequence: 0,
      lastUpdate: Date.now()
    })
  }

  removePlayer(playerId) {
    this.players.delete(playerId)
  }

  getPlayer(playerId) {
    return this.players.get(playerId)
  }

  updatePlayer(playerId, state) {
    const player = this.players.get(playerId)
    if (player) {
      Object.assign(player, state)
      player.lastUpdate = Date.now()
    }
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  getSnapshot() {
    const players = Array.from(this.players.values())
    for (let i = 0; i < players.length; i++) {
        const p = players[i]
        if (p.crouch === undefined) p.crouch = 0
        if (p.lookPitch === undefined) p.lookPitch = 0
        if (p.lookYaw === undefined) p.lookYaw = 0
    }
    return {
      tick: this.tick,
      timestamp: this.timestamp,
      players
    }
  }

  setTick(tick, timestamp = Date.now()) {
    this.tick = tick
    this.timestamp = timestamp
  }

  clear() {
    this.players.clear()
  }
}
