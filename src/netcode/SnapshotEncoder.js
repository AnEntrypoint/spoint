import { getComponentSchema, encodeCustomFields, decodeCustomFields } from '../../apps/_lib/ComponentSchema.js'
import {
  BIN_RECORD_BYTES, POS_I16_MAX, SCALE_U16_MAX, clampI16, clampU16Scale,
  packBinRecord, unpackBinRecord, packQuat, unpackQuat
} from './SnapshotBinFormat.js'
import { FNV1A_32_OFFSET_BASIS, fnv1aStepString, fnv1aStepBytes, fnv1aStepFloat32 } from '../shared/fnv1a.js'

export { unpackBinRecord, packQuat, unpackQuat }

const TAU = 2 * Math.PI, HALF_PI = Math.PI / 2
const VEL_ZERO = [0,0,0]
const SCALE_ONE = [1,1,1]
const MIN_FULL_PLAYER_RECORD_LEN = 7
const MIN_FULL_ENTITY_RECORD_LEN = 6

const PLAYER_FLAG_ONGROUND = 1 << 0
function encodePlayer(p) {
  const [px,py,pz]=p.position, [rx,ry,rz,rw]=p.rotation, [vx,vy,vz]=p.velocity
  const pitchN=Math.max(0,Math.min(255,Math.round(((p.lookPitch||0)+HALF_PI)/Math.PI*255)))
  const yawN=Math.round(((p.lookYaw||0)%TAU+TAU)%TAU/TAU*256)&0xFF
  const bin = packBinRecord(px,py,pz, packQuat(rx,ry,rz,rw), vx,vy,vz, 1,1,1, p.onGround?PLAYER_FLAG_ONGROUND:0)
  return [p.id, bin, p.onGround?1:0, Math.round(p.health||0), p.inputSequence||0, p.crouch||0, (pitchN<<8)|yawN, p.expr||0, p.weapon||0]
}

const _playerEncPool = new Map()
const _playerEncMap = new Map()
let _playerEncGen = 0
function encodePlayerInto(p, rec) {
  const [px,py,pz]=p.position, [rx,ry,rz,rw]=p.rotation, [vx,vy,vz]=p.velocity
  const pitchN=Math.max(0,Math.min(255,Math.round(((p.lookPitch||0)+HALF_PI)/Math.PI*255)))
  const yawN=Math.round(((p.lookYaw||0)%TAU+TAU)%TAU/TAU*256)&0xFF
  rec.flip ^= 1
  const bin = packBinRecord(px,py,pz, packQuat(rx,ry,rz,rw), vx,vy,vz, 1,1,1, p.onGround?PLAYER_FLAG_ONGROUND:0, rec.bins[rec.flip])
  const a = rec.arr
  a[0]=p.id; a[1]=bin; a[2]=p.onGround?1:0; a[3]=Math.round(p.health||0); a[4]=p.inputSequence||0; a[5]=p.crouch||0; a[6]=(pitchN<<8)|yawN; a[7]=p.expr||0; a[8]=p.weapon||0
  return a
}

export const PLAYER_LOD_FULL_COUNT = 30
export const PLAYER_LOD_REDUCED2 = 120 * 120
export const PLAYER_LOD_REDUCED_TICKMOD = 1
export const PLAYER_LOD_REDUCED_HZ = 5

export const PLAYER_TIER_FULL = 0
export const PLAYER_TIER_REDUCED = 1
export const PLAYER_TIER_DOT = 2

function encodeReducedPlayer(p) {
  const [px, , pz] = p.position
  const yawN = Math.round(((p.lookYaw || 0) % TAU + TAU) % TAU / TAU * 256) & 0xFF
  return [p.id, clampI16(px), clampI16(pz), yawN, PLAYER_TIER_REDUCED]
}

function dist2(ax, ay, az, bx, by, bz) { const dx = ax-bx, dy = ay-by, dz = az-bz; return dx*dx+dy*dy+dz*dz }

export function buildCrowdDots(players, viewerPos, dotCellM) {
  if (!players || players.length === 0) return []
  const cell = dotCellM || 25
  const buckets = new Map()
  for (const p of players) {
    const pos = p.position; if (!pos) continue
    const cx = Math.floor(pos[0] / cell), cz = Math.floor(pos[2] / cell)
    const key = cx * 1000003 + cz
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }
  const out = []
  for (const [key, count] of buckets) {
    const cz = key % 1000003
    const cx = (key - cz) / 1000003
    out.push([cx, cz, count])
  }
  return out
}

export function classifyPlayerTiers(playersById, nearbyIds, viewerPos, selfId) {
  const vx = viewerPos[0], vy = viewerPos[1], vz = viewerPos[2]
  const near = []
  for (const id of nearbyIds) {
    if (id === selfId) continue
    const p = playersById.get(id)
    if (!p || !p.position) continue
    near.push({ id, p, d2: dist2(p.position[0], p.position[1], p.position[2], vx, vy, vz) })
  }
  near.sort((a, b) => a.d2 - b.d2)
  const full = [], reduced = [], dotPlayers = []
  for (let i = 0; i < near.length; i++) {
    const { id, p, d2 } = near[i]
    if (i < PLAYER_LOD_FULL_COUNT) full.push(id)
    else if (d2 < PLAYER_LOD_REDUCED2) reduced.push(id)
    else dotPlayers.push(p)
  }
  return { full, reduced, dotPlayers }
}

export function filterEncodedPlayersTiered(encodedMap, playersById, nearbyIds, selfId, viewerPos, tick, reducedTickMod) {
  const { full, reduced, dotPlayers } = classifyPlayerTiers(playersById, nearbyIds, viewerPos, selfId)
  const out = []
  const selfEnc = encodedMap.get(selfId); if (selfEnc) out.push(selfEnc)
  for (const id of full) { const enc = encodedMap.get(id); if (enc) out.push(enc) }
  const mod = Math.max(1, reducedTickMod || 1)
  for (const id of reduced) {
    if (mod > 1 && (tick % mod) !== 0) continue
    const p = playersById.get(id)
    if (p) out.push(encodeReducedPlayer(p))
  }
  return { players: out, dots: buildCrowdDots(dotPlayers, viewerPos) }
}

const FIELD_POS = 1 << 0
const FIELD_ROT = 1 << 1
const FIELD_VEL = 1 << 2
const FIELD_SCALE = 1 << 3
const FIELD_BODY = 1 << 4
const FIELD_CUSTOM = 1 << 5
const FIELD_SLEEP = 1 << 6
const FIELD_MODEL = 1 << 7

function fillEntityEnc(e, enc) {
  const pos=e.position, rot=e.rotation, v=e.velocity||VEL_ZERO, s=e.scale||SCALE_ONE
  const px=pos[0],py=pos[1],pz=pos[2],rx=rot[0],ry=rot[1],rz=rot[2],rw=rot[3]
  enc[0]=e.id; enc[1]=e.model||''
  enc[2]=packBinRecord(px,py,pz, packQuat(rx,ry,rz,rw), v[0]||0,v[1]||0,v[2]||0, s[0]||1,s[1]||1,s[2]||1, 0)
  enc[3]=e.bodyType||'static'; enc[4]=e.custom||null
  enc[5]=e._dynSleeping?1:0
  return enc
}

export class TombstoneLog {
  constructor() { this._list = [] ; this._minTick = 0 }
  push(id, tick) { this._list.push({ id, tick }) }
  pruneBefore(minTick) {
    if (this._list.length === 0) return
    let i = 0
    while (i < this._list.length && this._list[i].tick < minTick) i++
    if (i > 0) this._list = this._list.slice(i)
    this._minTick = minTick
  }
  forClient(sinceTick, prevEntityMap, out) {
    out.length = 0
    for (let i = 0; i < this._list.length; i++) {
      const t = this._list[i]
      if (t.tick > sinceTick && prevEntityMap.has(t.id)) out.push(t.id)
    }
    return out
  }
}

const ACKED_BASELINE_HISTORY = 64

export class AckedBaseline {
  constructor() {
    this._history = new Map()
    this._order = []
    this._ackedTick = 0
    this._ackedMap = new Map()
  }

  recordSent(tick, entityMap) {
    if (this._history.has(tick)) return
    this._history.set(tick, entityMap)
    this._order.push(tick)
    while (this._order.length > ACKED_BASELINE_HISTORY) {
      const evicted = this._order.shift()
      this._history.delete(evicted)
    }
  }

  applyAck(ackTick) {
    if (!ackTick || ackTick <= this._ackedTick) return false
    const map = this._history.get(ackTick)
    if (!map) return false
    this._ackedMap = map
    this._ackedTick = ackTick
    while (this._order.length && this._order[0] <= ackTick) this._history.delete(this._order.shift())
    return true
  }

  baseline() { return this._ackedMap }
  ackedTick() { return this._ackedTick }
}

const _binA = {}, _binB = {}

function computeFieldDelta(prevEnc, enc) {
  if (!prevEnc) return null
  let mask = 0
  const a = prevEnc[2], b = enc[2]
  let binChanged = a !== b
  if (binChanged) {
    binChanged = false
    for (let i = 0; i < BIN_RECORD_BYTES; i++) { if (a[i] !== b[i]) { binChanged = true; break } }
  }
  if (binChanged) {
    unpackBinRecord(a, _binA); unpackBinRecord(b, _binB)
    if (_binA.px !== _binB.px || _binA.py !== _binB.py || _binA.pz !== _binB.pz) mask |= FIELD_POS
    if (_binA.qrot !== _binB.qrot) mask |= FIELD_ROT
    if (_binA.vx !== _binB.vx || _binA.vy !== _binB.vy || _binA.vz !== _binB.vz) mask |= FIELD_VEL
    if (_binA.sx !== _binB.sx || _binA.sy !== _binB.sy || _binA.sz !== _binB.sz) mask |= FIELD_SCALE
  }
  if (enc[3] !== prevEnc[3]) mask |= FIELD_BODY
  if (enc[4] !== prevEnc[4]) mask |= FIELD_CUSTOM
  if (enc[5] !== prevEnc[5]) mask |= FIELD_SLEEP
  if (enc[1] !== prevEnc[1]) mask |= FIELD_MODEL
  if (mask === 0) return null
  const out = [enc[0], mask]
  if (mask & FIELD_MODEL) out.push(enc[1])
  if (mask & (FIELD_POS|FIELD_ROT|FIELD_VEL|FIELD_SCALE)) out.push(enc[2])
  if (mask & FIELD_BODY) out.push(enc[3])
  if (mask & FIELD_CUSTOM) out.push(enc[4])
  if (mask & FIELD_SLEEP) out.push(enc[5])
  return out
}



export function encodeEntity(e) {
  return fillEntityEnc(e, new Array(6))
}

function buildEntityKey(enc, custKey) {
  let hash = FNV1A_32_OFFSET_BASIS
  hash = fnv1aStepString(hash, enc[1])
  hash = fnv1aStepBytes(hash, enc[2])
  hash = fnv1aStepString(hash, enc[3])
  hash = fnv1aStepString(hash, '' + custKey)
  hash = fnv1aStepFloat32(hash, enc[5])
  return hash >>> 0
}

function custToStr(cust) { return cust != null ? JSON.stringify(cust) : '' }

export function encodeCustomBySchema(schemaName, obj) {
  const schema = getComponentSchema(schemaName)
  if (!schema) return null
  return encodeCustomFields(schema, obj)
}

export function decodeCustomBySchema(schemaName, buf) {
  const schema = getComponentSchema(schemaName)
  if (!schema) return null
  return decodeCustomFields(schema, buf)
}

function resolveCustKey(e, cust, prevCust, prevKey) {
  if (e && typeof e._customV === 'number') return e._customV
  return (prevCust === cust) ? prevKey : custToStr(cust)
}

function resolveKey(entry) {
  if (!entry._dirty) return entry.k
  const cust = entry.enc[4]
  entry.custStr = resolveCustKey(entry.srcEntity, cust, entry.cust, entry.custStr)
  entry.cust = cust
  entry.k = buildEntityKey(entry.enc, entry.custStr)
  entry._dirty = false
  return entry.k
}

function buildEntry(e, id, prevCache, sleeping, simulated) {
  const enc = encodeEntity(e), cust = enc[4]
  const prev = prevCache?.get(id)
  const custStr = resolveCustKey(e, cust, prev?.cust, prev?.custStr)
  return { enc, k: buildEntityKey(enc, custStr), cust, custStr, isEnv: !!e.custom?._interior, sleeping: !!sleeping, _sleepJustSet: !!sleeping, simulated: !!simulated, _dirty: false, srcEntity: e, _lastCustomV: typeof e._customV === 'number' ? e._customV : null, _pBin: null, _pX: 0, _pY: 0, _pZ: 0, _pVelScore: 0 }
}

const NEAR2 = 20 * 20
const MID2 = 60 * 60
const _distScratch = {}

export const PROP_MAX_HZ = 15
export const PROP_SLEEP_TICKMOD = 60
export function propTickMod(snapHz) {
  if (!snapHz || snapHz <= PROP_MAX_HZ) return 1
  return Math.max(1, Math.ceil(snapHz / PROP_MAX_HZ))
}

function stripVelocityForFar(enc) {
  unpackBinRecord(enc[2], _distScratch)
  const noVelBin = packBinRecord(_distScratch.px, _distScratch.py, _distScratch.pz, _distScratch.qrot, 0, 0, 0, _distScratch.sx, _distScratch.sy, _distScratch.sz, _distScratch.flags)
  return [enc[0], enc[1], noVelBin, enc[3], enc[4], enc[5]]
}

export function primeEntryDecode(entry) {
  if (entry._pBin === entry.enc[2]) return entry
  unpackBinRecord(entry.enc[2], _distScratch)
  entry._pBin = entry.enc[2]
  entry._pX = _distScratch.px; entry._pY = _distScratch.py; entry._pZ = _distScratch.pz
  const velSq = _distScratch.vx*_distScratch.vx + _distScratch.vy*_distScratch.vy + _distScratch.vz*_distScratch.vz
  entry._pVelScore = velSq >= 100 ? 1 : Math.sqrt(velSq) * 0.1
  return entry
}

function nearestViewerDist2(entry, viewers) {
  primeEntryDecode(entry)
  let best = Infinity
  for (let i = 0; i + 2 < viewers.length; i += 3) {
    const dx = entry._pX-viewers[i], dy = entry._pY-viewers[i+1], dz = entry._pZ-viewers[i+2]
    const d2 = dx*dx+dy*dy+dz*dz
    if (d2 < best) best = d2
  }
  return best
}

function applyEntry(id, entry, nextMap, entities, prevEntityMap, viewers, snapshotSeq, propModCap) {
  const k = resolveKey(entry)
  let enc = entry.enc
  let farTier = false
  let extraMod = 1
  if (!entry.isEnv) {
    if (entry.sleeping) {
      if (entry._sleepJustSet) entry._sleepJustSet = false
      else extraMod = PROP_SLEEP_TICKMOD
    } else if (propModCap > 1 && entry.simulated) extraMod = propModCap
  }
  const prev = prevEntityMap.get(id)
  const prevCustStr = prev?.[2]
  const viewerMissedCustomChange = prevCustStr !== entry.custStr
  if (extraMod !== 1 && viewerMissedCustomChange) extraMod = 1
  let tickMod = extraMod
  if (viewers && !entry.isEnv) {
    const d2 = nearestViewerDist2(entry, viewers)
    const distTickMod = d2 < NEAR2 ? 1 : d2 < MID2 ? 4 : 16
    farTier = distTickMod === 16
    if (distTickMod > tickMod) tickMod = distTickMod
  }
  const viewerHasBaseline = !!prev
  if (viewerHasBaseline && tickMod !== 1 && (snapshotSeq % tickMod) !== 0) { nextMap.set(id, prev); return }
  if (farTier) enc = stripVelocityForFar(enc)
  nextMap.set(id, [k, entry.cust, entry.custStr, enc])
  if (!prev || prev[0] !== k) {
    if (prev && prev[3]) {
      const fd = computeFieldDelta(prev[3], enc)
      if (fd) {
        if (farTier && fd[1] === FIELD_ROT) return
        entities.push(fd); return
      }
    }
    entities.push(enc)
  }
}

export function updateTombstones(tombstoneLog, tick, dynCache, staticEntityIds, prevKnownIds) {
  const staticSize = staticEntityIds ? staticEntityIds.size : 0
  if (prevKnownIds && prevKnownIds._dyn === dynCache && prevKnownIds._dynSize === dynCache.size && prevKnownIds._static === staticEntityIds && prevKnownIds._staticSize === staticSize) return prevKnownIds
  const known = new Set(dynCache.keys())
  if (staticEntityIds) for (const id of staticEntityIds) known.add(id)
  if (prevKnownIds) {
    for (const id of prevKnownIds) { if (!known.has(id)) tombstoneLog.push(id, tick) }
  }
  known._dyn = dynCache; known._dynSize = dynCache.size; known._static = staticEntityIds; known._staticSize = staticSize
  return known
}

export class SnapshotEncoder {
  static encodeCustomBySchema(schemaName, obj) { return encodeCustomBySchema(schemaName, obj) }
  static decodeCustomBySchema(schemaName, buf) { return decodeCustomBySchema(schemaName, buf) }

  static encodePlayersOnce(players) {
    const m = _playerEncMap; m.clear()
    const gen = ++_playerEncGen
    for (const p of (players || [])) {
      let rec = _playerEncPool.get(p.id)
      if (!rec) { rec = { arr: new Array(9), bins: [new Uint8Array(BIN_RECORD_BYTES), new Uint8Array(BIN_RECORD_BYTES)], flip: 0, gen }; _playerEncPool.set(p.id, rec) }
      rec.gen = gen
      m.set(p.id, encodePlayerInto(p, rec))
    }
    if ((gen & 255) === 0 && _playerEncPool.size > m.size) { for (const [id, rec] of _playerEncPool) if (rec.gen !== gen) _playerEncPool.delete(id) }
    return m
  }

  static filterEncodedPlayers(encodedMap, nearbyIds) {
    const out = []; for (const id of nearbyIds) { const enc = encodedMap.get(id); if (enc) out.push(enc) }; return out
  }

  static filterEncodedPlayersWithSelf(encodedMap, nearbyIds, selfId) {
    const out = []; let hasSelf = false
    for (let i = 0; i < nearbyIds.length; i++) { const id = nearbyIds[i]; if (id === selfId) hasSelf = true; const enc = encodedMap.get(id); if (enc) out.push(enc) }
    if (!hasSelf) { const self = encodedMap.get(selfId); if (self) out.push(self) }
    return out
  }

  static encodePlayers(players) { return (players || []).map(encodePlayer) }

  static encodeStaticEntities(entities, prevStaticMap) {
    const nextMap = new Map()
    const allEntries = []
    const changedEntries = []
    let changed = false
    for (const e of entities) {
      if (e.bodyType !== 'static') continue
      const enc = encodeEntity(e)
      const prev = prevStaticMap.get(e.id)
      const cust = enc[4]
      const custStr = resolveCustKey(e, cust, prev?.[1], prev?.[2])
      const k = buildEntityKey(enc, custStr)
      nextMap.set(e.id, [k, cust, custStr])
      allEntries.push({ enc, k, id: e.id })
      if (!prev || prev[0] !== k) { changedEntries.push({ enc, k, id: e.id }); changed = true }
    }
    if (nextMap.size !== prevStaticMap.size) changed = true
    return { staticEntries: allEntries, changedEntries, staticMap: nextMap, staticChanged: changed }
  }

  static buildStaticIds(staticMap) { return new Set(staticMap.keys()) }

  static refreshDynamicCache(cache, activeIds, entities, sleepingIds, suspendedIds, unmanagedIds) {
    const envIds = cache._envIds || []; envIds.length = 0
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      let entry = cache.get(id)
      if (entry) {
        fillEntityEnc(e, entry.enc)
        entry._dirty = true; entry.sleeping = false; entry.simulated = e.bodyType === 'dynamic'; entry.srcEntity = e
      } else {
        entry = buildEntry(e, id, null, false, e.bodyType === 'dynamic'); cache.set(id, entry)
      }
      if (entry.isEnv) envIds.push(id)
    }
    if (unmanagedIds) {
      for (const id of unmanagedIds) {
        const e = entities.get(id); if (!e) continue
        let entry = cache.get(id)
        if (entry) {
          fillEntityEnc(e, entry.enc)
          entry._dirty = true; entry.sleeping = false; entry.simulated = false; entry.srcEntity = e
        } else {
          entry = buildEntry(e, id, null, false, false); cache.set(id, entry)
        }
        if (entry.isEnv) envIds.push(id)
      }
    }
    for (const idSet of [sleepingIds, suspendedIds]) {
      if (!idSet) continue
      for (const id of idSet) {
        const entry = cache.get(id)
        if (!entry) continue
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        if (entry.sleeping) {
          const cv = typeof e._customV === 'number' ? e._customV : null
          const customChangedWhileAsleep = cv !== null && cv !== entry._lastCustomV
          if (customChangedWhileAsleep) { entry._lastCustomV = cv; entry._dirty = true; entry.srcEntity = e }
          continue
        }
        fillEntityEnc(e, entry.enc)
        entry._dirty = true; entry.sleeping = true; entry._sleepJustSet = true; entry.srcEntity = e
        entry._lastCustomV = typeof e._customV === 'number' ? e._customV : null
        if (entry.isEnv) envIds.push(id)
      }
    }
    cache._envIds = envIds; return cache
  }

  static buildDynamicCache(activeIds, sleepingIds, suspendedIds, entities, prevCache, unmanagedIds) {
    const cache = new Map(), envIds = []
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      const entry = buildEntry(e, id, prevCache, false, e.bodyType === 'dynamic')
      cache.set(id, entry); if (entry.isEnv) envIds.push(id)
    }
    if (unmanagedIds) {
      for (const id of unmanagedIds) {
        const e = entities.get(id); if (!e) continue
        const entry = buildEntry(e, id, prevCache, false, false)
        cache.set(id, entry); if (entry.isEnv) envIds.push(id)
      }
    }
    for (const idSet of [sleepingIds, suspendedIds]) {
      for (const id of idSet) {
        if (prevCache?.has(id)) {
          const entry = prevCache.get(id)
          cache.set(id, entry)
          if (entry.isEnv) envIds.push(id)
          continue
        }
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        const entry = buildEntry(e, id, prevCache, true)
        cache.set(id, entry)
        if (entry.isEnv) envIds.push(id)
      }
    }
    cache._envIds = envIds; return cache
  }

  static encodeDeltaFromCache(tick, serverTime, dynCache, relevantIds, prevEntityMap, preEncodedPlayers, staticEntries, staticEntityMap, staticEntityIds, seqNum, viewerPos, scratch, tombstoneLog, clientLastTick, snapHz) {
    const entities = scratch ? scratch.entities : []
    const nextMap = scratch ? scratch.spareMap : new Map()
    if (scratch) { entities.length = 0; nextMap.clear() }
    if (staticEntries) for (const { enc } of staticEntries) entities.push(enc)
    const viewers = (seqNum !== undefined && viewerPos && viewerPos.length >= 3) ? viewerPos : null
    const seq = seqNum || 0
    const propModCap = propTickMod(snapHz)
    const relevantCount = Array.isArray(relevantIds) ? relevantIds.length : (relevantIds ? relevantIds.size : 0)
    const iterIds = (relevantIds && dynCache.size > relevantCount) ? relevantIds : null
    const relevantLookup = (!iterIds && Array.isArray(relevantIds)) ? new Set(relevantIds) : null
    if (iterIds) {
      for (const id of iterIds) { const entry = dynCache.get(id); if (entry) applyEntry(id, entry, nextMap, entities, prevEntityMap, viewers, seq, propModCap) }
      for (const id of (dynCache._envIds || [])) { const entry = dynCache.get(id); if (entry) applyEntry(id, entry, nextMap, entities, prevEntityMap, null, seq, propModCap) }
    } else {
      for (const [id, entry] of dynCache) {
        if (!entry.isEnv && relevantIds && (relevantLookup ? !relevantLookup.has(id) : !relevantIds.has(id))) continue
        applyEntry(id, entry, nextMap, entities, prevEntityMap, viewers, seq, propModCap)
      }
    }
    const removed = scratch ? scratch.removed : []
    if (scratch) removed.length = 0
    if (tombstoneLog) {
      tombstoneLog.forClient(clientLastTick || 0, prevEntityMap, removed)
    } else {
      for (const id of prevEntityMap.keys()) { if (!dynCache.has(id) && !(staticEntityIds && staticEntityIds.has(id))) removed.push(id) }
    }
    return { encoded: { tick: tick||0, serverTime, players: preEncodedPlayers||[], entities, removed: removed.length ? removed : undefined, delta: 1 }, entityMap: nextMap }
  }

  static encodeDelta(snapshot, prevEntityMap, preEncodedPlayers, staticEntries, staticMap, staticIds) {
    const players = preEncodedPlayers || (snapshot.players || []).map(encodePlayer)
    const dynIds = new Set(), entities = [], nextMap = new Map()
    if (staticEntries) for (const { enc } of staticEntries) entities.push(enc)
    for (const e of snapshot.entities || []) {
      if (e.bodyType === 'static' && staticEntries) continue
      const encoded = encodeEntity(e); dynIds.add(e.id)
      const prev = prevEntityMap.get(e.id), cust = encoded[4]
      const custStr = resolveCustKey(e, cust, prev?.[1], prev?.[2])
      const k = buildEntityKey(encoded, custStr); nextMap.set(e.id, [k, cust, custStr, encoded])
      if (!prev || prev[0] !== k) {
        if (prev && prev[3]) {
          const fd = computeFieldDelta(prev[3], encoded)
          if (fd) { entities.push(fd); continue }
        }
        entities.push(encoded)
      }
    }
    const removed = []; for (const id of prevEntityMap.keys()) { if (!dynIds.has(id) && !(staticIds && staticIds.has(id))) removed.push(id) }
    return { encoded: { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities, removed: removed.length ? removed : undefined, delta: 1 }, entityMap: nextMap }
  }

  static encodeDeltaAcked(snapshot, ackedBaseline, preEncodedPlayers, staticEntries, staticMap, staticIds) {
    const prevEntityMap = ackedBaseline.baseline()
    const r = SnapshotEncoder.encodeDelta(snapshot, prevEntityMap, preEncodedPlayers, staticEntries, staticMap, staticIds)
    ackedBaseline.recordSent(snapshot.tick || 0, r.entityMap)
    return r
  }

  static encode(snapshot) {
    const players = (snapshot.players || []).map(encodePlayer)
    const entities = (snapshot.entities || []).map(encodeEntity)
    return { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities }
  }

  static decode(data) {
    if (!data.players || !Array.isArray(data.players)) return data
    const bin = {}
    const players = data.players.map(p => {
      if (!Array.isArray(p)) return p
      if (p.length < MIN_FULL_PLAYER_RECORD_LEN) return null
      unpackBinRecord(p[1], bin)
      const rot = unpackQuat(bin.qrot, [0,0,0,0])
      return { id:p[0], position:[bin.px,bin.py,bin.pz], rotation:rot, velocity:[bin.vx,bin.vy,bin.vz], onGround:p[2]===1, health:p[3], inputSequence:p[4], crouch:p[5]||0, lookPitch:(((p[6]||0)>>8)&0xFF)/255*Math.PI-HALF_PI, lookYaw:((p[6]||0)&0xFF)/256*TAU, expr:p[7]||0, weapon:p[8]||0 }
    }).filter(p => p !== null)
    const entities = (data.entities||[]).map(e => {
      if (!Array.isArray(e)) return e
      if (e.length < MIN_FULL_ENTITY_RECORD_LEN) return null
      unpackBinRecord(e[2], bin)
      const rot = unpackQuat(bin.qrot, [0,0,0,0])
      return { id:e[0], model:e[1], position:[bin.px,bin.py,bin.pz], rotation:rot, velocity:[bin.vx,bin.vy,bin.vz], bodyType:e[3], custom:e[4], scale:[bin.sx,bin.sy,bin.sz], sleeping:e[5]===1 }
    }).filter(e => e !== null)
    return { tick:data.tick, serverTime:data.serverTime, players, entities, delta:data.delta, removed:data.removed }
  }
}
