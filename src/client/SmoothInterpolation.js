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
  }

  setLocalPlayer(id) { this.localPlayerId = id }

  addSnapshot(snapshot) {
    this.jitterBuffer.addSnapshot(snapshot)
    const now = performance.now()
    for (const p of snapshot.players || []) {
      let filter = this.playerFilters.get(p.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.playerKalmanConfig)
        this.playerFilters.set(p.id, filter)
      }
      filter.update(p.position, p.velocity, now)
    }
    for (const e of snapshot.entities || []) {
      if (e.bodyType !== 'dynamic') continue
      let filter = this.entityFilters.get(e.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.entityKalmanConfig)
        this.entityFilters.set(e.id, filter)
      }
      filter.update(e.position, null, now)
    }
  }

  getDisplayState(now = performance.now()) {
    const snapshot = this.jitterBuffer.getSnapshotToRender(now)
    if (!snapshot) return { players: [], entities: [] }

    const dt = this._lastDisplayTime > 0 ? Math.min((now - this._lastDisplayTime) / 1000, 0.1) : 0
    this._lastDisplayTime = now

    const players = snapshot.players || []
    const entities = snapshot.entities || []

    if (dt > 0) {
      for (let i = 0; i < players.length; i++) {
        const player = players[i]
        const filter = this.playerFilters.get(player.id)
        if (!filter) continue
        filter.predict(dt)
        const pos = player.position
        pos[0] = filter.x[0] + filter.v[0] * dt
        pos[1] = filter.x[1] + filter.v[1] * dt
        pos[2] = filter.x[2] + filter.v[2] * dt
        const vel = player.velocity
        if (vel) { vel[0] = filter.v[0]; vel[1] = filter.v[1]; vel[2] = filter.v[2] }
      }
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]
        if (entity.bodyType !== 'dynamic') continue
        const filter = this.entityFilters.get(entity.id)
        if (!filter) continue
        filter.predict(dt)
        const pos = entity.position
        if (pos) { pos[0] = filter.x[0]; pos[1] = filter.x[1]; pos[2] = filter.x[2] }
      }
    }

    return { players, entities }
  }

  removePlayer(id) { this.playerFilters.delete(id) }
  removeEntity(id) { this.entityFilters.delete(id) }

  updateRTT(pingTime, pongTime) { this.jitterBuffer.updateRTT(pingTime, pongTime) }
  getRTT() { return this.jitterBuffer.getRTT() }
  getJitter() { return this.jitterBuffer.getJitter() }
  getTargetDelay() { return this.jitterBuffer.getTargetDelay() }
  getBufferHealth() { return this.jitterBuffer.getBufferHealth() }

  reset() {
    this.jitterBuffer.clear()
    this.playerFilters.clear()
    this.entityFilters.clear()
    this._lastDisplayTime = 0
  }

  setConfig(config) {
    if (config.playerKalman) this.playerKalmanConfig = { ...this.playerKalmanConfig, ...config.playerKalman }
    if (config.entityKalman) this.entityKalmanConfig = { ...this.entityKalmanConfig, ...config.entityKalman }
  }
}
