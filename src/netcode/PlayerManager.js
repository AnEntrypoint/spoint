export class PlayerManager {
  constructor() {
    this.players = new Map()
    this.nextPlayerId = 1
    this.inputBuffers = new Map()
  }

  addPlayer(socket, initialState = {}) {
    const playerId = this.nextPlayerId++
    const pos = initialState.position || [0, 0, 0]
    const player = {
      id: playerId,
      socket,
      state: {
        position: [...pos],
        rotation: initialState.rotation || [0, 0, 0, 1],
        velocity: initialState.velocity || [0, 0, 0],
        angularVelocity: initialState.angularVelocity || [0, 0, 0],
        onGround: true,
        health: 100
      },
      inputSequence: 0,
      lastInputTime: 0,
      connected: true,
      joinTime: Date.now()
    }
    this.players.set(playerId, player)
    this.inputBuffers.set(playerId, [])
    return playerId
  }

  removePlayer(playerId) {
    this.players.delete(playerId)
    this.inputBuffers.delete(playerId)
  }

  getPlayer(playerId) {
    return this.players.get(playerId)
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  getConnectedPlayers() {
    return this.getAllPlayers().filter(p => p.connected)
  }

  getPlayerCount() {
    return this.players.size
  }

  updatePlayerState(playerId, state) {
    const player = this.players.get(playerId)
    if (player) Object.assign(player.state, state)
  }

  addInput(playerId, input) {
    const player = this.players.get(playerId)
    if (!player) return
    player.inputSequence++
    player.lastInputTime = Date.now()
    const inputs = this.inputBuffers.get(playerId)
    if (inputs) {
      inputs.push({ sequence: player.inputSequence, data: input, timestamp: Date.now() })
      if (inputs.length > 128) inputs.shift()
    }
  }

  getInputs(playerId) {
    return this.inputBuffers.get(playerId) || []
  }

  clearInputs(playerId) {
    const inputs = this.inputBuffers.get(playerId)
    if (inputs) inputs.length = 0
  }

  broadcast(message) {
    const json = JSON.stringify(message)
    for (const player of this.getConnectedPlayers()) {
      if (player.socket && player.socket.send) {
        try { player.socket.send(json) } catch (e) {}
      }
    }
  }

  broadcastBinary(buffer) {
    for (const player of this.getConnectedPlayers()) {
      if (player.socket && player.socket.send) {
        try { player.socket.send(buffer) } catch (e) {}
      }
    }
  }

  sendToPlayer(playerId, message) {
    const player = this.players.get(playerId)
    if (player && player.socket && player.socket.send) {
      try { player.socket.send(JSON.stringify(message)) } catch (e) {}
    }
  }

  sendBinaryToPlayer(playerId, buffer) {
    const player = this.players.get(playerId)
    if (player && player.socket && player.socket.send) {
      try { player.socket.send(buffer) } catch (e) {}
    }
  }
}
