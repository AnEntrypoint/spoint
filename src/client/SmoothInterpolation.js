import { KalmanFilter3D } from './KalmanFilter.js'
import { JitterBuffer } from './JitterBuffer.js'

export class SmoothInterpolation {
  constructor(config = {}) {
    this.jitterBuffer = new JitterBuffer(config.jitter || {})
    this.playerFilters = new Map()
    this.entityFilters = new Map()
    this.playerKalmanConfig = config.playerKalman || {
      positionQ: 2.0, velocityQ: 4.0, positionR: 0.01, velocityR: 0.1
    }
    this.entityKalmanConfig = config.entityKalman || {
      positionQ: 2.0, velocityQ: 4.0, positionR: 0.01, velocityR: 0.5
    }
    this.localPlayerId = null
    this.predictionEnabled = config.predictionEnabled !== false
    this._lastDisplayTime = 0
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
    this._displayResult = { players: [], entities: [] }
    // Staleness cap: once a filter's underlying data (KalmanFilter3D._lastUpdateMs, stamped only by a
    // real filter.update() call from addSnapshot) is older than this, getDisplayState stops calling
    // predict() for that filter and holds it frozen at its last extrapolated position instead of
    // continuing to integrate stale velocity forever. Covers packet loss, a disconnected/departed peer
    // whose PLAYER_LEAVE never arrived, or a network partition -- addSnapshot simply stops being called
    // while the render loop (and thus getDisplayState) keeps running. 1000ms is comfortably above
    // JitterBuffer's own maxDelay (250ms default) plus real jitter, so normal buffered/bracketed
    // rendering never trips it, while still bounding worst-case drift to <=1s of stale velocity instead
    // of unbounded (a real bug this value fixes: 226m of drift measured over 5s of silence pre-fix).
    this.maxExtrapolationMs = config.maxExtrapolationMs || 1000
  }

  setLocalPlayer(id) { this.localPlayerId = id }

  addSnapshot(snapshot) {
    this.jitterBuffer.addSnapshot(snapshot)
    const now = performance.now()
    // The seen-id Sets exist only to drive the prune below, and the prune only runs when there are
    // more filters than ids seen this snapshot (a player/entity actually left). A snapshot carries at
    // most one entry per id (SnapshotProcessor emits one per _playerStates/_entityStates key), so the
    // seen-COUNT the guard needs is just the loop's own tally -- the Set is filled only on the rare
    // snapshot that actually prunes, removing one Set.add per player and per dynamic entity per
    // snapshot from the steady state.
    const players = snapshot.players || []
    for (let i = 0; i < players.length; i++) {
      const p = players[i]
      let filter = this.playerFilters.get(p.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.playerKalmanConfig)
        this.playerFilters.set(p.id, filter)
      }
      filter.update(p.position, p.velocity, now)
    }
    if (this.playerFilters.size > players.length) {
      this._seenPlayers.clear()
      for (let i = 0; i < players.length; i++) this._seenPlayers.add(players[i].id)
      for (const id of this.playerFilters.keys()) {
        if (!this._seenPlayers.has(id)) this.playerFilters.delete(id)
      }
    }
    const entities = snapshot.entities || []
    let seenEntityCount = 0
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]
      if (e.bodyType !== 'dynamic') continue
      seenEntityCount++
      let filter = this.entityFilters.get(e.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.entityKalmanConfig)
        this.entityFilters.set(e.id, filter)
      }
      // use server velocity, not null -- null forces the filter to numerically differentiate position (noisy)
      filter.update(e.position, e.velocity || null, now)
    }
    if (this.entityFilters.size > seenEntityCount) {
      this._seenEntities.clear()
      for (let i = 0; i < entities.length; i++) { if (entities[i].bodyType === 'dynamic') this._seenEntities.add(entities[i].id) }
      for (const id of this.entityFilters.keys()) {
        if (!this._seenEntities.has(id)) this.entityFilters.delete(id)
      }
    }
  }

  getDisplayState(now = performance.now()) {
    const snapshot = this.jitterBuffer.getSnapshotToRender(now)
    if (!snapshot) { this._displayResult.players = []; this._displayResult.entities = []; return this._displayResult }

    const dt = this._lastDisplayTime > 0 ? Math.min((now - this._lastDisplayTime) / 1000, 0.1) : 0
    this._lastDisplayTime = now

    const players = snapshot.players || []
    const entities = snapshot.entities || []

    if (dt > 0) {
      for (let i = 0; i < players.length; i++) {
        const player = players[i]
        const filter = this.playerFilters.get(player.id)
        if (!filter) continue
        // Freeze (skip predict) once this filter's real data is older than maxExtrapolationMs -- see
        // constructor comment. filter.x/filter.v are left exactly as they were on the last successful
        // predict()/update(), so the displayed position holds steady rather than drifting further.
        if (now - filter._lastUpdateMs <= this.maxExtrapolationMs) filter.predict(dt)
        const pos = player.position
        pos[0] = filter.x[0]; pos[1] = filter.x[1]; pos[2] = filter.x[2]
        const vel = player.velocity
        if (vel) { vel[0] = filter.v[0]; vel[1] = filter.v[1]; vel[2] = filter.v[2] }
      }
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]
        if (entity.bodyType !== 'dynamic') continue
        const filter = this.entityFilters.get(entity.id)
        if (!filter) continue
        if (now - filter._lastUpdateMs <= this.maxExtrapolationMs) filter.predict(dt)
        const pos = entity.position
        if (pos) { pos[0] = filter.x[0]; pos[1] = filter.x[1]; pos[2] = filter.x[2] }
      }
    }

    this._displayResult.players = players
    this._displayResult.entities = entities
    return this._displayResult
  }

  removePlayer(id) { this.playerFilters.delete(id) }
  removeEntity(id) { this.entityFilters.delete(id) }

  updateRTT(pingTime, pongTime) { this.jitterBuffer.updateRTT(pingTime, pongTime); this.adaptToRTT() }

  adaptToRTT() {
    const rtt = this.jitterBuffer.getRTT()
    for (const f of this.playerFilters.values()) f.setQR(rtt, this.playerKalmanConfig)
    for (const f of this.entityFilters.values()) f.setQR(rtt, this.entityKalmanConfig)
  }
  getRTT() { return this.jitterBuffer.getRTT() }
  getJitter() { return this.jitterBuffer.getJitter() }
  getP95Jitter() { return this.jitterBuffer.getP95Jitter() }
  getTargetDelay() { return this.jitterBuffer.getTargetDelay() }
  getBufferHealth() { return this.jitterBuffer.getBufferHealth() }

  reset() {
    this.jitterBuffer.clear()
    this.playerFilters.clear()
    this.entityFilters.clear()
    this._lastDisplayTime = 0
  }

  // Tab-visibility resync: drop the stale backlog a hidden tab accumulated (addSnapshot kept running
  // while rAF/getDisplayState did not, so the buffer can hold many minutes of now-irrelevant
  // snapshots) and jump straight to the latest received one. Kalman filters are left untouched -- the
  // next addSnapshot's filter.update() call re-anchors them from the fresh snapshot's real
  // position/velocity, and predict()'s dt is naturally clamped to 0.1s by getDisplayState, so a filter
  // built on a stale position self-corrects within one frame; no need to also clear the filter maps.
  resyncToLatest() {
    this.jitterBuffer.resyncToLatest()
    this._lastDisplayTime = 0
  }

  setConfig(config) {
    if (config.playerKalman) this.playerKalmanConfig = { ...this.playerKalmanConfig, ...config.playerKalman }
    if (config.entityKalman) this.entityKalmanConfig = { ...this.entityKalmanConfig, ...config.entityKalman }
    if (config.maxExtrapolationMs) this.maxExtrapolationMs = config.maxExtrapolationMs
  }
}
