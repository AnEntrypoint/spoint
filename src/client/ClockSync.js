export class ClockSync {
  constructor(config = {}) {
    this.maxSamples = config.maxSamples || 8
    this.samples = []
    this._offset = 0
    this._oneWayDelay = 0
    this._driftRate = 0
    this._lastDriftUpdateTs = 0
    this._lastDriftOffset = 0
    this._driftAlpha = config.driftAlpha ?? 0.05
    this._minDriftIntervalMs = config.minDriftIntervalMs ?? 2000
  }

  addSample(t0, t2, t3, t1 = t2) {
    if (!Number.isFinite(t0) || !Number.isFinite(t2) || !Number.isFinite(t3)) return
    const rtt = (t3 - t0) - (t2 - t1)
    if (rtt < 0) return
    const offset = ((t1 - t0) + (t2 - t3)) / 2

    const sample = { t0, t1, t2, t3, rtt, offset, ts: t3 }
    this.samples.push(sample)
    if (this.samples.length > this.maxSamples) this.samples.shift()

    this._recompute()
  }

  _recompute() {
    if (this.samples.length === 0) return
    let best = this.samples[0]
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].rtt < best.rtt) best = this.samples[i]
    }

    const prevOffset = this._offset
    this._offset = best.offset
    this._oneWayDelay = best.rtt / 2

    if (this._lastDriftUpdateTs === 0) {
      this._lastDriftUpdateTs = best.ts
      this._lastDriftOffset = best.offset
    } else {
      const dt = best.ts - this._lastDriftUpdateTs
      if (dt >= this._minDriftIntervalMs) {
        const instantRate = (best.offset - this._lastDriftOffset) / dt
        this._driftRate = this._driftRate * (1 - this._driftAlpha) + instantRate * this._driftAlpha
        this._lastDriftUpdateTs = best.ts
        this._lastDriftOffset = best.offset
      }
    }
    void prevOffset
  }

  getEstimatedServerTime(localNow = Date.now()) {
    const sinceLastSample = this._lastDriftUpdateTs ? (localNow - this._lastDriftUpdateTs) : 0
    return localNow + this._offset + this._driftRate * sinceLastSample
  }

  getOffset() { return this._offset }
  getOneWayDelay() { return this._oneWayDelay }
  getDriftRate() { return this._driftRate }
  getSampleCount() { return this.samples.length }

  estimateAgeMs(clientSendTime, localNow = Date.now()) {
    if (!Number.isFinite(clientSendTime)) return 0
    const serverNow = this.getEstimatedServerTime(localNow)
    const serverSendTime = clientSendTime + this._offset
    const age = serverNow - serverSendTime
    if (!Number.isFinite(age) || age < 0) return this._oneWayDelay
    return age
  }

  reset() {
    this.samples.length = 0
    this._offset = 0
    this._oneWayDelay = 0
    this._driftRate = 0
    this._lastDriftUpdateTs = 0
    this._lastDriftOffset = 0
  }
}
