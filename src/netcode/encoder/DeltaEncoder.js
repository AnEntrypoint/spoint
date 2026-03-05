import { encodePlayer, encodeEntity } from './BaseEncoder.js'

let _stateIdCounter = 1

export function isEncChanged(enc, prevEnc) {
  for (let i = 2; i <= 11; i++) { if (enc[i] !== prevEnc[i]) return true }
  return enc[12] !== prevEnc[12]
}

export class DeltaEncoder {
  static encodeStatic(entities, prevMap) {
    const nextMap = new Map(); const all = []; const changed = []; let isChanged = false
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]; if (e.bodyType !== 'static') continue; const enc = encodeEntity(e); const prev = prevMap.get(e.id); const cust = enc[13]
      let sid = prev ? prev.stateId : _stateIdCounter++; let cStr = prev ? prev.custStr : (cust != null ? JSON.stringify(cust) : '')
      if (prev) { let entryChanged = isEncChanged(enc, prev.enc); if (!entryChanged && cust !== prev.cust) { const n = (cust != null ? JSON.stringify(cust) : ''); if (n !== prev.custStr) { entryChanged = true; cStr = n } }; if (entryChanged) sid = _stateIdCounter++ }
      const entry = { enc, stateId: sid, cust, custStr: cStr, id: e.id }; nextMap.set(e.id, entry); all.push(entry); if (!prev || prev.stateId !== sid) { changed.push(entry); isChanged = true }
    }
    if (nextMap.size !== prevMap.size) isChanged = true; return { staticEntries: all, changedEntries: changed, staticMap: nextMap, staticChanged: isChanged }
  }

  static updateDynamicCache(prev, activeIds, entities) {
    const cache = new Map(prev); for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue; const enc = encodeEntity(e); const old = prev.get(id); const cust = enc[13]
      let sid = old ? old.stateId : _stateIdCounter++; let cStr = old ? old.custStr : (cust != null ? JSON.stringify(cust) : '')
      if (old) { let entryChanged = isEncChanged(enc, old.enc); if (!entryChanged && cust !== old.cust) { const n = (cust != null ? JSON.stringify(cust) : ''); if (n !== old.custStr) { entryChanged = true; cStr = n } }; if (entryChanged) sid = _stateIdCounter++ }
      cache.set(id, { enc, stateId: sid, cust, custStr: cStr, isEnv: e._appName === 'environment' })
    }
    return cache
  }

  static encodeDynamicOnce(entities, prev) {
    const cache = new Map(); const envIds = []
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]; if (e.bodyType === 'static') continue; if (e._sleeping && prev) { const old = prev.get(e.id); if (old) { cache.set(e.id, old); if (old.isEnv) envIds.push(e.id); continue } }
      const enc = encodeEntity(e); const old = prev ? prev.get(e.id) : null; const cust = enc[13]
      let sid = old ? old.stateId : _stateIdCounter++; let cStr = old ? old.custStr : (cust != null ? JSON.stringify(cust) : '')
      if (old) { let entryChanged = isEncChanged(enc, old.enc); if (!entryChanged && cust !== old.cust) { const n = (cust != null ? JSON.stringify(cust) : ''); if (n !== old.custStr) { entryChanged = true; cStr = n } }; if (entryChanged) sid = _stateIdCounter++ }
      const isEnv = e._isEnv || e._appName === 'environment' || false; cache.set(e.id, { enc, stateId: sid, cust, custStr: cStr, isEnv }); if (isEnv) envIds.push(e.id)
    }
    cache._envIds = envIds; return cache
  }

  static encodeDeltaFromCache(tick, time, dynCache, relIds, prevMap, preEncPlayers, statEntries, statIds) {
    const ents = []; const nextMap = new Map(); if (statEntries) { for (let i = 0; i < statEntries.length; i++) ents.push(statEntries[i].enc) }
    const iter = (relIds && dynCache.size > relIds.size) ? relIds : null
    if (iter) {
      for (const id of iter) { const entry = dynCache.get(id); if (!entry) continue; const sid = entry.stateId; nextMap.set(id, sid); if (prevMap.get(id) !== sid) ents.push(entry.enc) }
      const env = dynCache._envIds; if (env) { for (let i = 0; i < env.length; i++) { const id = env[i], entry = dynCache.get(id); if (!entry || nextMap.has(id)) continue; const sid = entry.stateId; nextMap.set(id, sid); if (prevMap.get(id) !== sid) ents.push(entry.enc) } }
    } else { for (const [id, entry] of dynCache) { const sid = entry.stateId; nextMap.set(id, sid); if (prevMap.get(id) !== sid) ents.push(entry.enc) } }
    const rem = []; for (const id of prevMap.keys()) { if (!nextMap.has(id) && !(statIds && statIds.has(id))) rem.push(id) }
    return { encoded: { tick: tick || 0, serverTime: time, players: preEncPlayers, entities: ents, removed: rem.length ? rem : undefined, delta: 1 }, entityMap: nextMap }
  }
}
