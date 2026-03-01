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
      let k = enc[1]
      for (let i = 2; i < 12; i++) k += '|' + enc[i]
      k += '|' + enc[12]
      const cust = enc[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      k += '|' + custStr
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
      let k = encoded[1]
      for (let i = 2; i < 12; i++) k += '|' + encoded[i]
      k += '|' + encoded[12]
      const cust = encoded[13]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      k += '|' + custStr
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
