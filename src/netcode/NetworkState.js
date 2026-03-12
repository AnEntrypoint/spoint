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

  updatePlayer(playerId, position, rotation, velocity, onGround, health, inputSequence, crouch, lookPitch, lookYaw) {
    const player = this.players.get(playerId)
    if (!player) return
    player.position = position
    player.rotation = rotation
    player.velocity = velocity
    player.onGround = onGround
    player.health = health
    player.inputSequence = inputSequence
    player.crouch = crouch
    player.lookPitch = lookPitch
    player.lookYaw = lookYaw
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  getSnapshot() {
    const players = []
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        position: p.position,
        rotation: p.rotation,
        velocity: p.velocity,
        onGround: p.onGround,
        health: p.health,
        inputSequence: p.inputSequence,
        crouch: p.crouch || 0,
        lookPitch: p.lookPitch || 0,
        lookYaw: p.lookYaw || 0
      })
    }
    return { tick: this.tick, timestamp: this.timestamp, players }
  }

  setTick(tick, timestamp = Date.now()) {
    this.tick = tick
    this.timestamp = timestamp
  }

  clear() {
    this.players.clear()
  }
}
