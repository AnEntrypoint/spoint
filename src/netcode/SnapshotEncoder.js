function quantize(v, precision) {
  return Math.round(v * precision) / precision
}

function encodePlayer(p) {
  return [
    p.id,
    quantize(p.position[0], 100), quantize(p.position[1], 100), quantize(p.position[2], 100),
    quantize(p.rotation[0], 10000), quantize(p.rotation[1], 10000), quantize(p.rotation[2], 10000), quantize(p.rotation[3], 10000),
    quantize(p.velocity[0], 100), quantize(p.velocity[1], 100), quantize(p.velocity[2], 100),
    p.onGround ? 1 : 0,
    Math.round(p.health || 0),
    p.inputSequence || 0,
    p.crouch || 0,
    Math.round(((p.lookPitch || 0) + Math.PI) / (2 * Math.PI) * 255),
    Math.round(((p.lookYaw || 0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * 255)
  ]
}

function encodeEntity(e) {
  return [
    e.id,
    e.model || '',
    quantize(e.position[0], 100), quantize(e.position[1], 100), quantize(e.position[2], 100),
    quantize(e.rotation[0], 10000), quantize(e.rotation[1], 10000), quantize(e.rotation[2], 10000), quantize(e.rotation[3], 10000),
    quantize(e.velocity?.[0] || 0, 100), quantize(e.velocity?.[1] || 0, 100), quantize(e.velocity?.[2] || 0, 100),
    e.bodyType || 'static',
    e.custom || null
  ]
}

function buildEntityKey(enc, custStr) {
  return enc[1] + '|' + enc[2] + '|' + enc[3] + '|' + enc[4] + '|' + enc[5] + '|' + enc[6] + '|' + enc[7] + '|' + enc[8] + '|' + enc[9] + '|' + enc[10] + '|' + enc[11] + '|' + enc[12] + '|' + custStr
}

export class SnapshotEncoder {
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
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      const k = buildEntityKey(enc, custStr)
      nextMap.set(e.id, [k, cust, custStr])
      allEntries.push({ enc, k, id: e.id })
      if (!prev || prev[0] !== k) { changedEntries.push({ enc, k, id: e.id }); changed = true }
    }
    if (nextMap.size !== prevStaticMap.size) changed = true
    return { staticEntries: allEntries, changedEntries, staticMap: nextMap, staticChanged: changed }
  }

  static buildStaticIds(staticMap) {
    return new Set(staticMap.keys())
  }

  static updateDynamicCache(prevCache, activeIds, entities) {
    const cache = new Map(prevCache)
    for (const id of activeIds) {
      const e = entities.get(id)
      if (!e || e.bodyType === 'static') continue
      const enc = encodeEntity(e)
      const prev = prevCache.get(id)
      const cust = enc[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      const k = buildEntityKey(enc, custStr)
      cache.set(id, { enc, k, cust, custStr, isEnv: false })
    }
    return cache
  }

  static encodeDynamicEntitiesOnce(entities, prevCache) {
    const cache = new Map()
    for (const e of entities) {
      if (e.bodyType === 'static') continue
      if (e._sleeping && prevCache) {
        const prev = prevCache.get(e.id)
        if (prev) { cache.set(e.id, prev); continue }
      }
      const enc = encodeEntity(e)
      const prev = prevCache ? prevCache.get(e.id) : null
      const cust = enc[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      const k = buildEntityKey(enc, custStr)
      cache.set(e.id, { enc, k, cust, custStr, isEnv: e._isEnv || false })
    }
    return cache
  }

  static encodeDeltaFromCache(tick, serverTime, dynCache, relevantIds, prevEntityMap, preEncodedPlayers, staticEntries, staticEntityMap, staticEntityIds) {
    const entities = []
    const nextMap = new Map()
    if (staticEntries) {
      for (const { enc } of staticEntries) entities.push(enc)
    }
    const iterIds = (relevantIds && dynCache.size > relevantIds.size) ? relevantIds : null
    if (iterIds) {
      for (const id of iterIds) {
        const entry = dynCache.get(id)
        if (!entry) continue
        const { enc, k, cust, custStr } = entry
        nextMap.set(id, [k, cust, custStr])
        const prev = prevEntityMap.get(id)
        if (!prev || prev[0] !== k) entities.push(enc)
      }
      for (const [id, entry] of dynCache) {
        if (entry.isEnv) {
          const { enc, k, cust, custStr } = entry
          nextMap.set(id, [k, cust, custStr])
          const prev = prevEntityMap.get(id)
          if (!prev || prev[0] !== k) entities.push(enc)
        }
      }
    } else {
      for (const [id, entry] of dynCache) {
        if (!entry.isEnv && relevantIds && !relevantIds.has(id)) continue
        const { enc, k, cust, custStr } = entry
        nextMap.set(id, [k, cust, custStr])
        const prev = prevEntityMap.get(id)
        if (!prev || prev[0] !== k) entities.push(enc)
      }
    }
    const removed = []
    for (const id of prevEntityMap.keys()) {
      if (!dynCache.has(id) && !(staticEntityIds && staticEntityIds.has(id))) removed.push(id)
    }
    return {
      encoded: { tick: tick || 0, serverTime, players: preEncodedPlayers, entities, removed: removed.length ? removed : undefined, delta: 1 },
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
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
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
    if (data.players && Array.isArray(data.players)) {
      const players = data.players.map(p => {
        if (Array.isArray(p)) return {
          id: p[0], position: [p[1], p[2], p[3]],
          rotation: [p[4], p[5], p[6], p[7]],
          velocity: [p[8], p[9], p[10]],
          onGround: p[11] === 1, health: p[12], inputSequence: p[13],
          crouch: p[14] || 0,
          lookPitch: (p[15] || 0) / 255 * 2 * Math.PI - Math.PI,
          lookYaw: (p[16] || 0) / 255 * 2 * Math.PI
        }
        return p
      })
      const entities = (data.entities || []).map(e => {
        if (Array.isArray(e)) return {
          id: e[0], model: e[1], position: [e[2], e[3], e[4]],
          rotation: [e[5], e[6], e[7], e[8]], velocity: [e[9], e[10], e[11]], bodyType: e[12], custom: e[13]
        }
        return e
      })
      return { tick: data.tick, serverTime: data.serverTime, players, entities, delta: data.delta, removed: data.removed }
    }
    return data
  }
}
