import { pack } from '../protocol/msgpack.js'
import { PLAYER_DEFAULTS } from '../shared/worldDefaults.js'

const MAX_BUFFERED_INPUTS = 128

const DELIVERED = 'delivered'
const NO_TRANSPORT = 'no-transport'
const PEER_NOT_OPEN = 'peer-not-open'
const TRANSPORT_REFUSED = 'transport-refused'
const SEND_THREW = 'send-threw'

export class PlayerManager {
  constructor() {
    this.players = new Map()
    this.nextPlayerId = 1
    this.inputBuffers = new Map()
    this._connectedCache = null
    this._connectedGen = 0
    this._cachedGen = -1
    this.sendFailures = 0
    this._loggedSendFailures = new Map()
  }

  addPlayer(socket, initialState = {}) {
    const playerId = this.nextPlayerId++
    const pos = initialState.position || [0, 0, 0]
    const player = {
      id: playerId,
      socket,
      name: (typeof initialState.name === 'string' && initialState.name.trim()) ? initialState.name.trim().slice(0, 32) : ('Player ' + playerId),
      state: {
        position: [...pos],
        rotation: initialState.rotation || [0, 0, 0, 1],
        velocity: initialState.velocity || [0, 0, 0],
        onGround: false,
        health: initialState.health ?? PLAYER_DEFAULTS.health
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
    this._loggedSendFailures.delete(playerId)
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
    const inputs = this.inputBuffers.get(playerId)
    if (!inputs) return
    const now = Date.now()
    if (clientSeq == null || !Number.isFinite(clientSeq)) {
      player.inputSequence++
      player.lastInputTime = now
      inputs.push({ sequence: player.inputSequence, data: input, timestamp: now })
      if (inputs.length > MAX_BUFFERED_INPUTS) inputs.shift()
      return
    }
    if (clientSeq <= (player.ackSequence || 0)) return
    let i = inputs.length
    while (i > 0 && inputs[i - 1].sequence > clientSeq) i--
    if (i > 0 && inputs[i - 1].sequence === clientSeq) return
    inputs.splice(i, 0, { sequence: clientSeq, data: input, timestamp: now })
    if (player.lastClientSeq == null || clientSeq > player.lastClientSeq) player.lastClientSeq = clientSeq
    player.lastInputTime = now
    if (inputs.length > MAX_BUFFERED_INPUTS) inputs.shift()
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

  _encodeMessage(message) {
    try {
      return pack(message)
    } catch (err) {
      const detail = err && err.message ? err.message : String(err)
      throw new Error(`[player-manager] encode-failed: ${detail}`)
    }
  }

  _deliver(player, data) {
    const transport = player && player.socket
    if (!transport || typeof transport.send !== 'function') return NO_TRANSPORT
    let accepted
    try {
      accepted = transport.send(data)
    } catch (err) {
      this._recordSendFailure(player, SEND_THREW, err && err.message)
      return SEND_THREW
    }
    if (accepted === false) {
      const reason = transport.isOpen === false ? PEER_NOT_OPEN : TRANSPORT_REFUSED
      this._recordSendFailure(player, reason, null)
      if (reason === PEER_NOT_OPEN && player.connected) {
        player.connected = false
        this._connectedGen++
      }
      return reason
    }
    return DELIVERED
  }

  _recordSendFailure(player, reason, detail) {
    this.sendFailures++
    let logged = this._loggedSendFailures.get(player.id)
    if (!logged) {
      logged = new Set()
      this._loggedSendFailures.set(player.id, logged)
    }
    if (logged.has(reason)) return
    logged.add(reason)
    const suffix = detail ? ' -- ' + detail : ''
    console.error(`[player-manager] send to player ${player.id} did not deliver (${reason})${suffix}`)
  }

  broadcast(message) {
    const data = this._encodeMessage(message)
    return this._fanOut(data)
  }

  broadcastBinary(buffer) {
    return this._fanOut(buffer)
  }

  _fanOut(data) {
    const failed = []
    let delivered = 0
    let skipped = 0
    for (const player of this.getConnectedPlayers()) {
      const outcome = this._deliver(player, data)
      if (outcome === DELIVERED) delivered++
      else if (outcome === NO_TRANSPORT) skipped++
      else failed.push({ playerId: player.id, reason: outcome })
    }
    return { delivered, failed, skipped }
  }

  sendToPlayer(playerId, message) {
    const player = this.players.get(playerId)
    if (!player) return false
    return this._deliver(player, this._encodeMessage(message)) === DELIVERED
  }

  sendBinaryToPlayer(playerId, buffer) {
    const player = this.players.get(playerId)
    if (!player) return false
    return this._deliver(player, buffer) === DELIVERED
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
