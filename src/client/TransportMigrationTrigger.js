const HEARTBEAT_CADENCE_RTT_POLL_MS = 1000

export class TransportMigrationTrigger {
  constructor(client, config = {}) {
    this._client = client
    this._rttSpikeThresholdMs = config.rttSpikeThresholdMs || 300
    this._rttSpikeStreakNeeded = config.rttSpikeStreakNeeded || 3
    this._baseBackoffMs = config.baseBackoffMs || 1000
    this._maxBackoffMs = config.maxBackoffMs || 30000
    this._rttStreak = 0
    this._attempts = 0
    this._cooldownUntil = 0
    this._migrating = false
    this._rttPollTimer = null
    this._connectionListener = null
    this._started = false
    this._lastResult = null
    if (typeof window !== 'undefined') window.__transportMigrationTrigger = this
  }

  static hasConnectionAPI() {
    return typeof navigator !== 'undefined' && !!navigator.connection && typeof navigator.connection.addEventListener === 'function'
  }

  start() {
    if (this._started) return
    this._started = true
    if (TransportMigrationTrigger.hasConnectionAPI()) {
      const conn = navigator.connection
      this._connectionListener = () => this._onConnectionChange(conn.effectiveType, conn.type)
      conn.addEventListener('change', this._connectionListener)
    }
    this._rttPollTimer = setInterval(() => this._pollRtt(), HEARTBEAT_CADENCE_RTT_POLL_MS)
  }

  stop() {
    this._started = false
    if (this._connectionListener && TransportMigrationTrigger.hasConnectionAPI()) {
      navigator.connection.removeEventListener('change', this._connectionListener)
    }
    this._connectionListener = null
    if (this._rttPollTimer) { clearInterval(this._rttPollTimer); this._rttPollTimer = null }
    this._rttStreak = 0
  }

  _inCooldown() { return Date.now() < this._cooldownUntil }

  _onConnectionChange(effectiveType, type) {
    this._attemptMigration('connection-change', { effectiveType, type })
  }

  _pollRtt() {
    const rtt = this._client.getRTT?.() || 0
    if (rtt > this._rttSpikeThresholdMs) {
      this._rttStreak++
      if (this._rttStreak >= this._rttSpikeStreakNeeded) {
        this._rttStreak = 0
        this._attemptMigration('rtt-spike', { rtt })
      }
    } else {
      this._rttStreak = 0
    }
  }

  async _attemptMigration(reason, detail) {
    if (this._migrating || this._inCooldown()) return
    if (!this._client || typeof this._client.migrateTransport !== 'function') return
    const reconnectManagerOwnsRecovery = this._client._isOpen && !this._client._isOpen()
    if (reconnectManagerOwnsRecovery) return
    this._migrating = true
    let result = 'failed'
    try { result = await this._client.migrateTransport() }
    catch (e) { result = 'failed' }
    finally { this._migrating = false }
    this._lastResult = { reason, detail, result, at: Date.now() }
    if (result === 'migrated') {
      this._attempts = 0
      this._cooldownUntil = 0
    } else {
      this._attempts++
      const delay = Math.min(this._baseBackoffMs * Math.pow(1.5, this._attempts - 1), this._maxBackoffMs)
      this._cooldownUntil = Date.now() + delay
    }
    return result
  }

  getStats() {
    return { attempts: this._attempts, cooldownUntil: this._cooldownUntil, migrating: this._migrating, lastResult: this._lastResult, rttStreak: this._rttStreak }
  }
}
