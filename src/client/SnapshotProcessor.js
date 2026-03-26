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
  const s14=e[14]; s.scale[0]=s14==null?1:s14
  const s15=e[15]; s.scale[1]=s15==null?1:s15
  const s16=e[16]; s.scale[2]=s16==null?1:s16
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

function parsePlayerNew(p) {
  if (Array.isArray(p)) {
    return { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13], crouch: p[14] || 0, lookPitch: ((p[15] || 0) >> 4) / 15 * TAU - Math.PI, lookYaw: ((p[15] || 0) & 0xF) / 15 * TAU }
  }
  return { id: p.id || p.i, position: p.position ? [...p.position] : [0, 0, 0], rotation: p.rotation ? [...p.rotation] : [0, 0, 0, 1], velocity: p.velocity ? [...p.velocity] : [0, 0, 0], onGround: p.onGround ?? false, health: p.health ?? 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 }
}

function parseEntityNew(e) {
  if (Array.isArray(e)) {
    return { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], velocity: [e[9], e[10], e[11]], bodyType: e[12], custom: e[13], scale: [e[14] ?? 1, e[15] ?? 1, e[16] ?? 1] }
  }
  return { id: e.id, model: e.model, position: e.position ? [...e.position] : [0, 0, 0], rotation: e.rotation ? [...e.rotation] : [0, 0, 0, 1], velocity: e.velocity ? [...e.velocity] : [0, 0, 0], bodyType: e.bodyType || 'static', custom: e.custom || null, scale: e.scale ? [...e.scale] : [1, 1, 1] }
}

export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick
    const snapshotForBuffer = { tick: data.tick || 0, timestamp: data.timestamp || Date.now(), players: [], entities: [] }

    this._seenPlayers.clear()
    for (const p of data.players || []) {
      const pid = Array.isArray(p) ? p[0] : (p.id || p.i)
      this._seenPlayers.add(pid)
      const bufState = parsePlayerNew(p)
      let track = this._playerStates.get(pid)
      if (track) {
        if (Array.isArray(p)) fillPlayerArr(track, p); else fillPlayerObj(track, p)
      } else {
        track = makePlayerSlot()
        if (Array.isArray(p)) fillPlayerArr(track, p); else fillPlayerObj(track, p)
        this._playerStates.set(pid, track)
        this._callbacks.onPlayerJoined?.(pid, track)
      }
      snapshotForBuffer.players.push(bufState)
    }
    for (const pid of this._playerStates.keys()) {
      if (!this._seenPlayers.has(pid)) { this._playerStates.delete(pid); this._callbacks.onPlayerLeft?.(pid) }
    }

    this._processEntities(data, snapshotForBuffer)
    return snapshotForBuffer
  }

  _handleEntity(e, snapshotForBuffer) {
    const eid = Array.isArray(e) ? e[0] : e.id
    snapshotForBuffer.entities.push(parseEntityNew(e))
    let track = this._entityStates.get(eid)
    if (track) {
      if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
    } else {
      track = makeEntitySlot()
      if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
      this._entityStates.set(eid, track)
      this._callbacks.onEntityAdded?.(eid, track)
    }
    return eid
  }

  _processEntities(data, snapshotForBuffer) {
    if (data.delta) {
      for (const e of data.entities || []) this._handleEntity(e, snapshotForBuffer)
      if (data.removed) {
        for (const eid of data.removed) {
          if (this._entityStates.has(eid)) { this._entityStates.delete(eid); this._callbacks.onEntityRemoved?.(eid) }
        }
      }
    } else {
      this._seenEntities.clear()
      for (const e of data.entities || []) this._seenEntities.add(this._handleEntity(e, snapshotForBuffer))
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
