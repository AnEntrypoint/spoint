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

// rolling window size for the p95 inter-arrival-jitter tracker: at a typical 20-60Hz snapshot rate
// this spans roughly 1-3s of real history, wide enough to catch a bursty-but-recurring jitter
// pattern without reacting to a single one-off spike (that's what p95, not p100/max, is for) and
// without going stale-slow on a genuine sustained network condition change.
const JITTER_WINDOW_SIZE = 60

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

    // real observed packet-arrival jitter samples (|clientDelta - serverDelta| per snapshot), kept
    // as a rolling window so p95 can be recomputed from actual history instead of an EWMA guess.
    // EWMA (this.jitter, above) reacts smoothly but systematically UNDER-covers a bursty jitter
    // distribution (a p50-ish estimator smoothed over time is not a tail-coverage guarantee); p95
    // is what "cover the jitter without dropping frames on the bad tail" actually means, and it's
    // also what buffer sizing literature/webrtc-style jitter buffers converge on.
    this._jitterSamples = new Array(JITTER_WINDOW_SIZE)
    this._jitterSampleCount = 0
    this._jitterSampleIdx = 0
    this._jitterSorted = null // lazily rebuilt cache, invalidated by every new sample
    this.p95Jitter = 0

    this._result = { tick: 0, timestamp: 0, players: [], entities: [] }
    this._playerPool = []
    this._entityPool = []
    this._oldP = new Map()
    this._oldE = new Map()
  }

  // records one real inter-arrival jitter sample into the rolling window and recomputes p95 from
  // the actual sorted sample set (small window, O(n log n) sort is cheap -- <=60 elements)
  _recordJitterSample(instantJitter) {
    this._jitterSamples[this._jitterSampleIdx] = instantJitter
    this._jitterSampleIdx = (this._jitterSampleIdx + 1) % JITTER_WINDOW_SIZE
    if (this._jitterSampleCount < JITTER_WINDOW_SIZE) this._jitterSampleCount++
    const n = this._jitterSampleCount
    const sorted = (this._jitterSorted && this._jitterSorted.length === n) ? this._jitterSorted : new Array(n)
    for (let i = 0; i < n; i++) sorted[i] = this._jitterSamples[i]
    sorted.sort((a, b) => a - b)
    this._jitterSorted = sorted
    // p95 index via ceil so a small sample count still picks a real observed value, not an
    // out-of-range index (e.g. n=1 -> index 0, the only sample; n=20 -> index 18, the 19th value)
    const idx = Math.min(n - 1, Math.ceil(n * 0.95) - 1)
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
    // must insert in clientTime order (not tick order) -- getSnapshotToRender binary-searches on clientTime
    let i = this.buffer.length
    while (i > 0 && this.buffer.at(i - 1).clientTime > entry.clientTime) i--
    this.buffer.splice(i, 0, entry)

    while (this.buffer.length > this.maxSize) this.buffer.shift()

    // eviction age tied to targetDelay, not a hardcoded floor, so a large baseDelay/maxDelay config doesn't starve the bracketing pair
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
    return interpolateSnapshot(this._result, this._playerPool, this._entityPool, i => this._getPlayerSlot(i), i => this._getEntitySlot(i), curr.snapshot, next.snapshot, (renderTime - curr.clientTime) / range, this._oldP, this._oldE)
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
    // reject negative (clock went backward) or >5x current estimate (reorder artifact) to avoid spiking rtt off one bad sample
    if (!Number.isFinite(instant) || instant < 0) return
    if (this.rtt > 0 && instant > this.rtt * 5) return
    this.rttVariance = this.rttVariance * 0.75 + Math.abs(instant - this.rtt) * 0.25
    const alpha = instant > this.rtt ? 0.5 : 0.1
    this.rtt = this.rtt * (1 - alpha) + instant * alpha
    this._recomputeDelay()
  }

  // RTT doesn't factor in here: local-input lag is hidden by prediction, not this buffer -- only
  // snapshot spacing/jitter matters. The jitter term uses the real p95-based estimate
  // (this.p95Jitter, an actual observed rolling-window percentile) instead of the EWMA (this.jitter)
  // once enough samples exist to make p95 meaningful -- an EWMA of jitter systematically undercovers
  // a bursty/heavy-tailed arrival distribution, since it's smoothing toward something closer to the
  // mean/p50 than the tail a buffer actually needs to absorb without dropping frames. Below a small
  // sample floor, p95 over 1-4 points is noise (could be a single early spike), so the EWMA is used
  // as the more stable early estimate until the window has enough real history.
  _recomputeDelay() {
    const jitterTerm = this._jitterSampleCount >= 8 ? this.p95Jitter : this.jitter
    const want = Math.min(this.maxDelay, Math.max(this.minDelay, this.snapInterval * 1.5 + jitterTerm * 2 + this.baseDelay))
    // slew-limited so one bad rtt/jitter sample can't jump the window far enough to evict the bracketing pair (causes a remote-player teleport)
    const MAX_SLEW = 30
    this.targetDelay = Math.max(this.targetDelay - MAX_SLEW, Math.min(this.targetDelay + MAX_SLEW, want))
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
    // a real reconnect/reset must not let pre-reconnect jitter samples leak into the post-reconnect
    // p95 -- unlike resyncToLatest() (a tab-hidden resync, same link, intentionally keeps history)
    this._jitterSampleCount = 0
    this._jitterSampleIdx = 0
    this._jitterSorted = null
    this.p95Jitter = 0
    this.jitter = 0
  }

  // Drop every buffered snapshot except the newest, keeping RTT/jitter estimates intact (unlike
  // clear(), which also zeroes lastServerTime/lastClientTime -- those must survive so the very next
  // addSnapshot() doesn't misread a real large gap as fresh jitter). Used when a tab was hidden and
  // comes back: the buffer accumulated a stale backlog spanning the whole hidden period, and
  // replaying it via normal interpolation would visibly fast-forward remote players/entities through
  // that entire span. Snapping straight to latest is the correct resync, same intent as a reconnect.
  resyncToLatest() {
    const newest = this.buffer.last()
    this.buffer = new Deque()
    if (newest) this.buffer.push(newest)
  }
}
