import { encodePlayer, encodeEntity } from './encoder/BaseEncoder.js'
import { DeltaEncoder, isEncChanged } from './encoder/DeltaEncoder.js'

let _stateIdCounter = 1000000

export { encodePlayer }

export class SnapshotEncoder {
  static encodePlayers(p) { const len = p.length, out = new Array(len); for (let i = 0; i < len; i++) out[i] = encodePlayer(p[i]); return out }
  static encodeStaticEntities(e, p) { return DeltaEncoder.encodeStatic(e, p) }
  static buildStaticIds(m) { return new Set(m.keys()) }
  static updateDynamicCache(p, a, e) { return DeltaEncoder.updateDynamicCache(p, a, e) }
  static encodeDynamicEntitiesOnce(e, p) { return DeltaEncoder.encodeDynamicOnce(e, p) }
  static encodeDeltaFromCache(t, s, d, r, p, pre, st, sti) { return DeltaEncoder.encodeDeltaFromCache(t, s, d, r, p, pre, st, sti) }

  static encodeDelta(snapshot, prevMap, preEncPlayers, statEntries, statIds) {
    const players = preEncPlayers || SnapshotEncoder.encodePlayers(snapshot.players || [])
    const entities = []; const nextMap = new Map(); if (statEntries) { for (let i = 0; i < statEntries.length; i++) entities.push(statEntries[i].enc) }
    const ents = snapshot.entities || []
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i]; if (e.bodyType === 'static' && statEntries) continue; const encoded = encodeEntity(e); const prev = prevMap.get(e.id); const cust = encoded[13]
      let sid = prev ? (typeof prev === 'number' ? prev : prev.stateId) : _stateIdCounter++
      if (prev && typeof prev === 'object' && prev.enc) {
        let changed = isEncChanged(encoded, prev.enc)
        if (!changed && cust !== prev.cust) { const n = (cust != null ? JSON.stringify(cust) : ''); if (n !== (prev.custStr || '')) { changed = true } }
        if (changed) sid = _stateIdCounter++
      } else if (prev && typeof prev !== 'number') {
        sid = _stateIdCounter++
      }
      nextMap.set(e.id, sid); if (prev !== sid) entities.push(encoded)
    }
    const rem = []; for (const id of prevMap.keys()) { if (!nextMap.has(id) && !(statIds && statIds.has(id))) rem.push(id) }
    return { encoded: { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities, removed: rem.length ? rem : undefined, delta: 1 }, entityMap: nextMap }
  }

  static encode(s) {
    const p = SnapshotEncoder.encodePlayers(s.players || []), ents = s.entities || [], e = new Array(ents.length)
    for (let i = 0; i < ents.length; i++) e[i] = encodeEntity(ents[i])
    return { tick: s.tick || 0, serverTime: s.serverTime, players: p, entities: e }
  }

  static decode(d) {
    if (d.players && Array.isArray(d.players)) {
      const p = d.players.map(p => Array.isArray(p) ? { id: p[0], position: [p[1], p[2], p[3]], rotation: [p[4], p[5], p[6], p[7]], velocity: [p[8], p[9], p[10]], onGround: p[11] === 1, health: p[12], inputSequence: p[13], crouch: p[14] || 0, lookPitch: (p[15] || 0) / 255 * 2 * Math.PI - Math.PI, lookYaw: (p[16] || 0) / 255 * 2 * Math.PI } : p)
      const e = (d.entities || []).map(e => Array.isArray(e) ? { id: e[0], model: e[1], position: [e[2], e[3], e[4]], rotation: [e[5], e[6], e[7], e[8]], velocity: [e[9], e[10], e[11]], bodyType: e[12], custom: e[13] } : e)
      return { tick: d.tick, serverTime: d.serverTime, players: p, entities: e, delta: d.delta, removed: d.removed }
    }
    return d
  }
}
