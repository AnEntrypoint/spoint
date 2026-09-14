const TAU = 2 * Math.PI
const QSCALE = 511 * Math.SQRT2
const Q1 = 100
const PLAYER_TIER_FULL = 0
const PLAYER_TIER_REDUCED = 1
const REDUCED_PLAYER_RECORD_LENGTH = 5

function unpackQuat(packed, out) {
  const maxIdx = (packed >>> 30) & 0x3
  const c2 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c1 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c0 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2
  const sumSq = c0 * c0 + c1 * c1 + c2 * c2
  const m = Math.sqrt(Math.max(0, 1 - sumSq))
  switch (maxIdx) {
    case 0: out[1] = c0; out[2] = c1; out[3] = c2; out[0] = m; break
    case 1: out[0] = c0; out[2] = c1; out[3] = c2; out[1] = m; break
    case 2: out[0] = c0; out[1] = c1; out[3] = c2; out[2] = m; break
    default: out[0] = c0; out[1] = c1; out[2] = c2; out[3] = m; break
  }
  return out
}

const _bin = { px:0, py:0, pz:0, vx:0, vy:0, vz:0, qrot:0, sx:1, sy:1, sz:1, flags:0 }
function unpackBinRecord(buf) {
  const b = buf instanceof DataView ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  _bin.px = (((b[0] | (b[1] << 8)) << 16) >> 16) / Q1; _bin.py = (((b[2] | (b[3] << 8)) << 16) >> 16) / Q1; _bin.pz = (((b[4] | (b[5] << 8)) << 16) >> 16) / Q1
  _bin.vx = (((b[6] | (b[7] << 8)) << 16) >> 16) / Q1; _bin.vy = (((b[8] | (b[9] << 8)) << 16) >> 16) / Q1; _bin.vz = (((b[10] | (b[11] << 8)) << 16) >> 16) / Q1
  _bin.qrot = (b[12] | (b[13] << 8) | (b[14] << 16)) + b[15] * 16777216
  _bin.sx = (b[16] | (b[17] << 8)) / Q1; _bin.sy = (b[18] | (b[19] << 8)) / Q1; _bin.sz = (b[20] | (b[21] << 8)) / Q1
  _bin.flags = b[22]
  return _bin
}

function makePlayerSlot() {
  return { id: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0, tier: 0 }
}

function fillPlayerArrReduced(s, p) {
  s.id = p[0]
  s.position[0] = p[1] / Q1
  if (s.position[1] === undefined) s.position[1] = 0
  s.position[2] = p[2] / Q1
  s.lookYaw = (p[3] || 0) / 256 * TAU
  s.tier = PLAYER_TIER_REDUCED
}

function fillAnyPlayerArr(s, p) {
  const isReducedTierRecord = p.length === REDUCED_PLAYER_RECORD_LENGTH && p[4] === PLAYER_TIER_REDUCED
  if (isReducedTierRecord) fillPlayerArrReduced(s, p)
  else { fillPlayerArr(s, p); s.tier = PLAYER_TIER_FULL }
}

function makeEntitySlot() {
  return { id: 0, model: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], bodyType: 'static', custom: null, scale: [1, 1, 1], sleeping: false }
}

function fillPlayerArr(s, p) {
  s.id = p[0]
  const bin = unpackBinRecord(p[1])
  s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz
  unpackQuat(bin.qrot, s.rotation)
  s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz
  s.onGround = p[2] === 1; s.health = p[3]; s.inputSequence = p[4]; s.crouch = p[5] || 0
  s.lookPitch = (((p[6] || 0) >> 8) & 0xFF) / 255 * Math.PI - Math.PI / 2
  s.lookYaw = ((p[6] || 0) & 0xFF) / 256 * TAU
  s.expr = p[7] || 0
  s.weapon = p[8] || 0
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
  s.inputSequence = p.inputSequence ?? 0; s.crouch = p.crouch ?? 0; s.lookPitch = p.lookPitch ?? 0; s.lookYaw = p.lookYaw ?? 0
  s.expr = p.expr ?? 0
  s.weapon = p.weapon ?? 0
  s.tier = PLAYER_TIER_FULL
}

const FIELD_POS = 1 << 0
const FIELD_ROT = 1 << 1
const FIELD_VEL = 1 << 2
const FIELD_SCALE = 1 << 3
const FIELD_BODY = 1 << 4
const FIELD_CUSTOM = 1 << 5
const FIELD_SLEEP = 1 << 6
const FIELD_MODEL = 1 << 7

function applyFieldDelta(s, mask, fields, fi) {
  if (mask & FIELD_MODEL) { s.model = fields[fi]; fi++ }
  if (mask & (FIELD_POS|FIELD_ROT|FIELD_VEL|FIELD_SCALE)) {
    const bin = unpackBinRecord(fields[fi]); fi++
    if (mask & FIELD_POS) { s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz }
    if (mask & FIELD_ROT) unpackQuat(bin.qrot, s.rotation)
    if (mask & FIELD_VEL) { s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz }
    if (mask & FIELD_SCALE) { s.scale[0] = bin.sx; s.scale[1] = bin.sy; s.scale[2] = bin.sz }
  }
  if (mask & FIELD_BODY) { s.bodyType = fields[fi]; fi++ }
  if (mask & FIELD_CUSTOM) { s.custom = fields[fi]; fi++ }
  if (mask & FIELD_SLEEP) { s.sleeping = fields[fi] === 1; fi++ }
}

function fillEntityArr(s, e) {
  if (typeof e[1] === 'number') {
    applyFieldDelta(s, e[1], e, 2)
    return
  }
  s.id = e[0]; s.model = e[1]
  const bin = unpackBinRecord(e[2])
  s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz
  unpackQuat(bin.qrot, s.rotation)
  s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz
  s.bodyType = e[3]; s.custom = e[4]
  s.scale[0] = bin.sx; s.scale[1] = bin.sy; s.scale[2] = bin.sz
  s.sleeping = e[5] === 1
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

function copyPlayerStateInto(dst, s) {
  dst.id = s.id
  if (!dst.position) dst.position = [0, 0, 0]
  if (!dst.rotation) dst.rotation = [0, 0, 0, 1]
  if (!dst.velocity) dst.velocity = [0, 0, 0]
  dst.position[0] = s.position[0]; dst.position[1] = s.position[1]; dst.position[2] = s.position[2]
  dst.rotation[0] = s.rotation[0]; dst.rotation[1] = s.rotation[1]; dst.rotation[2] = s.rotation[2]; dst.rotation[3] = s.rotation[3]
  dst.velocity[0] = s.velocity[0]; dst.velocity[1] = s.velocity[1]; dst.velocity[2] = s.velocity[2]
  dst.onGround = s.onGround; dst.health = s.health; dst.inputSequence = s.inputSequence; dst.crouch = s.crouch
  dst.lookPitch = s.lookPitch; dst.lookYaw = s.lookYaw; dst.tier = s.tier || 0
  dst.expr = s.expr || 0; dst.weapon = s.weapon || 0
  return dst
}

function copyEntityStateInto(dst, s) {
  dst.id = s.id; dst.model = s.model
  dst.position[0] = s.position[0]; dst.position[1] = s.position[1]; dst.position[2] = s.position[2]
  dst.rotation[0] = s.rotation[0]; dst.rotation[1] = s.rotation[1]; dst.rotation[2] = s.rotation[2]; dst.rotation[3] = s.rotation[3]
  dst.velocity[0] = s.velocity[0]; dst.velocity[1] = s.velocity[1]; dst.velocity[2] = s.velocity[2]
  dst.bodyType = s.bodyType; dst.custom = s.custom
  dst.scale[0] = s.scale[0]; dst.scale[1] = s.scale[1]; dst.scale[2] = s.scale[2]
  dst.sleeping = s.sleeping
  return dst
}

class SlotPool {
  constructor(makeSlot) {
    this._make = makeSlot
    this._free = []
  }
  acquire() { return this._free.length ? this._free.pop() : this._make() }
  release(slot) { this._free.push(slot) }
}

const REDUCED_TIER_ABSENCE_GRACE_SNAPSHOTS = 40

const SNAPSHOT_RELEASE_WINDOW = 96

export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
    this._deltaFailures = 0
    this._deltaFailureIds = new Set()
    this._lastSeenCall = new Map()
    this._callCount = 0
    this._playerSlotPool = new SlotPool(makePlayerSlot)
    this._entitySlotPool = new SlotPool(makeEntitySlot)
    this._releaseQueue = []
  }

  _maybeReleaseOldest() {
    if (this._releaseQueue.length <= SNAPSHOT_RELEASE_WINDOW) return
    const oldest = this._releaseQueue.shift()
    for (const slot of oldest.players) this._playerSlotPool.release(slot)
    for (const slot of oldest.entities) this._entitySlotPool.release(slot)
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick
    this._callCount++
    const snapshotForBuffer = { tick: data.tick || 0, timestamp: data.timestamp || Date.now(), players: [], entities: [] }
    if (data.dots) snapshotForBuffer.dots = data.dots

    this._seenPlayers.clear()
    for (const p of data.players || []) {
      const pid = Array.isArray(p) ? p[0] : (p.id || p.i)
      this._seenPlayers.add(pid)
      this._lastSeenCall.set(pid, this._callCount)
      let track = this._playerStates.get(pid)
      if (track) {
        if (Array.isArray(p)) fillAnyPlayerArr(track, p); else fillPlayerObj(track, p)
      } else {
        track = makePlayerSlot()
        if (Array.isArray(p)) fillAnyPlayerArr(track, p); else fillPlayerObj(track, p)
        this._playerStates.set(pid, track)
        if (typeof window !== 'undefined' && window.__dbgSnap) console.log('[SnapProc] onPlayerJoined id=' + pid + ' pos=' + JSON.stringify(track.position))
        this._callbacks.onPlayerJoined?.(pid, track)
      }
      if (!track.position || !track.rotation || !track.velocity) {
        if (typeof window !== 'undefined' && window.__dbgSnap) console.error('[SnapProc] NULL ARRAYS BUG DETECTED: id=' + pid + ' pos=' + track.position + ' rot=' + track.rotation + ' vel=' + track.velocity)
        if (!track.position) track.position = [0, 0, 0]
        if (!track.rotation) track.rotation = [0, 0, 0, 1]
        if (!track.velocity) track.velocity = [0, 0, 0]
      }
      snapshotForBuffer.players.push(copyPlayerStateInto(this._playerSlotPool.acquire(), track))
    }
    for (const [pid, track] of this._playerStates) {
      if (this._seenPlayers.has(pid)) continue
      if (track.tier === PLAYER_TIER_REDUCED) {
        const lastSeen = this._lastSeenCall.get(pid) || 0
        if (this._callCount - lastSeen < REDUCED_TIER_ABSENCE_GRACE_SNAPSHOTS) {
          snapshotForBuffer.players.push(copyPlayerStateInto(this._playerSlotPool.acquire(), track))
          continue
        }
      }
      this._playerStates.delete(pid); this._lastSeenCall.delete(pid); this._callbacks.onPlayerLeft?.(pid)
    }

    this._processEntities(data, snapshotForBuffer)
    this._releaseQueue.push(snapshotForBuffer)
    this._maybeReleaseOldest()
    return snapshotForBuffer
  }

  _handleEntity(e, snapshotForBuffer) {
    const eid = Array.isArray(e) ? e[0] : e.id
    let track = this._entityStates.get(eid)
    const isFieldDelta = Array.isArray(e) && typeof e[1] === 'number'
    if (isFieldDelta) {
      if (!track) {
        this._deltaFailures++
        this._deltaFailureIds.add(eid)
        if (this._deltaFailures < 10) this._callbacks.onDeltaCorruption?.(eid)
        if (this._deltaFailures >= 10) this._callbacks.onFullSnapshotRequested?.()
        return eid
      }
      fillEntityArr(track, e)
      snapshotForBuffer.entities.push(copyEntityStateInto(this._entitySlotPool.acquire(), track))
    } else {
      if (track) {
        if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
      } else {
        track = makeEntitySlot()
        if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
        this._entityStates.set(eid, track)
        this._callbacks.onEntityAdded?.(eid, track)
      }
      snapshotForBuffer.entities.push(copyEntityStateInto(this._entitySlotPool.acquire(), track))
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
  removePlayer(pid) { this._playerStates.delete(pid); this._lastSeenCall.delete(pid) }
  clear() { this._playerStates.clear(); this._entityStates.clear(); this._lastSeenCall.clear() }
}
