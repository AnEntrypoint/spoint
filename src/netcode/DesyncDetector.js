const RESOLVED_TICK_HISTORY_MAX = 128

export const DEFAULT_CHECKSUM_INTERVAL_TICKS = 30

export class DesyncDetector {
  constructor({ checksumIntervalTicks = DEFAULT_CHECKSUM_INTERVAL_TICKS, expectedPeerIds, onDesync = null, onVerified = null } = {}) {
    if (!Array.isArray(expectedPeerIds) || expectedPeerIds.length === 0) {
      throw new Error('[DesyncDetector] expectedPeerIds (the full peer roster for this lockstep session) is required')
    }
    this.checksumIntervalTicks = checksumIntervalTicks
    this.expectedPeerIds = [...expectedPeerIds]
    this.onDesync = onDesync
    this.onVerified = onVerified
    this._pending = new Map()
    this._resolvedTicks = new Set()
    this._maxPendingRows = 64
  }

  isChecksumTick(tick) { return Number.isInteger(tick) && tick % this.checksumIntervalTicks === 0 }

  expects(peerId) { return this.expectedPeerIds.includes(peerId) }

  reportChecksum(tick, peerId, checksum) {
    if (!this.expectedPeerIds.includes(peerId)) {
      throw new Error(`[DesyncDetector] checksum reported by unknown peer ${peerId}, not in expectedPeerIds`)
    }
    if (!this.isChecksumTick(tick) || this._resolvedTicks.has(tick)) return null
    let row = this._pending.get(tick)
    if (!row) {
      row = new Map()
      this._pending.set(tick, row)
      this._evictOverflow()
    }
    row.set(peerId, checksum)
    if (row.size < this.expectedPeerIds.length) return null
    return this._resolve(tick, row)
  }

  _resolve(tick, row) {
    this._pending.delete(tick)
    this._resolvedTicks.add(tick)
    if (this._resolvedTicks.size > RESOLVED_TICK_HISTORY_MAX) this._resolvedTicks.delete(this._resolvedTicks.values().next().value)

    const counts = new Map()
    for (const cs of row.values()) counts.set(cs, (counts.get(cs) || 0) + 1)
    let majorityChecksum = null, majorityCount = -1
    for (const [cs, count] of counts) { if (count > majorityCount) { majorityChecksum = cs; majorityCount = count } }

    if (counts.size === 1) {
      if (this.onVerified) this.onVerified(tick, majorityChecksum)
      return { status: 'verified', tick, checksum: majorityChecksum }
    }

    const strictMajority = majorityCount * 2 > row.size
    const offenders = []
    if (strictMajority) for (const [peerId, cs] of row) if (cs !== majorityChecksum) offenders.push(peerId)
    const result = { status: 'desync', tick, reports: row, majorityChecksum: strictMajority ? majorityChecksum : null, strictMajority, offenders }
    if (this.onDesync) this.onDesync(tick, result)
    return result
  }

  dropPending(tick) { this._pending.delete(tick) }

  removePeer(peerId) {
    const i = this.expectedPeerIds.indexOf(peerId)
    if (i < 0) return
    this.expectedPeerIds.splice(i, 1)
    for (const [tick, row] of [...this._pending]) {
      row.delete(peerId)
      if (this.expectedPeerIds.length && row.size >= this.expectedPeerIds.length) this._resolve(tick, row)
    }
  }

  _evictOverflow() {
    while (this._pending.size > this._maxPendingRows) {
      const oldest = this._pending.keys().next().value
      this._pending.delete(oldest)
    }
  }

  get pendingCount() { return this._pending.size }
}

