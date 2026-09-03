// Automatic network-condition-driven trigger for PhysicsNetworkClient.migrateTransport() -- the remaining
// scope split out of transport-connection-migration-session-handoff after that row shipped the real
// MIGRATE/MIGRATE_ACK protocol + manual/programmatic migrateTransport(kind?) call. This module is the
// AUTOMATIC caller: it owns two independent real-condition watchers and fires migrateTransport() itself,
// with a cooldown/backoff discipline so a persistently-bad condition never hot-loops the migration attempt
// every frame/tick it remains true.
//
// (a) navigator.connection (NetworkInformation API) effectiveType/type change listener -- wifi<->cellular
//     or any other network-path change fires a proactive migration attempt. Feature-detected the same
//     explicit way isWebTransportSupported() feature-detects WebTransport (see hasConnectionAPI below):
//     navigator.connection is Chromium-only (absent in Firefox/Safari/Node) and must never be assumed.
// (b) A repeated-loss/latency-spike detector reusing signal already available client-side: the live
//     smoothed RTT from client.getRTT() (heartbeat-driven, ~1Hz, see MessageHandler._handleHeartbeat).
//     Sampled on the same ~1Hz cadence as the heartbeat that produces it; N consecutive samples above
//     `rttSpikeThresholdMs` (default 300ms, a real degraded-path signal, not jitter noise) triggers a
//     migration attempt as a lighter-weight alternative to waiting for a full disconnect+reconnect.
//
// Backoff: mirrors ReconnectManager's own exponential-backoff SHAPE (1000 * 1.5^attempts, capped) but is a
// SEPARATE counter/timer -- migration attempts are opportunistic self-healing on an already-open connection,
// not the disconnect/reconnect state machine, so reusing ReconnectManager's actual instance would wrongly
// couple "the RTT looks bad" to "we are offline". A successful migration resets the counter to 0 (the
// degraded path was actually replaced); a 'failed'/'unsupported' result advances it, capping the retry rate
// under a persistently bad network instead of re-attempting every single spike/condition-change tick.
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
    // Diagnostics for a UI/debug surface (mirrors window.__netSim's live-inspectable-instance pattern).
    if (typeof window !== 'undefined') window.__transportMigrationTrigger = this
  }

  // Real feature-detection, never assumed -- same discipline as isWebTransportSupported(). navigator.connection
  // (NetworkInformation) is a Chromium-only API; Firefox/Safari/Node lack it entirely.
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
    // RTT-spike polling on the same ~1Hz cadence as the heartbeat sample that produces getRTT() -- polling
    // faster would just re-read the same stale sample between heartbeats.
    this._rttPollTimer = setInterval(() => this._pollRtt(), 1000)
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

  // Single funnel for both trigger sources -- enforces the not-hot-looping cooldown/backoff and the
  // never-overlap-a-migration-in-flight guard (migrateTransport() itself is not reentrant-safe: a second
  // concurrent call would open a second candidate against a `gen` already superseded by the first).
  async _attemptMigration(reason, detail) {
    if (this._migrating || this._inCooldown()) return
    if (!this._client || typeof this._client.migrateTransport !== 'function') return
    // Only a live, already-connected transport is a migration candidate -- while reconnecting/offline the
    // existing ReconnectManager owns recovery entirely.
    if (this._client._isOpen && !this._client._isOpen()) return
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
