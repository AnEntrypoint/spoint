import { KalmanFilter3D, SmoothStateTracker } from './KalmanFilter.js'
import { JitterBuffer } from './JitterBuffer.js'

export class SmoothInterpolation {
  constructor(config = {}) {
    this.jitterBuffer = new JitterBuffer(config.jitter || {})
    this.playerFilters = new Map()
    this.entityFilters = new Map()
    this.kalmanConfig = config.kalman || {
      processNoise: 0.08,
      measurementNoise: 0.3,
      uncertainty: 0.5
    }
    
    this.lastFrameTime = Date.now()
    this.localPlayerId = null
    this.predictionEnabled = config.predictionEnabled !== false
    this.extrapolationLimit = config.extrapolationLimit || 100
  }
  
  setLocalPlayer(id) {
    this.localPlayerId = id
  }
  
  addSnapshot(snapshot) {
    this.jitterBuffer.addSnapshot(snapshot)
  }
  
  getDisplayState(now = Date.now()) {
    const snapshot = this.jitterBuffer.getSnapshotToRender(now)
    if (!snapshot) return { players: [], entities: [] }
    
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1)
    this.lastFrameTime = now
    
    const displayPlayers = []
    for (const player of snapshot.players || []) {
      if (player.id === this.localPlayerId && this.predictionEnabled) {
        displayPlayers.push(player)
        continue
      }
      
      const smoothed = this._smoothPlayer(player, dt)
      displayPlayers.push(smoothed)
    }
    
    const displayEntities = []
    for (const entity of snapshot.entities || []) {
      const smoothed = this._smoothEntity(entity, dt)
      displayEntities.push(smoothed)
    }
    
    return { players: displayPlayers, entities: displayEntities }
  }
  
  _smoothPlayer(player, dt) {
    let filter = this.playerFilters.get(player.id)
    if (!filter) {
      filter = new KalmanFilter3D(this.kalmanConfig)
      this.playerFilters.set(player.id, filter)
    }
    
    const state = filter.update(player.position, player.velocity)
    
    return {
      ...player,
      position: state.position,
      velocity: state.velocity
    }
  }
  
  _smoothEntity(entity, dt) {
    let filter = this.entityFilters.get(entity.id)
    if (!filter) {
      filter = new KalmanFilter3D(this.kalmanConfig)
      this.entityFilters.set(entity.id, filter)
    }
    
    const state = filter.update(entity.position)
    
    return {
      ...entity,
      position: state.position
    }
  }
  
  predictStep(dt) {
    for (const [id, filter] of this.playerFilters) {
      filter.predict(dt)
    }
    for (const [id, filter] of this.entityFilters) {
      filter.predict(dt)
    }
  }
  
  removePlayer(id) {
    this.playerFilters.delete(id)
  }
  
  removeEntity(id) {
    this.entityFilters.delete(id)
  }
  
  updateRTT(pingTime, pongTime) {
    this.jitterBuffer.updateRTT(pingTime, pongTime)
  }
  
  getRTT() {
    return this.jitterBuffer.getRTT()
  }
  
  getBufferHealth() {
    return this.jitterBuffer.getBufferHealth()
  }
  
  reset() {
    this.jitterBuffer.clear()
    this.playerFilters.clear()
    this.entityFilters.clear()
  }
  
  setConfig(config) {
    if (config.kalman) {
      this.kalmanConfig = { ...this.kalmanConfig, ...config.kalman }
    }
  }
}