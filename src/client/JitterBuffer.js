import { interpolateSnapshot } from './interpolation.js'

class Deque {
  constructor(capacity = 64) {
    this._buf = new Array(capacity)
    this._head = 0
    this._tail = 0
    this._capacity = capacity
  }
  get length() { return this._tail - this._head }
  push(v) {
    if (this._tail - this._head >= this._capacity) {
      const newCap = this._capacity * 2
      const newBuf = new Array(newCap)
      for (let i = this._head; i < this._tail; i++) newBuf[i - this._head] = this._buf[i % this._capacity]
      this._buf = newBuf; this._capacity = newCap
      this._tail -= this._head; this._head = 0
    }
    this._buf[this._tail % this._capacity] = v
    this._tail++
  }
  shift() {
    if (this._head >= this._tail) return undefined
    const v = this._buf[this._head % this._capacity]
    this._head++
    return v
  }
  splice(idx, count, ...items) {
    const n = this._tail - this._head
    idx = Math.max(0, Math.min(idx, n))
    count = Math.min(count || 0, n - idx)
    const removed = []
    const newLen = n + items.length - count
    const newBuf = new Array(Math.max(this._capacity, newLen + 4))
    let o = 0
    for (let i = 0; i < idx; i++) newBuf[o++] = this._buf[(this._head + i) % this._capacity]
    for (const item of items) newBuf[o++] = item
    for (let i = idx + count; i < n; i++) newBuf[o++] = this._buf[(this._head + i) % this._capacity]
    for (let i = idx; i < idx + count; i++) removed.push(this._buf[(this._head + i) % this._capacity])
    this._buf = newBuf; this._capacity = newBuf.length
    this._head = 0; this._tail = newLen
    return removed
  }
  at(i) {
    if (i < 0) i = this.length + i
    if (i < 0 || i >= this.length) return undefined
    return this._buf[(this._head + i) % this._capacity]
  }
  first() { return this.at(0) }
  last() { return this.at(-1) }
}

const JITTER_WINDOW_SIZE = 60
const JITTER_PERCENTILE = 0.95
const P95_MIN_SAMPLES = 8
const RTT_OUTLIER_FACTOR = 5

export class JitterBuffer {
  constructor(config = {}) {
    this.maxSize = config.maxSize || 64
    this.minBufferSize = config.minBufferSize || 1
    this.baseDelay = config.baseDelay || 0

    this.buffer = new Deque()
    this.lastServerTime = 0
    this.lastClientTime = 0
    this.rtt = config.initialRtt || 0
    this.rttVariance = 0
    this.jitter = 0
    this.snapInterval = config.snapInterval || 50
    this.minDelay = config.minDelay ?? 16
    this.maxDelay = config.maxDelay || 250
    this.targetDelay = this.baseDelay

    this._jitterSamples = new Array(JITTER_WINDOW_SIZE)
    this._jitterSampleCount = 0
    this._jitterSampleIdx = 0
    this._jitterSorted = null
    this.p95Jitter = 0

    this._result = { tick: 0, timestamp: 0, players: [], entities: [] }
    this._playerPool = []
    this._entityPool = []
    this._oldP = new Map()
    this._oldE = new Map()
    this._getPlayerSlotFn = i => this._getPlayerSlot(i)
    this._getEntitySlotFn = i => this._getEntitySlot(i)
  }

  _recordJitterSample(instantJitter) {
    this._jitterSamples[this._jitterSampleIdx] = instantJitter
    this._jitterSampleIdx = (this._jitterSampleIdx + 1) % JITTER_WINDOW_SIZE
    if (this._jitterSampleCount < JITTER_WINDOW_SIZE) this._jitterSampleCount++
    const n = this._jitterSampleCount
    const sorted = (this._jitterSorted && this._jitterSorted.length === n) ? this._jitterSorted : new Array(n)
    for (let i = 0; i < n; i++) sorted[i] = this._jitterSamples[i]
    sorted.sort((a, b) => a - b)
    this._jitterSorted = sorted
    const idx = Math.min(n - 1, Math.ceil(n * JITTER_PERCENTILE) - 1)
    this.p95Jitter = sorted[idx]
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
        this.snapInterval = this.snapInterval * 0.9 + clientDelta * 0.1
        this._recordJitterSample(instantJitter)
      }
    }

    this.lastServerTime = serverTime
    this.lastClientTime = now
    this._recomputeDelay()

    const entry = { snapshot, clientTime: now, serverTime, tick: snapshot.tick || 0 }
    let i = this.buffer.length
    while (i > 0 && this.buffer.at(i - 1).clientTime > entry.clientTime) i--
    if (i === this.buffer.length) this.buffer.push(entry)
    else this.buffer.splice(i, 0, entry)

    while (this.buffer.length > this.maxSize) this.buffer.shift()

    const maxAge = Math.max(this.targetDelay * 4, this.rtt + this.jitter * 3 + 150)
    const cutoff = now - maxAge
    while (this.buffer.length > 0 && this.buffer.first().clientTime < cutoff) this.buffer.shift()
  }

  getSnapshotToRender(now = performance.now()) {
    if (this.buffer.length === 0) return null
    if (this.buffer.length < this.minBufferSize) {
      return this.buffer.last().snapshot
    }

    const renderTime = now - this.targetDelay
    const newest = this.buffer.last()
    const oldest = this.buffer.first()

    if (renderTime >= newest.clientTime) return newest.snapshot
    if (renderTime <= oldest.clientTime) return oldest.snapshot

    let lo = 0, hi = this.buffer.length - 2
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.buffer.at(mid + 1).clientTime <= renderTime) lo = mid + 1
      else hi = mid
    }
    const curr = this.buffer.at(lo), next = this.buffer.at(lo + 1)
    const range = next.clientTime - curr.clientTime
    if (range === 0) return curr.snapshot
    return interpolateSnapshot(this._result, this._playerPool, this._entityPool, this._getPlayerSlotFn, this._getEntitySlotFn, curr.snapshot, next.snapshot, (renderTime - curr.clientTime) / range, this._oldP, this._oldE)
  }

  _getPlayerSlot(idx) {
    while (this._playerPool.length <= idx) {
      this._playerPool.push({ id: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0 })
    }
    return this._playerPool[idx]
  }

  _getEntitySlot(idx) {
    while (this._entityPool.length <= idx) {
      this._entityPool.push({ id: null, model: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], bodyType: 'static', custom: null, scale: [1, 1, 1], sleeping: false })
    }
    return this._entityPool[idx]
  }

  updateRTT(pingTime, pongTime) {
    const instant = pongTime - pingTime
    if (!Number.isFinite(instant) || instant < 0) return
    if (this.rtt > 0 && instant > this.rtt * RTT_OUTLIER_FACTOR) return
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instant - this.rtt) * 0.25
    const alpha = instant > this.rtt ? 0.5 : 0.1
    this.rtt = this.rtt * (1 - alpha) + instant * alpha
    this._recomputeDelay()
  }

  _recomputeDelay() {
    const jitterTerm = this._jitterSampleCount >= P95_MIN_SAMPLES ? this.p95Jitter : this.jitter
    const want = Math.min(this.maxDelay, Math.max(this.minDelay, this.snapInterval * 1.5 + jitterTerm * 2 + this.baseDelay))
    const MAX_TARGET_DELAY_SLEW_MS = 30
    this.targetDelay = Math.max(this.targetDelay - MAX_TARGET_DELAY_SLEW_MS, Math.min(this.targetDelay + MAX_TARGET_DELAY_SLEW_MS, want))
  }

  getBufferHealth() { return this.buffer.length }
  getRTT() { return this.rtt }
  getJitter() { return this.jitter }
  getP95Jitter() { return this.p95Jitter }
  getTargetDelay() { return this.targetDelay }

  clear() {
    this.buffer = new Deque()
    this.lastServerTime = 0
    this.lastClientTime = 0
    this._jitterSampleCount = 0
    this._jitterSampleIdx = 0
    this._jitterSorted = null
    this.p95Jitter = 0
    this.jitter = 0
  }

  resyncToLatest() {
    const newest = this.buffer.last()
    this.buffer = new Deque()
    if (newest) this.buffer.push(newest)
  }
}
