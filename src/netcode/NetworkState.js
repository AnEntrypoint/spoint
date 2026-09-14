import { vecOK } from '../shared/vecGuard.js'

export class NetworkState {
  constructor() {
    this.players = new Map()
    this.tick = 0
    this.timestamp = 0
    this._snapOut = { tick: 0, timestamp: 0, players: null }
    this._snapPlayers = []
    this._snapPool = null
  }

  addPlayer(playerId, initialState = {}) {
    this.players.set(playerId, {
      id: playerId,
      position: initialState.position || [0, 0, 0],
      rotation: initialState.rotation || [0, 0, 0, 1],
      velocity: initialState.velocity || [0, 0, 0],
      onGround: initialState.onGround !== undefined ? initialState.onGround : false,
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

  updatePlayer(playerId, position, rotation, velocity, onGround, health, inputSequence, crouch, lookPitch, lookYaw, expr, weapon) {
    const player = this.players.get(playerId)
    if (!player) return
    if (vecOK(position, 3)) player.position = position
    if (vecOK(rotation, 4)) player.rotation = rotation
    if (vecOK(velocity, 3)) player.velocity = velocity
    player.onGround = onGround
    player.health = health
    player.inputSequence = inputSequence
    player.crouch = crouch
    player.lookPitch = lookPitch
    player.lookYaw = lookYaw
    player.expr = expr || 0
    player.weapon = weapon || 0
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  getSnapshot() {
    const players = this._snapPlayers
    players.length = 0
    let pool = this._snapPool
    if (!pool) pool = this._snapPool = new Map()
    for (const p of this.players.values()) {
      let s = pool.get(p.id)
      if (!s) { s = { id: p.id, position: null, rotation: null, velocity: null, onGround: false, health: 0, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0 }; pool.set(p.id, s) }
      s.id = p.id
      s.position = p.position
      s.rotation = p.rotation
      s.velocity = p.velocity
      s.onGround = p.onGround
      s.health = p.health
      s.inputSequence = p.inputSequence
      s.crouch = p.crouch || 0
      s.lookPitch = p.lookPitch || 0
      s.lookYaw = p.lookYaw || 0
      s.expr = p.expr || 0
      s.weapon = p.weapon || 0
      players.push(s)
    }
    if (pool.size > players.length) { for (const id of pool.keys()) if (!this.players.has(id)) pool.delete(id) }
    const out = this._snapOut
    out.tick = this.tick; out.timestamp = this.timestamp; out.players = players
    return out
  }

  setTick(tick, timestamp = Date.now()) {
    this.tick = tick
    this.timestamp = timestamp
  }

  clear() {
    this.players.clear()
  }

  snapshotState() {
    const players = new Map()
    for (const [id, p] of this.players) players.set(id, { ...p })
    return { tick: this.tick, timestamp: this.timestamp, players }
  }

  restoreState(snap) {
    this.tick = snap.tick
    this.timestamp = snap.timestamp
    const entries = snap.players instanceof Map ? snap.players.entries() : Object.entries(snap.players || {})
    for (const [idKey, s] of entries) {
      const id = typeof idKey === 'number' ? idKey : Number(idKey)
      const player = this.players.get(id); if (!player) continue
      this.players.set(id, { ...s })
    }
  }
}
