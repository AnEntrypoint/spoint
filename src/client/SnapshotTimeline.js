import { slerpQuat } from './interpolation.js'

const MAX_BUFFERED_SNAPSHOTS = 32
const OFFSET_WINDOW = 90
const JITTER_PERCENTILE = 0.8
const DELAY_INTERVALS = 1.5
const MAX_DELAY_MS = 400
const RESYNC_ERROR_MS = 200
const CONVERGE_PER_S = 4
const MAX_EXTRAPOLATE_MS = 100
const TAU = 2 * Math.PI

function lerp(a, b, t) { return a + (b - a) * t }
function lerpAngle(a, b, t) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return a + d * t }

function makePlayerOut() {
  return { id: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0 }
}

function writePlayer(o, a, b, t, extraS) {
  o.id = b.id
  for (let i = 0; i < 3; i++) o.position[i] = lerp(a.position[i], b.position[i], t) + b.velocity[i] * extraS
  slerpQuat(o.rotation, a.rotation, b.rotation, t)
  for (let i = 0; i < 3; i++) o.velocity[i] = lerp(a.velocity[i], b.velocity[i], t)
  o.onGround = b.onGround; o.health = b.health; o.crouch = b.crouch; o.expr = b.expr; o.weapon = b.weapon
  o.lookPitch = lerp(a.lookPitch || 0, b.lookPitch || 0, t)
  o.lookYaw = lerpAngle(a.lookYaw || 0, b.lookYaw || 0, t)
}

export class SnapshotTimeline {
  constructor({ tickRate = 60 } = {}) {
    this.tickMs = 1000 / tickRate
    this._snaps = []
    this._offsets = new Float64Array(OFFSET_WINDOW)
    this._offsetCount = 0
    this._offsetIdx = 0
    this._sorted = new Float64Array(OFFSET_WINDOW)
    this._baseOffsetMs = 0
    this._jitterMs = 0
    this._intervalMs = 0
    this._renderMs = NaN
    this._lastSampleNow = 0
    this._out = { tick: 0, renderMs: 0, players: [] }
    this._playerPool = []
    this._byIdA = new Map()
    this.stats = { extrapolatedSamples: 0, heldSamples: 0, resyncs: 0, samples: 0 }
  }

  setTickRate(rate) { if (rate > 0) this.tickMs = 1000 / rate }

  _recordOffset(offset) {
    this._offsets[this._offsetIdx] = offset
    this._offsetIdx = (this._offsetIdx + 1) % OFFSET_WINDOW
    if (this._offsetCount < OFFSET_WINDOW) this._offsetCount++
    const n = this._offsetCount, s = this._sorted
    for (let i = 0; i < n; i++) s[i] = this._offsets[i]
    const view = s.subarray(0, n).sort()
    this._baseOffsetMs = view[0]
    this._jitterMs = view[Math.min(n - 1, Math.ceil(n * JITTER_PERCENTILE) - 1)] - view[0]
  }

  addSnapshot(snapshot, arrivalMs = performance.now()) {
    const tick = snapshot.tick || 0
    const snaps = this._snaps
    const newest = snaps[snaps.length - 1]
    if (newest && tick <= newest.tick) return
    if (newest) {
      const gap = (tick - newest.tick) * this.tickMs
      this._intervalMs = this._intervalMs ? this._intervalMs * 0.9 + gap * 0.1 : gap
    }
    this._recordOffset(arrivalMs - tick * this.tickMs)
    snaps.push({ tick, serverMs: tick * this.tickMs, players: snapshot.players || [] })
    if (snaps.length > MAX_BUFFERED_SNAPSHOTS) snaps.shift()
  }

  targetDelayMs() {
    const interval = this._intervalMs || this.tickMs
    return Math.max(this.tickMs, Math.min(MAX_DELAY_MS, DELAY_INTERVALS * interval + this._jitterMs))
  }

  _advanceRenderTime(now) {
    const desired = now - this._baseOffsetMs - this.targetDelayMs()
    if (!Number.isFinite(this._renderMs)) { this._renderMs = desired; this._lastSampleNow = now; return }
    const dt = Math.max(0, now - this._lastSampleNow)
    this._lastSampleNow = now
    this._renderMs += dt
    const err = desired - this._renderMs
    if (Math.abs(err) > RESYNC_ERROR_MS) { this._renderMs = desired; this.stats.resyncs++; return }
    this._renderMs += err * Math.min(1, (dt / 1000) * CONVERGE_PER_S)
  }

  sample(now = performance.now()) {
    const out = this._out
    const snaps = this._snaps
    if (!snaps.length) { out.players.length = 0; return out }
    this._advanceRenderTime(now)
    this.stats.samples++
    const rt = this._renderMs
    while (snaps.length > 2 && snaps[1].serverMs <= rt) snaps.shift()
    let a = snaps[0], b = snaps[snaps.length > 1 ? 1 : 0], t = 0, extraS = 0
    if (snaps.length > 1 && rt >= a.serverMs && rt <= b.serverMs) t = (rt - a.serverMs) / (b.serverMs - a.serverMs || 1)
    else if (rt > b.serverMs) { a = b; t = 1; extraS = Math.min(MAX_EXTRAPOLATE_MS, rt - b.serverMs) / 1000; if (extraS < (rt - b.serverMs) / 1000) this.stats.heldSamples++; else this.stats.extrapolatedSamples++ }
    else { b = a; t = 0 }
    out.tick = b.tick; out.renderMs = rt
    const byIdA = this._byIdA, pool = this._playerPool, dst = out.players
    byIdA.clear()
    for (const p of a.players) byIdA.set(p.id, p)
    dst.length = 0
    for (const bp of b.players) {
      if (!bp.position) continue
      const ap = byIdA.get(bp.id) || bp
      while (pool.length <= dst.length) pool.push(makePlayerOut())
      const o = pool[dst.length]
      writePlayer(o, ap, bp, ap === bp ? 1 : t, extraS)
      dst.push(o)
    }
    return out
  }

  resync() { this._renderMs = NaN }

  reset() { this._snaps.length = 0; this._offsetCount = 0; this._offsetIdx = 0; this._intervalMs = 0; this._renderMs = NaN }

  get bufferedAhead() {
    let n = 0
    for (const s of this._snaps) if (s.serverMs > this._renderMs) n++
    return n
  }

  getStats() { return { ...this.stats, delayMs: this.targetDelayMs(), jitterMs: this._jitterMs, intervalMs: this._intervalMs, buffered: this._snaps.length, ahead: this.bufferedAhead, renderMs: this._renderMs } }
}
