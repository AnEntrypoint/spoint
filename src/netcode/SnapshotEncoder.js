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
    e.bodyType || 'static',
    e.custom || null
  ]
}

export class SnapshotEncoder {
  static encodePlayers(players) {
    return (players || []).map(encodePlayer)
  }

  static encodeDelta(snapshot, prevEntityMap, preEncodedPlayers) {
    const players = preEncodedPlayers || (snapshot.players || []).map(encodePlayer)
    const currentIds = new Set()
    const entities = []
    const nextMap = new Map()
    for (const e of snapshot.entities || []) {
      const encoded = encodeEntity(e)
      currentIds.add(e.id)
      const prev = prevEntityMap.get(e.id)
      let k = encoded[1]
      for (let i = 2; i < 10; i++) k += '|' + encoded[i]
      k += '|' + encoded[9]
      const cust = encoded[10]
      const custStr = (prev && prev[1] === cust) ? prev[2] : (cust != null ? JSON.stringify(cust) : '')
      k += '|' + custStr
      nextMap.set(e.id, [k, cust, custStr])
      if (!prev || prev[0] !== k) entities.push(encoded)
    }
    const removed = []
    for (const id of prevEntityMap.keys()) {
      if (!currentIds.has(id)) removed.push(id)
    }
    return {
      encoded: { tick: snapshot.tick || 0, timestamp: snapshot.timestamp || 0, players, entities, removed: removed.length ? removed : undefined, delta: 1 },
      entityMap: nextMap
    }
  }

  static encode(snapshot) {
    const players = (snapshot.players || []).map(encodePlayer)
    const entities = (snapshot.entities || []).map(encodeEntity)
    return { tick: snapshot.tick || 0, timestamp: snapshot.timestamp || 0, players, entities }
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
          rotation: [e[5], e[6], e[7], e[8]], bodyType: e[9], custom: e[10]
        }
        return e
      })
      return { tick: data.tick, timestamp: data.timestamp, players, entities, delta: data.delta, removed: data.removed }
    }
    return data
  }
}
