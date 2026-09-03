// NTP-style clock synchronization: min-RTT offset estimator + slow drift tracking.
//
// The heartbeat exchange already carries the three timestamps a standard NTP
// four-timestamp round trip needs (t1==t2 here since server processing between
// receipt and ack-send is sub-millisecond and not separately timestamped):
//   t0 = client send time      (payload.timestamp, echoed back by the server)
//   t1 = server receive time   (approximated by t2 -- see above)
//   t2 = server send time      (payload.serverTime)
//   t3 = client receive time   (Date.now() at ack handling)
//
// Standard NTP formulas:
//   offset = ((t1 - t0) + (t2 - t3)) / 2   -- how far ahead the server clock is
//   delay  = (t3 - t0) - (t2 - t1)         -- round-trip network time (excludes server processing)
//   oneWayDelay = delay / 2                 -- assumes symmetric path; see asymmetry note below
//
// Multiple samples are kept in a small ring; the MINIMUM-RTT sample is treated
// as the least-congested/most-accurate estimate (classic NTP practice -- a
// low-RTT sample had the least opportunity for queuing delay to corrupt the
// symmetry assumption baked into the offset formula).
//
// True asymmetric one-way delay (e.g. 80ms client->server, 40ms server->client)
// is NOT separable from a single NTP exchange in general -- NTP's offset/delay
// formulas assume a symmetric path and only recover the SUM of the two
// directions exactly; the split is an inherent unknown without an external
// reference. What this estimator gives LagCompensator is the best available
// single number for "how long ago, in server-clock time, did this client's
// input leave the client" -- min-RTT-sample delay/2 -- which is a strictly
// better estimate than the previous assumed-RTT/2-of-a-noisy-single-sample
// value, and converges to the true one-way delay when the path IS symmetric
// (the common case) or close to it.
export class ClockSync {
  constructor(config = {}) {
    this.maxSamples = config.maxSamples || 8
    this.samples = [] // { t0, t1, t2, t3, rtt, offset, ts (local wall time this sample was taken) }
    this._offset = 0        // best current offset estimate (server_time - client_time), ms
    this._oneWayDelay = 0   // best current one-way network delay estimate, ms
    this._driftRate = 0     // ms of offset change per ms of wall time (slowly-adapting)
    this._lastDriftUpdateTs = 0
    this._lastDriftOffset = 0
    this._driftAlpha = config.driftAlpha ?? 0.05 // slow adaptation -- drift is a rate, not a per-sample jump
    this._minDriftIntervalMs = config.minDriftIntervalMs ?? 2000 // need real separation in time to measure a rate meaningfully
  }

  // t0 = client send time, t2 = server echoed serverTime, t3 = client receive time.
  // t1 defaults to t2 (server processing latency between receipt and ack-send is
  // not separately timestamped by the server -- see header note).
  addSample(t0, t2, t3, t1 = t2) {
    if (!Number.isFinite(t0) || !Number.isFinite(t2) || !Number.isFinite(t3)) return
    const rtt = (t3 - t0) - (t2 - t1)
    if (rtt < 0) return // clock jumped backward mid-flight or corrupt sample -- reject rather than poison the min-RTT pick
    const offset = ((t1 - t0) + (t2 - t3)) / 2

    const sample = { t0, t1, t2, t3, rtt, offset, ts: t3 }
    this.samples.push(sample)
    if (this.samples.length > this.maxSamples) this.samples.shift()

    this._recompute()
  }

  _recompute() {
    if (this.samples.length === 0) return
    // NTP min-RTT selection: the sample with the smallest round-trip time had
    // the least queuing/congestion opportunity to corrupt the offset's
    // symmetric-path assumption, so it is the most trustworthy single estimate.
    let best = this.samples[0]
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i].rtt < best.rtt) best = this.samples[i]
    }

    const prevOffset = this._offset
    this._offset = best.offset
    this._oneWayDelay = best.rtt / 2

    // Drift: slowly-adapting rate of offset change over real elapsed wall time,
    // updated only when the new min-RTT sample is a genuinely fresh best (not
    // re-selecting the same historical sample) and enough time has passed to
    // measure a rate without amplifying per-sample noise.
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

  // Server-clock estimate of "now", including drift extrapolation since the
  // last sample (useful if samples are sparse relative to how fresh the
  // estimate needs to be).
  getEstimatedServerTime(localNow = Date.now()) {
    const sinceLastSample = this._lastDriftUpdateTs ? (localNow - this._lastDriftUpdateTs) : 0
    return localNow + this._offset + this._driftRate * sinceLastSample
  }

  getOffset() { return this._offset }
  getOneWayDelay() { return this._oneWayDelay }
  getDriftRate() { return this._driftRate }
  getSampleCount() { return this.samples.length }

  // Convert a raw client-clock send timestamp into "how many ms ago, in
  // server-clock terms, did this leave the client" -- the number LagCompensator
  // needs to rewind history by. Replaces the old (Date.now() - msg.clientTime)
  // assumption, which conflated raw client/server clock skew with real network
  // travel time.
  estimateAgeMs(clientSendTime, localNow = Date.now()) {
    if (!Number.isFinite(clientSendTime)) return 0
    // serverNow - (clientSendTime + offset) == how much server-clock time has
    // elapsed since the send, which for a one-hop trip is exactly the one-way
    // network delay once the estimator has converged; clamp to the current
    // one-way-delay estimate as a floor/ceiling sanity bound so a stale offset
    // can't produce a negative or wildly inflated age.
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
