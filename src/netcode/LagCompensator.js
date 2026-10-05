import { reexpressYawQuat } from '../shared/chartReexpress.js'

const HISTORY_CAPACITY = 256
const DEFAULT_TICK_RATE = 60
const FUTURE_TOLERANCE_TICKS = 1
const REWIND_BUCKET_CAPACITY = 10
const REWIND_REFILL_PER_SEC = 20
const DEFAULT_MAX_ORIGIN_DRIFT_M = 2

const _monotonicNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now()

const _envWindow = () => {
  try { if (typeof process !== 'undefined' && process.env) return Number(process.env.SPOINT_LAG_HISTORY_WINDOW) || 0 } catch {}
  return 0
}

function makeSample() {
  return { tick: 0, timestamp: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }
}

function nlerpQuat(out, a, b, t) {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1
  let x = a[0] + (s * b[0] - a[0]) * t, y = a[1] + (s * b[1] - a[1]) * t, z = a[2] + (s * b[2] - a[2]) * t, w = a[3] + (s * b[3] - a[3]) * t
  const n = Math.hypot(x, y, z, w) || 1
  out[0] = x / n; out[1] = y / n; out[2] = z / n; out[3] = w / n
  return out
}

export class LagCompensator {
  constructor(historyWindow = _envWindow() || 1000, tickRate = DEFAULT_TICK_RATE) {
    this.historyWindow = historyWindow
    this.tickRate = tickRate
    this.playerHistory = new Map()
    this.latestTick = 0
    this._rewindBuckets = new Map()
    this.stats = { rewinds: 0, clamped: 0, rejected: 0, rateLimited: 0, maxRewindTicks: 0 }
  }

  setTickRate(tickRate) { if (tickRate > 0) this.tickRate = tickRate }

  get windowTicks() { return Math.max(1, Math.round(this.historyWindow * this.tickRate / 1000)) }

  recordPlayerPosition(playerId, position, rotation, velocity, tick) {
    let ring = this.playerHistory.get(playerId)
    if (!ring) { ring = { buf: Array.from({ length: HISTORY_CAPACITY }, makeSample), head: 0, len: 0 }; this.playerHistory.set(playerId, ring) }
    const last = ring.len ? ring.buf[(ring.head + ring.len - 1) % HISTORY_CAPACITY] : null
    const entry = last && last.tick === tick ? last : ring.buf[(ring.head + ring.len) % HISTORY_CAPACITY]
    if (entry !== last) { if (ring.len < HISTORY_CAPACITY) ring.len++; else ring.head = (ring.head + 1) % HISTORY_CAPACITY }
    entry.tick = tick; entry.timestamp = _monotonicNow()
    entry.position[0] = position[0]; entry.position[1] = position[1]; entry.position[2] = position[2]
    entry.rotation[0] = rotation[0]; entry.rotation[1] = rotation[1]; entry.rotation[2] = rotation[2]; entry.rotation[3] = rotation[3]
    entry.velocity[0] = velocity[0]; entry.velocity[1] = velocity[1]; entry.velocity[2] = velocity[2]
    if (tick > this.latestTick) this.latestTick = tick
    const oldestAllowed = tick - this.windowTicks - 1
    while (ring.len > 1 && ring.buf[ring.head].tick < oldestAllowed) { ring.head = (ring.head + 1) % HISTORY_CAPACITY; ring.len-- }
  }

  resolveViewTick(reportedTick, currentTick = this.latestTick) {
    if (typeof reportedTick !== 'number' || !Number.isFinite(reportedTick)) { this.stats.rejected++; return null }
    if (reportedTick > currentTick + FUTURE_TOLERANCE_TICKS) { this.stats.rejected++; return null }
    const oldest = currentTick - this.windowTicks
    if (reportedTick < oldest) { this.stats.clamped++; return oldest }
    return Math.min(reportedTick, currentTick)
  }

  acceptRewind(shooterId, nowMs = _monotonicNow()) {
    let b = this._rewindBuckets.get(shooterId)
    if (!b) { b = { tokens: REWIND_BUCKET_CAPACITY, at: nowMs }; this._rewindBuckets.set(shooterId, b) }
    b.tokens = Math.min(REWIND_BUCKET_CAPACITY, b.tokens + (nowMs - b.at) / 1000 * REWIND_REFILL_PER_SEC)
    b.at = nowMs
    if (b.tokens < 1) { this.stats.rateLimited++; return false }
    b.tokens -= 1
    return true
  }

  rewindAtTick(playerId, tick, out = null) {
    const ring = this.playerHistory.get(playerId)
    if (!ring || ring.len === 0) return null
    const at = i => ring.buf[(ring.head + i) % HISTORY_CAPACITY]
    const o = out || makeSample()
    const first = at(0), last = at(ring.len - 1)
    let a = first, b = first, t = 0
    if (tick >= last.tick) { a = b = last }
    else if (tick > first.tick) {
      let lo = 0, hi = ring.len - 1
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (at(mid).tick <= tick) lo = mid; else hi = mid }
      a = at(lo); b = at(hi); t = (tick - a.tick) / ((b.tick - a.tick) || 1)
    }
    o.tick = tick
    for (let i = 0; i < 3; i++) { o.position[i] = a.position[i] + (b.position[i] - a.position[i]) * t; o.velocity[i] = a.velocity[i] + (b.velocity[i] - a.velocity[i]) * t }
    nlerpQuat(o.rotation, a.rotation, b.rotation, t)
    const rewoundTicks = this.latestTick - tick
    if (rewoundTicks > this.stats.maxRewindTicks) this.stats.maxRewindTicks = rewoundTicks
    this.stats.rewinds++
    return o
  }

  validateShotOrigin(shooterPosition, clientOrigin, eyeHeight, maxDriftM = DEFAULT_MAX_ORIGIN_DRIFT_M) {
    const eye = [shooterPosition[0], shooterPosition[1] + eyeHeight, shooterPosition[2]]
    if (!Array.isArray(clientOrigin) || clientOrigin.length !== 3 || !clientOrigin.every(Number.isFinite)) return eye
    const d = Math.hypot(clientOrigin[0] - eye[0], clientOrigin[1] - eye[1], clientOrigin[2] - eye[2])
    return d <= maxDriftM ? [clientOrigin[0], clientOrigin[1], clientOrigin[2]] : eye
  }

  getPlayerStateAtTime(playerId, millisAgo) {
    const ticksAgo = millisAgo * this.tickRate / 1000
    return this.rewindAtTick(playerId, this.latestTick - ticksAgo)
  }

  detectTeleport(playerId, newPosition, threshold = 50) {
    const ring = this.playerHistory.get(playerId)
    if (!ring || ring.len < 2) return false
    const lastPos = ring.buf[(ring.head + ring.len - 1) % HISTORY_CAPACITY].position
    return Math.hypot(newPosition[0] - lastPos[0], newPosition[1] - lastPos[1], newPosition[2] - lastPos[2]) > threshold
  }

  applyChartTransfer(transfer) {
    let samples = 0
    for (const ring of this.playerHistory.values()) {
      for (let i = 0; i < ring.len; i++) {
        const s = ring.buf[(ring.head + i) % HISTORY_CAPACITY]
        transfer.point(s.position, s.position)
        transfer.vec(s.velocity, s.velocity)
        reexpressYawQuat(transfer, s.rotation)
        samples++
      }
    }
    return samples
  }

  clearPlayerHistory(playerId) {
    this.playerHistory.delete(playerId)
    this._rewindBuckets.delete(playerId)
  }

  getStats() {
    let total = 0
    for (const ring of this.playerHistory.values()) total += ring.len
    return { trackedPlayers: this.playerHistory.size, totalSamples: total, ...this.stats, maxRewindMs: this.stats.maxRewindTicks * 1000 / this.tickRate }
  }
}
