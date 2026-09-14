import { pack } from '../protocol/msgpack.js'

const PLAYERS_PER_SNAP_GROUP = 50

export class PlayerManager {
  constructor() {
    this.players = new Map()
    this.nextPlayerId = 1
    this.inputBuffers = new Map()
    this._connectedCache = null
    this._connectedGen = 0
    this._cachedGen = -1
    this._nextSnapGroup = 0
  }

  addPlayer(socket, initialState = {}) {
    const playerId = this.nextPlayerId++
    const snapGroups = Math.max(1, Math.ceil((this.players.size + 1) / PLAYERS_PER_SNAP_GROUP))
    const snapGroup = this._nextSnapGroup % snapGroups
    this._nextSnapGroup = (this._nextSnapGroup + 1) % snapGroups
    const pos = initialState.position || [0, 0, 0]
    const player = {
      id: playerId,
      snapGroup,
      socket,
      name: (typeof initialState.name === 'string' && initialState.name.trim()) ? initialState.name.trim().slice(0, 32) : ('Player ' + playerId),
      state: {
        position: [...pos],
        rotation: initialState.rotation || [0, 0, 0, 1],
        velocity: initialState.velocity || [0, 0, 0],
        onGround: false,
        health: initialState.health ?? 100
      },
      inputSequence: 0,
      lastClientSeq: null,
      ackSequence: 0,
      lastInputTime: 0,
      connected: true,
      joinTime: Date.now()
    }
    this.players.set(playerId, player)
    this.inputBuffers.set(playerId, [])
    this._connectedGen++
    return playerId
  }

  removePlayer(playerId) {
    this.players.delete(playerId)
    this.inputBuffers.delete(playerId)
    this._connectedGen++
  }

  getPlayer(playerId) {
    return this.players.get(playerId)
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  getConnectedPlayers() {
    if (this._cachedGen === this._connectedGen) return this._connectedCache
    this._connectedCache = this.getAllPlayers().filter(p => p.connected)
    this._cachedGen = this._connectedGen
    return this._connectedCache
  }

  getPlayerCount() {
    return this.players.size
  }

  updatePlayerState(playerId, state) {
    const player = this.players.get(playerId)
    if (player) Object.assign(player.state, state)
  }

  addInput(playerId, input, clientSeq) {
    const player = this.players.get(playerId)
    if (!player) return
    let seq
    if (clientSeq != null && Number.isFinite(clientSeq)) {
      if (player.lastClientSeq != null && clientSeq <= player.lastClientSeq) return
      player.lastClientSeq = clientSeq
      seq = clientSeq
    } else {
      player.inputSequence++
      seq = player.inputSequence
    }
    const now = Date.now()
    player.lastInputTime = now
    const inputs = this.inputBuffers.get(playerId)
    if (inputs) {
      inputs.push({ sequence: seq, data: input, timestamp: now })
      if (inputs.length > 128) inputs.shift()
    }
  }

  getInputs(playerId) {
    return this.inputBuffers.get(playerId) || []
  }

  setMovementOverride(playerId, overrides) {
    const player = this.players.get(playerId)
    if (!player) return false
    if (overrides == null) { delete player.movementOverride; return true }
    player.movementOverride = overrides
    return true
  }

  getMovementOverride(playerId) {
    return this.players.get(playerId)?.movementOverride || null
  }

  clearInputs(playerId) {
    const inputs = this.inputBuffers.get(playerId)
    if (inputs) inputs.length = 0
  }

  broadcast(message) {
    const data = pack(message)
    for (const player of this.getConnectedPlayers()) {
      if (player.socket && player.socket.send) {
        try { player.socket.send(data) } catch (e) {}
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
      try { player.socket.send(pack(message)) } catch (e) {}
    }
  }

  sendBinaryToPlayer(playerId, buffer) {
    const player = this.players.get(playerId)
    if (player && player.socket && player.socket.send) {
      try { player.socket.send(buffer) } catch (e) {}
    }
  }

  snapshotState() {
    const out = new Map()
    for (const [id, p] of this.players) {
      out.set(id, {
        state: JSON.parse(JSON.stringify(p.state)),
        inputSequence: p.inputSequence,
        lastClientSeq: p.lastClientSeq,
        ackSequence: p.ackSequence,
        movementOverride: p.movementOverride ? JSON.parse(JSON.stringify(p.movementOverride)) : undefined
      })
    }
    return out
  }

  restoreState(snap) {
    const entries = snap instanceof Map ? snap.entries() : Object.entries(snap)
    for (const [idKey, s] of entries) {
      const id = typeof idKey === 'number' ? idKey : Number(idKey)
      const player = this.players.get(id); if (!player) continue
      player.state = JSON.parse(JSON.stringify(s.state))
      player.inputSequence = s.inputSequence
      player.lastClientSeq = s.lastClientSeq
      player.ackSequence = s.ackSequence
      if (s.movementOverride) player.movementOverride = JSON.parse(JSON.stringify(s.movementOverride))
      else delete player.movementOverride
    }
  }
}
