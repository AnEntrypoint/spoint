export class JitterBuffer {
  constructor(config = {}) {
    this.maxSize = config.maxSize || 32
    this.maxAge = config.maxAge || 200
    this.minBufferSize = config.minBufferSize || 2
    this.targetDelay = config.targetDelay || 50
    
    this.buffer = []
    this.lastProcessTime = 0
    this.lastServerTime = 0
    this.lastTick = 0
    this.rtt = config.initialRtt || 50
    this.rttVariance = 0
    this.clockDelta = 0
    this.clockDeltaVariance = 0
    this.lastClientTime = 0
  }
  
  addSnapshot(snapshot) {
    const now = Date.now()
    const clientTime = now
    const serverTime = snapshot.timestamp || now
    
    if (this.lastServerTime > 0) {
      const serverDelta = serverTime - this.lastServerTime
      const clientDelta = clientTime - this.lastClientTime
      
      if (serverDelta > 0 && clientDelta > 0) {
        const instantClockDelta = clientDelta - serverDelta
        this.clockDeltaVariance = this.clockDeltaVariance * 0.9 + Math.abs(instantClockDelta - this.clockDelta) * 0.1
        this.clockDelta = this.clockDelta * 0.9 + instantClockDelta * 0.1
      }
    }
    
    this.lastServerTime = serverTime
    this.lastClientTime = clientTime
    
    this.buffer.push({
      snapshot,
      clientTime,
      serverTime,
      tick: snapshot.tick || 0
    })
    
    this.buffer.sort((a, b) => a.tick - b.tick)
    
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift()
    }
    
    this._pruneOld(now)
  }
  
  _pruneOld(now) {
    const cutoff = now - this.maxAge
    while (this.buffer.length > 0 && this.buffer[0].clientTime < cutoff) {
      this.buffer.shift()
    }
  }
  
  getSnapshotToRender(now = Date.now()) {
    if (this.buffer.length < this.minBufferSize) {
      if (this.buffer.length === 0) return null
      return this.buffer[this.buffer.length - 1].snapshot
    }
    
    const renderTime = now - this.targetDelay
    
    let newest = this.buffer[this.buffer.length - 1]
    let oldest = this.buffer[0]
    
    if (renderTime >= newest.clientTime) {
      return newest.snapshot
    }
    
    if (renderTime <= oldest.clientTime) {
      return oldest.snapshot
    }
    
    for (let i = 0; i < this.buffer.length - 1; i++) {
      const curr = this.buffer[i]
      const next = this.buffer[i + 1]
      
      if (renderTime >= curr.clientTime && renderTime <= next.clientTime) {
        const range = next.clientTime - curr.clientTime
        if (range === 0) return curr.snapshot
        
        const alpha = (renderTime - curr.clientTime) / range
        return this._interpolateSnapshots(curr.snapshot, next.snapshot, alpha)
      }
    }
    
    return newest.snapshot
  }
  
  _interpolateSnapshots(older, newer, alpha) {
    const interpolated = {
      tick: Math.round(older.tick + (newer.tick - older.tick) * alpha),
      timestamp: older.timestamp + (newer.timestamp - older.timestamp) * alpha,
      players: [],
      entities: []
    }
    
    const olderPlayers = new Map()
    for (const p of older.players || []) {
      olderPlayers.set(p.id, p)
    }
    
    for (const np of newer.players || []) {
      const op = olderPlayers.get(np.id)
      if (op) {
        interpolated.players.push(this._interpolatePlayer(op, np, alpha))
      } else {
        interpolated.players.push({ ...np })
      }
    }
    
    const olderEntities = new Map()
    for (const e of older.entities || []) {
      olderEntities.set(e.id, e)
    }
    
    for (const ne of newer.entities || []) {
      const oe = olderEntities.get(ne.id)
      if (oe) {
        interpolated.entities.push(this._interpolateEntity(oe, ne, alpha))
      } else {
        interpolated.entities.push({ ...ne })
      }
    }
    
    return interpolated
  }
  
  _interpolatePlayer(older, newer, alpha) {
    return {
      id: newer.id,
      position: [
        this._lerp(older.position[0], newer.position[0], alpha),
        this._lerp(older.position[1], newer.position[1], alpha),
        this._lerp(older.position[2], newer.position[2], alpha)
      ],
      rotation: newer.rotation,
      velocity: [
        this._lerp(older.velocity?.[0] || 0, newer.velocity?.[0] || 0, alpha),
        this._lerp(older.velocity?.[1] || 0, newer.velocity?.[1] || 0, alpha),
        this._lerp(older.velocity?.[2] || 0, newer.velocity?.[2] || 0, alpha)
      ],
      onGround: newer.onGround,
      health: this._lerp(older.health || 100, newer.health || 100, alpha),
      inputSequence: newer.inputSequence,
      crouch: newer.crouch,
      lookPitch: this._lerp(older.lookPitch || 0, newer.lookPitch || 0, alpha),
      lookYaw: this._lerp(older.lookYaw || 0, newer.lookYaw || 0, alpha)
    }
  }
  
  _interpolateEntity(older, newer, alpha) {
    return {
      id: newer.id,
      model: newer.model,
      position: [
        this._lerp(older.position[0], newer.position[0], alpha),
        this._lerp(older.position[1], newer.position[1], alpha),
        this._lerp(older.position[2], newer.position[2], alpha)
      ],
      rotation: [
        this._lerp(older.rotation[0], newer.rotation[0], alpha),
        this._lerp(older.rotation[1], newer.rotation[1], alpha),
        this._lerp(older.rotation[2], newer.rotation[2], alpha),
        this._lerp(older.rotation[3], newer.rotation[3], alpha)
      ],
      bodyType: newer.bodyType,
      custom: newer.custom
    }
  }
  
  _lerp(a, b, t) {
    return a + (b - a) * t
  }
  
  updateRTT(pingTime, pongTime) {
    const instantRtt = pongTime - pingTime
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instantRtt - this.rtt) * 0.25
    this.rtt = this.rtt * 0.875 + instantRtt * 0.125
    
    this.targetDelay = Math.min(100, Math.max(20, this.rtt / 2 + this.rttVariance))
  }
  
  getBufferHealth() {
    return this.buffer.length
  }
  
  getRTT() {
    return this.rtt
  }
  
  getClockDelta() {
    return this.clockDelta
  }
  
  clear() {
    this.buffer = []
    this.lastServerTime = 0
    this.lastClientTime = 0
  }
}