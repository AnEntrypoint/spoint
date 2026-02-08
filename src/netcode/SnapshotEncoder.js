function quantize(v, precision) {
  return Math.round(v * precision) / precision
}

export class SnapshotEncoder {
  static encode(snapshot) {
    const players = (snapshot.players || []).map(p => [
      p.id,
      quantize(p.position[0], 100), quantize(p.position[1], 100), quantize(p.position[2], 100),
      quantize(p.rotation[0], 10000), quantize(p.rotation[1], 10000), quantize(p.rotation[2], 10000), quantize(p.rotation[3], 10000),
      quantize(p.velocity[0], 100), quantize(p.velocity[1], 100), quantize(p.velocity[2], 100),
      p.onGround ? 1 : 0,
      Math.round(p.health || 0),
      p.inputSequence || 0
    ])
    const entities = (snapshot.entities || []).map(e => [
      e.id,
      e.model || '',
      quantize(e.position[0], 100), quantize(e.position[1], 100), quantize(e.position[2], 100),
      quantize(e.rotation[0], 10000), quantize(e.rotation[1], 10000), quantize(e.rotation[2], 10000), quantize(e.rotation[3], 10000),
      e.bodyType || 'static',
      e.custom || null
    ])
    return { tick: snapshot.tick || 0, timestamp: snapshot.timestamp || 0, players, entities }
  }

  static decode(data) {
    if (data.players && Array.isArray(data.players)) {
      const players = data.players.map(p => {
        if (Array.isArray(p)) return {
          id: p[0], position: [p[1], p[2], p[3]],
          rotation: [p[4], p[5], p[6], p[7]],
          velocity: [p[8], p[9], p[10]],
          onGround: p[11] === 1, health: p[12], inputSequence: p[13]
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
      return { tick: data.tick, timestamp: data.timestamp, players, entities }
    }
    return data
  }
}
