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
    const now = Date.now()
    for (const p of snapshot.players || []) {
      if (p.id === this.localPlayerId && this.predictionEnabled) continue
      let filter = this.playerFilters.get(p.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.playerKalmanConfig)
        this.playerFilters.set(p.id, filter)
      }
      filter.update(p.position, p.velocity, now)
    }
    for (const e of snapshot.entities || []) {
      let filter = this.entityFilters.get(e.id)
      if (!filter) {
        filter = new KalmanFilter3D(this.entityKalmanConfig)
        this.entityFilters.set(e.id, filter)
      }
      filter.update(e.position, null, now)
    }
  }

  getDisplayState(now = Date.now()) {
    const snapshot = this.jitterBuffer.getSnapshotToRender(now)
    if (!snapshot) return { players: [], entities: [] }

    const dt = this._lastDisplayTime > 0 ? Math.min((now - this._lastDisplayTime) / 1000, 0.1) : 0
    this._lastDisplayTime = now

    const displayPlayers = []
    for (const player of snapshot.players || []) {
      if (player.id === this.localPlayerId && this.predictionEnabled) {
        displayPlayers.push(player)
        continue
      }
      const filter = this.playerFilters.get(player.id)
      if (filter && dt > 0) {
        const predicted = filter.predict(dt)
        displayPlayers.push({ ...player, position: predicted.position, velocity: predicted.velocity })
      } else {
        displayPlayers.push(player)
      }
    }

    const displayEntities = []
    for (const entity of snapshot.entities || []) {
      const filter = this.entityFilters.get(entity.id)
      if (filter && dt > 0) {
        const predicted = filter.predict(dt)
        displayEntities.push({ ...entity, position: predicted.position })
      } else {
        displayEntities.push(entity)
      }
    }

    return { players: displayPlayers, entities: displayEntities }
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
