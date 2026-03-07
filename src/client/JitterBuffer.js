export class JitterBuffer {
  constructor(config = {}) {
    this.maxSize = config.maxSize || 64
    this.minBufferSize = config.minBufferSize || 1
    this.baseDelay = config.baseDelay || 0

    this.buffer = []
    this.lastServerTime = 0
    this.lastClientTime = 0
    this.rtt = config.initialRtt || 0
    this.rttVariance = 0
    this.jitter = 0
    this.targetDelay = this.baseDelay

    this._result = { tick: 0, timestamp: 0, players: [], entities: [] }
    this._playerPool = []
    this._entityPool = []
    this._oldP = new Map()
    this._oldE = new Map()
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

  _getPlayerSlot(idx) {
    while (this._playerPool.length <= idx) {
      this._playerPool.push({ id: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 })
    }
    return this._playerPool[idx]
  }

  _getEntitySlot(idx) {
    while (this._entityPool.length <= idx) {
      this._entityPool.push({ id: null, model: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], bodyType: null, custom: null })
    }
    return this._entityPool[idx]
  }

  _interpolateSnapshots(older, newer, alpha) {
    const result = this._result
    result.tick = newer.tick
    result.timestamp = newer.timestamp

    const oldP = this._oldP
    oldP.clear()
    for (const p of older.players || []) oldP.set(p.id, p)

    const newPlayers = newer.players || []
    const pLen = newPlayers.length
    result.players.length = pLen
    for (let i = 0; i < pLen; i++) {
      const np = newPlayers[i]
      const op = oldP.get(np.id)
      const slot = this._getPlayerSlot(i)
      result.players[i] = slot
      if (op) {
        slot.id = np.id
        slot.position[0] = _l(op.position[0], np.position[0], alpha)
        slot.position[1] = _l(op.position[1], np.position[1], alpha)
        slot.position[2] = _l(op.position[2], np.position[2], alpha)
        _slerpInto(slot.rotation, op.rotation || np.rotation, np.rotation, alpha)
        slot.velocity[0] = _l(op.velocity?.[0] || 0, np.velocity?.[0] || 0, alpha)
        slot.velocity[1] = _l(op.velocity?.[1] || 0, np.velocity?.[1] || 0, alpha)
        slot.velocity[2] = _l(op.velocity?.[2] || 0, np.velocity?.[2] || 0, alpha)
        slot.onGround = np.onGround
        slot.health = np.health
        slot.inputSequence = np.inputSequence
        slot.crouch = np.crouch
        slot.lookPitch = _l(op.lookPitch || 0, np.lookPitch || 0, alpha)
        slot.lookYaw = _l(op.lookYaw || 0, np.lookYaw || 0, alpha)
      } else {
        slot.id = np.id
        slot.position[0] = np.position[0]; slot.position[1] = np.position[1]; slot.position[2] = np.position[2]
        const r = np.rotation || [0, 0, 0, 1]; slot.rotation[0] = r[0]; slot.rotation[1] = r[1]; slot.rotation[2] = r[2]; slot.rotation[3] = r[3]
        const v = np.velocity || [0, 0, 0]; slot.velocity[0] = v[0]; slot.velocity[1] = v[1]; slot.velocity[2] = v[2]
        slot.onGround = np.onGround; slot.health = np.health; slot.inputSequence = np.inputSequence
        slot.crouch = np.crouch; slot.lookPitch = np.lookPitch || 0; slot.lookYaw = np.lookYaw || 0
      }
    }

    const newEntities = newer.entities || []
    result.entities = newEntities

    return result
  }

  updateRTT(pingTime, pongTime) {
    const instant = pongTime - pingTime
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instant - this.rtt) * 0.25
    const alpha = instant > this.rtt ? 0.5 : 0.1
    this.rtt = this.rtt * (1 - alpha) + instant * alpha
    const rtt = this.rtt
    const adaptiveBase = rtt < 5 ? 0 : rtt < 30 ? Math.ceil(rtt * 0.5 + this.jitter) : 30
    this.targetDelay = Math.min(250, adaptiveBase + rtt * 0.5 + this.jitter * 2)
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

function _slerpInto(out, q1, q2, t) {
  if (!q1 || !q2) { if (q2) { out[0] = q2[0]; out[1] = q2[1]; out[2] = q2[2]; out[3] = q2[3] } return }
  let x1 = q1[0], y1 = q1[1], z1 = q1[2], w1 = q1[3]
  let x2 = q2[0], y2 = q2[1], z2 = q2[2], w2 = q2[3]
  let dot = x1 * x2 + y1 * y2 + z1 * z2 + w1 * w2
  if (dot < 0) { x2 = -x2; y2 = -y2; z2 = -z2; w2 = -w2; dot = -dot }
  dot = Math.max(-1, Math.min(1, dot))
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  if (sinTheta < 0.001) { out[0] = _l(x1, x2, t); out[1] = _l(y1, y2, t); out[2] = _l(z1, z2, t); out[3] = _l(w1, w2, t); return }
  const s1 = Math.sin((1 - t) * theta) / sinTheta
  const s2 = Math.sin(t * theta) / sinTheta
  out[0] = x1 * s1 + x2 * s2; out[1] = y1 * s1 + y2 * s2; out[2] = z1 * s1 + z2 * s2; out[3] = w1 * s1 + w2 * s2
}
