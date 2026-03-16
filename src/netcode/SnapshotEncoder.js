import { pack } from '../protocol/msgpack.js'

function quantize(v, precision) {
  return Math.round(v * precision) / precision
}

const Q1=100, Q2=10000
const VEL_ZERO = [0,0,0]
const SCALE_ONE = [1,1,1]
function encodePlayer(p) {
  const [px,py,pz]=p.position, [rx,ry,rz,rw]=p.rotation, [vx,vy,vz]=p.velocity
  const pitchN=Math.round(((p.lookPitch||0)+Math.PI)/(2*Math.PI)*15)&0xF, yawN=Math.round(((p.lookYaw||0)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)/(2*Math.PI)*15)&0xF
  return [p.id, quantize(px,Q1),quantize(py,Q1),quantize(pz,Q1), quantize(rx,Q2),quantize(ry,Q2),quantize(rz,Q2),quantize(rw,Q2), quantize(vx,Q1),quantize(vy,Q1),quantize(vz,Q1), p.onGround?1:0, Math.round(p.health||0), p.inputSequence||0, p.crouch||0, (pitchN<<4)|yawN]
}

function encodeEntity(e) {
  const [px,py,pz]=e.position, [rx,ry,rz,rw]=e.rotation, v=e.velocity||VEL_ZERO, s=e.scale||SCALE_ONE
  return [e.id, e.model||'', quantize(px,Q1),quantize(py,Q1),quantize(pz,Q1), quantize(rx,Q2),quantize(ry,Q2),quantize(rz,Q2),quantize(rw,Q2), quantize(v[0]||0,Q1),quantize(v[1]||0,Q1),quantize(v[2]||0,Q1), e.bodyType||'static', e.custom||null, quantize(s[0]||1,Q1),quantize(s[1]||1,Q1),quantize(s[2]||1,Q1)]
}

function buildEntityKey(enc, custStr) {
  return [enc[1], enc[2], enc[3], enc[4], enc[5], enc[6], enc[7], enc[8], enc[9], enc[10], enc[11], enc[12], custStr, enc[14], enc[15], enc[16]].join('|')
}

function buildEntry(e, id, prevCache, sleeping) {
  const enc = encodeEntity(e), cust = enc[13]
  const prev = prevCache?.get(id)
  const custStr = (prev && prev.cust === cust) ? prev.custStr : (cust != null ? pack(cust).toString('hex') : '')
  return { enc, k: buildEntityKey(enc, custStr), cust, custStr, isEnv: e._appName === 'environment', sleeping: !!sleeping }
}

const CLOSE2 = 20 * 20

export class SnapshotEncoder {
  static encodePlayersOnce(players) {
    const m = new Map()
    for (const p of (players || [])) m.set(p.id, encodePlayer(p))
    return m
  }

  static filterEncodedPlayers(encodedMap, nearbyIds) {
    const out = []
    for (const id of nearbyIds) {
      const enc = encodedMap.get(id)
      if (enc) out.push(enc)
    }
    return out
  }

  static filterEncodedPlayersWithSelf(encodedMap, nearbyIds, selfId) {
    const out = []
    let hasSelf = false
    for (let i = 0; i < nearbyIds.length; i++) {
      const id = nearbyIds[i]
      if (id === selfId) hasSelf = true
      const enc = encodedMap.get(id)
      if (enc) out.push(enc)
    }
    if (!hasSelf) {
      const self = encodedMap.get(selfId)
      if (self) out.push(self)
    }
    return out
  }

  static encodePlayers(players) {
    return (players || []).map(encodePlayer)
  }

  static encodeStaticEntities(entities, prevStaticMap) {
    const nextMap = new Map()
    const allEntries = []
    const changedEntries = []
    let changed = false
    for (const e of entities) {
      if (e.bodyType !== 'static') continue
      const enc = encodeEntity(e)
      const prev = prevStaticMap.get(e.id)
      const cust = enc[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? pack(cust).toString('hex') : '')
      const k = buildEntityKey(enc, custStr)
      nextMap.set(e.id, [k, cust, custStr])
      allEntries.push({ enc, k, id: e.id })
      if (!prev || prev[0] !== k) { changedEntries.push({ enc, k, id: e.id }); changed = true }
    }
    if (nextMap.size !== prevStaticMap.size) changed = true
    return { staticEntries: allEntries, changedEntries, staticMap: nextMap, staticChanged: changed }
  }

  static buildStaticIds(staticMap) { return new Set(staticMap.keys()) }

  static refreshDynamicCache(cache, activeIds, entities) {
    const envIds = cache._envIds || []; envIds.length = 0
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      const enc = encodeEntity(e), cust = enc[13]
      let entry = cache.get(id)
      if (entry) {
        const custStr = entry.cust === cust ? entry.custStr : (cust != null ? pack(cust).toString('hex') : '')
        entry.enc = enc; entry.k = buildEntityKey(enc, custStr); entry.cust = cust; entry.custStr = custStr; entry.sleeping = false
      } else {
        entry = buildEntry(e, id, null, false); cache.set(id, entry)
      }
      if (entry.isEnv) envIds.push(id)
    }
    cache._envIds = envIds; return cache
  }

  static buildDynamicCache(activeIds, sleepingIds, suspendedIds, entities, prevCache) {
    const cache = new Map(), envIds = []
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      const entry = buildEntry(e, id, prevCache, false)
      cache.set(id, entry); if (entry.isEnv) envIds.push(id)
    }
    for (const idSet of [sleepingIds, suspendedIds]) {
      for (const id of idSet) {
        if (prevCache?.has(id)) { cache.set(id, prevCache.get(id)); continue }
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        cache.set(id, buildEntry(e, id, prevCache, true))
      }
    }
    cache._envIds = envIds; return cache
  }


  static encodeDeltaFromCache(tick, serverTime, dynCache, relevantIds, prevEntityMap, preEncodedPlayers, staticEntries, staticEntityMap, staticEntityIds, precomputedRemoved, seqNum, viewerPos) {
    const entities = []
    const nextMap = new Map()
    if (staticEntries) {
      for (const { enc } of staticEntries) entities.push(enc)
    }
    const vx = viewerPos ? viewerPos[0] : 0
    const vy = viewerPos ? viewerPos[1] : 0
    const vz = viewerPos ? viewerPos[2] : 0
    const useDistTier = seqNum !== undefined && viewerPos && seqNum % 2 !== 0
    const relevantCount = Array.isArray(relevantIds) ? relevantIds.length : (relevantIds ? relevantIds.size : 0)
    const iterIds = (relevantIds && dynCache.size > relevantCount) ? relevantIds : null
    const relevantLookup = (!iterIds && Array.isArray(relevantIds)) ? new Set(relevantIds) : null
    if (iterIds) {
      for (const id of iterIds) {
        const entry = dynCache.get(id)
        if (!entry) continue
        if (useDistTier && !entry.isEnv) {
          const enc = entry.enc
          const dx = enc[2] - vx, dy = enc[3] - vy, dz = enc[4] - vz
          if (dx*dx + dy*dy + dz*dz >= CLOSE2) { nextMap.set(id, prevEntityMap.get(id) || [entry.k, entry.cust, entry.custStr]); continue }
        }
        const { enc, k, cust, custStr } = entry
        nextMap.set(id, [k, cust, custStr])
        const prev = prevEntityMap.get(id)
        if (!prev || prev[0] !== k) entities.push(enc)
      }
      const envIds = dynCache._envIds || []
      for (const id of envIds) {
        const entry = dynCache.get(id)
        if (!entry) continue
        const { enc, k, cust, custStr } = entry
        nextMap.set(id, [k, cust, custStr])
        const prev = prevEntityMap.get(id)
        if (!prev || prev[0] !== k) entities.push(enc)
      }
    } else {
      for (const [id, entry] of dynCache) {
        if (entry._envIds !== undefined) continue
        if (!entry.isEnv && relevantIds) {
          if (relevantLookup ? !relevantLookup.has(id) : !relevantIds.has(id)) continue
        }
        if (useDistTier && !entry.isEnv) {
          const enc = entry.enc
          const dx = enc[2] - vx, dy = enc[3] - vy, dz = enc[4] - vz
          if (dx*dx + dy*dy + dz*dz >= CLOSE2) { nextMap.set(id, prevEntityMap.get(id) || [entry.k, entry.cust, entry.custStr]); continue }
        }
        const { enc, k, cust, custStr } = entry
        nextMap.set(id, [k, cust, custStr])
        const prev = prevEntityMap.get(id)
        if (!prev || prev[0] !== k) entities.push(enc)
      }
    }
    let removed = precomputedRemoved
    if (!removed) {
      removed = []
      for (const id of prevEntityMap.keys()) {
        if (!dynCache.has(id) && !(staticEntityIds && staticEntityIds.has(id))) removed.push(id)
      }
    }
    return {
      encoded: { tick: tick || 0, serverTime, players: preEncodedPlayers || [], entities, removed: removed.length ? removed : undefined, delta: 1 },
      entityMap: nextMap
    }
  }

  static encodeDelta(snapshot, prevEntityMap, preEncodedPlayers, staticEntries, staticMap, staticIds) {
    const players = preEncodedPlayers || (snapshot.players || []).map(encodePlayer)
    const dynIds = new Set()
    const entities = []
    const nextMap = new Map()
    if (staticEntries) {
      for (const { enc } of staticEntries) entities.push(enc)
    }
    for (const e of snapshot.entities || []) {
      if (e.bodyType === 'static' && staticEntries) continue
      const encoded = encodeEntity(e)
      dynIds.add(e.id)
      const prev = prevEntityMap.get(e.id)
      const cust = encoded[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? pack(cust).toString('hex') : '')
      const k = buildEntityKey(encoded, custStr)
      nextMap.set(e.id, [k, cust, custStr])
      if (!prev || prev[0] !== k) entities.push(encoded)
    }
    const removed = []
    for (const id of prevEntityMap.keys()) {
      if (!dynIds.has(id) && !(staticIds && staticIds.has(id))) removed.push(id)
    }
    return {
      encoded: { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities, removed: removed.length ? removed : undefined, delta: 1 },
      entityMap: nextMap
    }
  }

  static encode(snapshot) {
    const players = (snapshot.players || []).map(encodePlayer)
    const entities = (snapshot.entities || []).map(encodeEntity)
    return { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities }
  }

  static decode(data) {
    if (!data.players || !Array.isArray(data.players)) return data
    const TAU = 2 * Math.PI
    const players = data.players.map(p => !Array.isArray(p) ? p : { id:p[0], position:[p[1],p[2],p[3]], rotation:[p[4],p[5],p[6],p[7]], velocity:[p[8],p[9],p[10]], onGround:p[11]===1, health:p[12], inputSequence:p[13], crouch:p[14]||0, lookPitch:((p[15]||0)>>4)/15*TAU-Math.PI, lookYaw:((p[15]||0)&0xF)/15*TAU })
    const entities = (data.entities||[]).map(e => !Array.isArray(e) ? e : { id:e[0], model:e[1], position:[e[2],e[3],e[4]], rotation:[e[5],e[6],e[7],e[8]], velocity:[e[9],e[10],e[11]], bodyType:e[12], custom:e[13], scale:[e[14]??1,e[15]??1,e[16]??1] })
    return { tick:data.tick, serverTime:data.serverTime, players, entities, delta:data.delta, removed:data.removed }
  }
}
