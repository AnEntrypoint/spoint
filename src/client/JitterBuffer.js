export class JitterBuffer {
  constructor(config = {}) {
    this.maxSize = config.maxSize || 64
    this.minBufferSize = config.minBufferSize || 2
    this.baseDelay = config.baseDelay || 30

    this.buffer = []
    this.lastServerTime = 0
    this.lastClientTime = 0
    this.rtt = config.initialRtt || 50
    this.rttVariance = 0
    this.jitter = 0
    this.targetDelay = this.baseDelay
  }

  addSnapshot(snapshot) {
    const now = Date.now()
    const serverTime = snapshot.timestamp || now

    if (this.lastServerTime > 0 && this.lastClientTime > 0) {
      const serverDelta = serverTime - this.lastServerTime
      const clientDelta = now - this.lastClientTime
      if (serverDelta > 0 && clientDelta > 0) {
        const instantJitter = Math.abs(clientDelta - serverDelta)
        this.jitter = this.jitter * 0.9 + instantJitter * 0.1
      }
    }

    this.lastServerTime = serverTime
    this.lastClientTime = now

    this.buffer.push({ snapshot, clientTime: now, serverTime, tick: snapshot.tick || 0 })
    this.buffer.sort((a, b) => a.tick - b.tick)

    while (this.buffer.length > this.maxSize) this.buffer.shift()

    const maxAge = Math.max(400, this.rtt + this.jitter * 3 + 150)
    const cutoff = now - maxAge
    while (this.buffer.length > 0 && this.buffer[0].clientTime < cutoff) this.buffer.shift()
  }

  getSnapshotToRender(now = Date.now()) {
    if (this.buffer.length === 0) return null
    if (this.buffer.length < this.minBufferSize) {
      return this.buffer[this.buffer.length - 1].snapshot
    }

    const renderTime = now - this.targetDelay
    const newest = this.buffer[this.buffer.length - 1]
    const oldest = this.buffer[0]

    if (renderTime >= newest.clientTime) return newest.snapshot
    if (renderTime <= oldest.clientTime) return oldest.snapshot

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
    const result = { tick: newer.tick, timestamp: newer.timestamp, players: [], entities: [] }

    const oldP = new Map()
    for (const p of older.players || []) oldP.set(p.id, p)
    for (const np of newer.players || []) {
      const op = oldP.get(np.id)
      if (op) {
        result.players.push({
          id: np.id,
          position: [_l(op.position[0], np.position[0], alpha), _l(op.position[1], np.position[1], alpha), _l(op.position[2], np.position[2], alpha)],
          rotation: _slerp(op.rotation || np.rotation, np.rotation, alpha),
          velocity: [_l(op.velocity?.[0] || 0, np.velocity?.[0] || 0, alpha), _l(op.velocity?.[1] || 0, np.velocity?.[1] || 0, alpha), _l(op.velocity?.[2] || 0, np.velocity?.[2] || 0, alpha)],
          onGround: np.onGround, health: np.health, inputSequence: np.inputSequence,
          crouch: np.crouch,
          lookPitch: _l(op.lookPitch || 0, np.lookPitch || 0, alpha),
          lookYaw: _l(op.lookYaw || 0, np.lookYaw || 0, alpha)
        })
      } else {
        result.players.push({ ...np })
      }
    }

    const oldE = new Map()
    for (const e of older.entities || []) oldE.set(e.id, e)
    for (const ne of newer.entities || []) {
      const oe = oldE.get(ne.id)
      if (oe) {
        result.entities.push({
          id: ne.id, model: ne.model,
          position: [_l(oe.position[0], ne.position[0], alpha), _l(oe.position[1], ne.position[1], alpha), _l(oe.position[2], ne.position[2], alpha)],
          rotation: _slerp(oe.rotation || ne.rotation, ne.rotation, alpha),
          bodyType: ne.bodyType, custom: ne.custom
        })
      } else {
        result.entities.push({ ...ne })
      }
    }

    return result
  }

  updateRTT(pingTime, pongTime) {
    const instant = pongTime - pingTime
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instant - this.rtt) * 0.25
    const alpha = instant > this.rtt ? 0.5 : 0.1
    this.rtt = this.rtt * (1 - alpha) + instant * alpha
    this.targetDelay = Math.min(250, this.baseDelay + this.rtt * 0.5 + this.jitter * 2)
  }

  getBufferHealth() { return this.buffer.length }
  getRTT() { return this.rtt }
  getJitter() { return this.jitter }
  getTargetDelay() { return this.targetDelay }

  clear() {
    this.buffer = []
    this.lastServerTime = 0
    this.lastClientTime = 0
  }
}

function _l(a, b, t) { return a + (b - a) * t }

function _slerp(q1, q2, t) {
  let [x1, y1, z1, w1] = q1
  let [x2, y2, z2, w2] = q2
  let dot = x1 * x2 + y1 * y2 + z1 * z2 + w1 * w2
  if (dot < 0) {
    x2 = -x2; y2 = -y2; z2 = -z2; w2 = -w2
    dot = -dot
  }
  dot = Math.max(-1, Math.min(1, dot))
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  if (sinTheta < 0.001) return [_l(x1, x2, t), _l(y1, y2, t), _l(z1, z2, t), _l(w1, w2, t)]
  const w1sin = Math.sin((1 - t) * theta) / sinTheta
  const w2sin = Math.sin(t * theta) / sinTheta
  return [x1 * w1sin + x2 * w2sin, y1 * w1sin + y2 * w2sin, z1 * w1sin + z2 * w2sin, w1 * w1sin + w2 * w2sin]
}
