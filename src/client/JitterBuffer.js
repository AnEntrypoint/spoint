import { interpolateSnapshot } from './interpolation.js'

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
    const now = performance.now()
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

    const entry = { snapshot, clientTime: now, serverTime, tick: snapshot.tick || 0 }
    let i = this.buffer.length
    while (i > 0 && this.buffer[i - 1].tick > entry.tick) i--
    this.buffer.splice(i, 0, entry)

    while (this.buffer.length > this.maxSize) this.buffer.shift()

    const maxAge = Math.max(400, this.rtt + this.jitter * 3 + 150)
    const cutoff = now - maxAge
    while (this.buffer.length > 0 && this.buffer[0].clientTime < cutoff) this.buffer.shift()
  }

  getSnapshotToRender(now = performance.now()) {
    if (this.buffer.length === 0) return null
    if (this.buffer.length < this.minBufferSize) {
      return this.buffer[this.buffer.length - 1].snapshot
    }

    const renderTime = now - this.targetDelay
    const newest = this.buffer[this.buffer.length - 1]
    const oldest = this.buffer[0]

    if (renderTime >= newest.clientTime) return newest.snapshot
    if (renderTime <= oldest.clientTime) return oldest.snapshot

    let lo = 0, hi = this.buffer.length - 2
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.buffer[mid + 1].clientTime <= renderTime) lo = mid + 1
      else hi = mid
    }
    const curr = this.buffer[lo], next = this.buffer[lo + 1]
    const range = next.clientTime - curr.clientTime
    if (range === 0) return curr.snapshot
    return interpolateSnapshot(this._result, this._playerPool, this._entityPool, i => this._getPlayerSlot(i), curr.snapshot, next.snapshot, (renderTime - curr.clientTime) / range)
  }

  _getPlayerSlot(idx) {
    while (this._playerPool.length <= idx) {
      this._playerPool.push({ id: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 })
    }
    return this._playerPool[idx]
  }

  updateRTT(pingTime, pongTime) {
    const instant = pongTime - pingTime
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instant - this.rtt) * 0.25
    const alpha = instant > this.rtt ? 0.5 : 0.1
    this.rtt = this.rtt * (1 - alpha) + instant * alpha
    this.targetDelay = Math.min(100, Math.max(0, this.jitter * 2 + 8))
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
