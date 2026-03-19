const TAU = 2 * Math.PI

function makePlayerSlot() {
  return { id: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 }
}

function makeEntitySlot() {
  return { id: 0, model: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], bodyType: 'static', custom: null, scale: [1, 1, 1] }
}

function fillPlayerArr(s, p) {
  s.id = p[0]
  s.position[0] = p[1]; s.position[1] = p[2]; s.position[2] = p[3]
  s.rotation[0] = p[4]; s.rotation[1] = p[5]; s.rotation[2] = p[6]; s.rotation[3] = p[7]
  s.velocity[0] = p[8]; s.velocity[1] = p[9]; s.velocity[2] = p[10]
  s.onGround = p[11] === 1; s.health = p[12]; s.inputSequence = p[13]; s.crouch = p[14] || 0
  s.lookPitch = ((p[15] || 0) >> 4) / 15 * TAU - Math.PI
  s.lookYaw = ((p[15] || 0) & 0xF) / 15 * TAU
}

function fillPlayerObj(s, p) {
  s.id = p.id || p.i
  const pos = p.position; const rot = p.rotation; const vel = p.velocity
  if (pos) { s.position[0] = pos[0]; s.position[1] = pos[1]; s.position[2] = pos[2] }
  else { s.position[0] = 0; s.position[1] = 0; s.position[2] = 0 }
  if (rot) { s.rotation[0] = rot[0]; s.rotation[1] = rot[1]; s.rotation[2] = rot[2]; s.rotation[3] = rot[3] }
  else { s.rotation[0] = 0; s.rotation[1] = 0; s.rotation[2] = 0; s.rotation[3] = 1 }
  if (vel) { s.velocity[0] = vel[0]; s.velocity[1] = vel[1]; s.velocity[2] = vel[2] }
  else { s.velocity[0] = 0; s.velocity[1] = 0; s.velocity[2] = 0 }
  s.onGround = p.onGround ?? false; s.health = p.health ?? 100
  s.inputSequence = 0; s.crouch = 0; s.lookPitch = 0; s.lookYaw = 0
}

function fillEntityArr(s, e) {
  s.id = e[0]; s.model = e[1]
  s.position[0] = e[2]; s.position[1] = e[3]; s.position[2] = e[4]
  s.rotation[0] = e[5]; s.rotation[1] = e[6]; s.rotation[2] = e[7]; s.rotation[3] = e[8]
  s.velocity[0] = e[9]; s.velocity[1] = e[10]; s.velocity[2] = e[11]
  s.bodyType = e[12]; s.custom = e[13]
  s.scale[0] = e[14] ?? 1; s.scale[1] = e[15] ?? 1; s.scale[2] = e[16] ?? 1
}

function fillEntityObj(s, e) {
  s.id = e.id; s.model = e.model
  const pos = e.position; const rot = e.rotation; const vel = e.velocity; const sc = e.scale
  if (pos) { s.position[0] = pos[0]; s.position[1] = pos[1]; s.position[2] = pos[2] }
  else { s.position[0] = 0; s.position[1] = 0; s.position[2] = 0 }
  if (rot) { s.rotation[0] = rot[0]; s.rotation[1] = rot[1]; s.rotation[2] = rot[2]; s.rotation[3] = rot[3] }
  else { s.rotation[0] = 0; s.rotation[1] = 0; s.rotation[2] = 0; s.rotation[3] = 1 }
  if (vel) { s.velocity[0] = vel[0]; s.velocity[1] = vel[1]; s.velocity[2] = vel[2] }
  else { s.velocity[0] = 0; s.velocity[1] = 0; s.velocity[2] = 0 }
  s.bodyType = e.bodyType || 'static'; s.custom = e.custom || null
  if (sc) { s.scale[0] = sc[0]; s.scale[1] = sc[1]; s.scale[2] = sc[2] }
  else { s.scale[0] = 1; s.scale[1] = 1; s.scale[2] = 1 }
}

function fillPlayer(s, p) { if (Array.isArray(p)) fillPlayerArr(s, p); else fillPlayerObj(s, p) }
function fillEntity(s, e) { if (Array.isArray(e)) fillEntityArr(s, e); else fillEntityObj(s, e) }

export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
    this._playerPool = []
    this._entityPool = []
    this._pIdx = 0
    this._eIdx = 0
  }

  _acquirePlayer() {
    if (this._pIdx < this._playerPool.length) return this._playerPool[this._pIdx++]
    const s = makePlayerSlot(); this._playerPool.push(s); this._pIdx++; return s
  }

  _acquireEntity() {
    if (this._eIdx < this._entityPool.length) return this._entityPool[this._eIdx++]
    const s = makeEntitySlot(); this._entityPool.push(s); this._eIdx++; return s
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick
    this._pIdx = 0; this._eIdx = 0
    const snapshotForBuffer = { tick: data.tick || 0, timestamp: data.timestamp || Date.now(), players: [], entities: [] }

    this._seenPlayers.clear()
    for (const p of data.players || []) {
      const pid = Array.isArray(p) ? p[0] : (p.id || p.i)
      this._seenPlayers.add(pid)
      const bufSlot = this._acquirePlayer()
      fillPlayer(bufSlot, p)
      const isNew = !this._playerStates.has(pid)
      let track = isNew ? undefined : this._playerStates.get(pid)
      if (!track) { track = makePlayerSlot(); this._playerStates.set(pid, track) }
      fillPlayer(track, p)
      if (isNew) this._callbacks.onPlayerJoined?.(pid, track)
      snapshotForBuffer.players.push(bufSlot)
    }
    for (const pid of this._playerStates.keys()) {
      if (!this._seenPlayers.has(pid)) { this._playerStates.delete(pid); this._callbacks.onPlayerLeft?.(pid) }
    }

    this._processEntities(data, snapshotForBuffer)
    return snapshotForBuffer
  }

  _parseEntity(e, snapshotForBuffer) {
    const eid = Array.isArray(e) ? e[0] : e.id
    const bufSlot = this._acquireEntity()
    fillEntity(bufSlot, e)
    const isNew = !this._entityStates.has(eid)
    let track = isNew ? undefined : this._entityStates.get(eid)
    if (!track) { track = makeEntitySlot(); this._entityStates.set(eid, track) }
    fillEntity(track, e)
    if (isNew) this._callbacks.onEntityAdded?.(eid, track)
    snapshotForBuffer.entities.push(bufSlot)
    return eid
  }

  _processEntities(data, snapshotForBuffer) {
    if (data.delta) {
      for (const e of data.entities || []) this._parseEntity(e, snapshotForBuffer)
      if (data.removed) {
        for (const eid of data.removed) {
          if (this._entityStates.has(eid)) { this._entityStates.delete(eid); this._callbacks.onEntityRemoved?.(eid) }
        }
      }
    } else {
      this._seenEntities.clear()
      for (const e of data.entities || []) { this._seenEntities.add(this._parseEntity(e, snapshotForBuffer)) }
      for (const eid of this._entityStates.keys()) {
        if (!this._seenEntities.has(eid)) { this._entityStates.delete(eid); this._callbacks.onEntityRemoved?.(eid) }
      }
    }
  }

  getPlayerState(pid) { return this._playerStates.get(pid) }
  getAllPlayerStates() { return this._playerStates }
  getEntity(eid) { return this._entityStates.get(eid) }
  getAllEntities() { return this._entityStates }
  removePlayer(pid) { this._playerStates.delete(pid) }
  clear() { this._playerStates.clear(); this._entityStates.clear() }
}
