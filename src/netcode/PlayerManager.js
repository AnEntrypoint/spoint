import { pack } from '../protocol/msgpack.js'

export class PlayerManager {
  constructor() {
    this.players = new Map()
    this.nextPlayerId = 1
    this.inputBuffers = new Map()
    this._connectedCache = null
    this._connectedGen = 0
    this._cachedGen = -1
    // Round-robin cursor for snapshot fan-out group assignment (see TickHandler.js buildAndSendSnapshots,
    // which reduces player.snapGroup mod the current tick's snapGroups count). MUST be assigned relative to
    // the CURRENT snapGroups band, not as a monotonic id-like counter -- an ever-incrementing counter that
    // grows in lockstep with nextPlayerId (both +1 per join, neither ever decrements) degenerates to a pure
    // constant offset from playerId (snapGroup === id - 1 for the process lifetime), which is mathematically
    // identical in fairness to the `id % snapGroups` scheme it was meant to replace -- caught live via a
    // node -e witness showing `id - snapGroup` was a single constant across churn. Instead this cursor wraps
    // at the CURRENT snapGroups band size every join, so group membership is exact round-robin (0,1,...,N-1,
    // 0,1,...) among whichever players are actually connected right now, independent of id-parity/churn
    // history (the old id-modulo scheme could put 100% of connected players in one group under an
    // id-parity-correlated churn pattern -- reproduced live: 60/0 split).
    this._nextSnapGroup = 0
  }

  addPlayer(socket, initialState = {}) {
    const playerId = this.nextPlayerId++
    // Band size mirrors TickHandler's own `Math.max(1, Math.ceil(playerCount / 50))` exactly -- computed
    // against the count AFTER this join (this player is about to become connected), so the cursor wraps at
    // the same granularity the consumer will divide by.
    const snapGroups = Math.max(1, Math.ceil((this.players.size + 1) / 50))
    const snapGroup = this._nextSnapGroup % snapGroups
    this._nextSnapGroup = (this._nextSnapGroup + 1) % snapGroups
    const pos = initialState.position || [0, 0, 0]
    const player = {
      id: playerId,
      snapGroup,
      socket,
      // Display name -- server-authoritative, defaults to "Player <id>". Apps read it via
      // ctx.players.getById(id).name (killfeed, winner announce, turn/seat labels, save-game keys)
      // and set it via ctx.players.setName(id, name). A client can propose one at join via initialState.name.
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

  // clientSeq <= lastClientSeq is a resend and is dropped to avoid double-applying an input
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

  // Per-player movement-config overrides (e.g. a buff-stack speed/jump multiplier), shallow-merged
  // over the world's base movement config by applyMovement -- null/absent is a no-op.
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

  // Rollback-netcode primitive (rollback-entity-gamestate-snapshot, non-physics half of the epic --
  // PhysicsWorld.snapshotBodies/restoreBodies + CharacterManager.snapshotAll/restoreAll already cover
  // Jolt-simulated dynamics; this covers the per-player bookkeeping a tick can also mutate that a
  // rewind+resimulate pass must roll back too, e.g. health/onGround/ackSequence changes an app's
  // onCollision/onUpdate makes via ctx.players.*). Captures ONLY plain-data fields that are pure
  // functions of (state, input) across a resimulate pass -- deliberately EXCLUDES: `socket` (a live
  // connection object, not state -- restoring it would either no-op or, worse, swap live sockets between
  // players), `joinTime`/`connected` (session bookkeeping, not simulation state a tick resimulates),
  // `lastInputTime` (wall-clock Date.now() stamp, not tick-derived -- restoring a stale value then
  // immediately overwriting it on the very next addInput() call is harmless, but it is NOT itself
  // meaningful rollback state so it is left alone rather than round-tripped for no reason), and
  // `inputBuffers`/`name` (name is player-identity, never tick-mutated; inputBuffers is the INPUT
  // record the resimulate loop itself replays FROM, not simulation output it should also roll back --
  // rewinding it would delete the very inputs a forward resimulate pass needs to re-apply).
  // `state` is deep-cloned (JSON round-trip, same discipline AppRuntime.duplicateEntity already uses for
  // entity.custom) since it is a plain nested object (position/rotation/velocity arrays) mutated
  // in-place by updatePlayerState/movement code every tick -- a shallow copy would alias the live
  // object and "restoring" would silently do nothing once the live object mutates further.
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

  // Restores exactly the players present in `snap` (a Map from snapshotState, or a plain object for a
  // wire-deserialized snapshot). A player present in `snap` but since disconnected (removePlayer'd
  // between save and rollback) is silently skipped -- same defensive-skip discipline as
  // PhysicsWorld.restoreBodies for a body removed mid-window. A NEWLY-joined player absent from `snap`
  // (joined after the snapshot was taken) is left untouched, matching the same asymmetry: a rollback
  // resimulate pass only ever rewinds entities/players that existed at the save point.
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
