import { vecOK } from '../shared/vecGuard.js'

export class NetworkState {
  constructor() {
    this.players = new Map()
    this.tick = 0
    this.timestamp = 0
    // getSnapshot() pool (see that method): reused result object + players array + per-id view objects.
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

  // `crouch` is a small bit-packed flags int (bit0=crouch, bit1=swimming), not a strict boolean -- see
  // TickHandler.js's crouchFlags construction. Passed through opaque here; every downstream consumer of
  // player.crouch already only tests truthiness or masks explicit bits, never `=== 1`.
  updatePlayer(playerId, position, rotation, velocity, onGround, health, inputSequence, crouch, lookPitch, lookYaw, expr, weapon) {
    const player = this.players.get(playerId)
    if (!player) return
    // reject malformed vecs here or NaN poisons the broadcast snapshot for every client
    if (vecOK(position, 3)) player.position = position
    if (vecOK(rotation, 4)) player.rotation = rotation
    if (vecOK(velocity, 3)) player.velocity = velocity
    player.onGround = onGround
    player.health = health
    player.inputSequence = inputSequence
    player.crouch = crouch
    player.lookPitch = lookPitch
    player.lookYaw = lookYaw
    // Compact viseme/emote expression code (animation-vrm-spring-bone-lod-expression-wire), u8 0-15,
    // see client/core/ExpressionCodes.js. Same optional-numeric-field discipline as crouch/lookPitch/
    // lookYaw above -- always a finite small int, no vecOK-style validation needed.
    player.expr = expr || 0
    // Compact equipped-weapon code (animation-weapon-signal-clientside-wiring), u8, see
    // src/shared/WeaponCodes.js. Server-authoritative (set via AppRuntime.setPlayerWeapon, never from
    // client input), same optional-numeric-field discipline as expr above.
    player.weapon = weapon || 0
  }

  getAllPlayers() {
    return Array.from(this.players.values())
  }

  // Pooled: the returned {tick,timestamp,players} object, its players array and each per-player view
  // object are reused call to call (was 1 + 1 + N fresh objects per tick). Every consumer
  // (TickHandler.buildAndSendSnapshots, ServerHandlers' join/reconnect encode, RegionWorkerEntry's
  // handoff encode) reads the result synchronously and never retains it across calls; position/
  // rotation/velocity are the same live array references they always were.
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

  // Rollback-netcode primitive (rollback-entity-gamestate-snapshot): NetworkState is the server's own
  // per-player WIRE-STATE CACHE (what buildAndSendSnapshots reads to encode the next outgoing snapshot),
  // a pure derived mirror of PlayerManager's authoritative state written every tick by
  // TickHandler.js's processPlayerMovement -> networkState.updatePlayer(...). It is entirely re-derivable
  // by re-running the resimulate loop's own per-tick update call, so this snapshot/restore pair exists
  // for the SAME reason PlayerManager's does -- restoring it directly is strictly cheaper than
  // re-deriving it, and keeps the two caches from drifting apart mid-rollback (a resimulate pass that
  // restores PlayerManager but leaves a stale NetworkState would broadcast the WRONG position for one
  // tick until the next update call overwrites it). `tick`/`timestamp` are restored too since a rewind
  // conceptually resets the server's own tick clock, not just the player payloads.
  snapshotState() {
    const players = new Map()
    for (const [id, p] of this.players) players.set(id, { ...p })
    return { tick: this.tick, timestamp: this.timestamp, players }
  }

  // Restores exactly the players present in snap.players (Map or wire-deserialized plain object) --
  // a player since removed is silently skipped, a player joined after the snapshot is left untouched,
  // matching PlayerManager.restoreState's identical asymmetric-membership discipline.
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
