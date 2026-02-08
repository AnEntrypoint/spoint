import { ReconciliationEngine } from './ReconciliationEngine.js'
import { applyMovement, DEFAULT_MOVEMENT } from '../shared/movement.js'

export class PredictionEngine {
  constructor(tickRate = 128) {
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this.localPlayerId = null
    this.localState = null
    this.lastServerState = null
    this.inputHistory = []
    this.reconciliationEngine = new ReconciliationEngine()
    this.movement = { ...DEFAULT_MOVEMENT }
    this.gravityY = -9.81
  }

  setMovement(m) { Object.assign(this.movement, m) }

  setGravity(g) { if (g && g[1] != null) this.gravityY = g[1] }

  init(playerId, initialState = {}) {
    this.localPlayerId = playerId
    this.localState = {
      id: playerId,
      position: initialState.position || [0, 0, 0],
      rotation: initialState.rotation || [0, 0, 0, 1],
      velocity: initialState.velocity || [0, 0, 0],
      onGround: true,
      health: initialState.health || 100
    }
    this.lastServerState = JSON.parse(JSON.stringify(this.localState))
  }

  addInput(input) {
    this.inputHistory.push({
      sequence: this.inputHistory.length,
      data: input,
      timestamp: Date.now()
    })
    if (this.inputHistory.length > 128) {
      this.inputHistory.shift()
    }
    this.predict(input)
  }

  predict(input) {
    const dt = this.tickDuration / 1000
    const state = this.localState
    applyMovement(state, input, this.movement, dt)
    state.velocity[1] += this.gravityY * dt
    state.position[0] += state.velocity[0] * dt
    state.position[1] += state.velocity[1] * dt
    state.position[2] += state.velocity[2] * dt
    if (state.position[1] < 0) {
      state.position[1] = 0
      state.velocity[1] = 0
      state.onGround = true
    }
  }

  interpolate(factor) {
    if (!this.lastServerState || !this.localState) return this.localState
    return {
      id: this.localState.id,
      position: [
        this.lastServerState.position[0] + (this.localState.position[0] - this.lastServerState.position[0]) * factor,
        this.lastServerState.position[1] + (this.localState.position[1] - this.lastServerState.position[1]) * factor,
        this.lastServerState.position[2] + (this.localState.position[2] - this.lastServerState.position[2]) * factor
      ],
      rotation: this.localState.rotation,
      velocity: this.localState.velocity,
      health: this.localState.health,
      onGround: this.localState.onGround
    }
  }

  extrapolate(ticksAhead = 1) {
    const extrapolated = JSON.parse(JSON.stringify(this.localState))
    const dt = (this.tickDuration / 1000) * ticksAhead
    extrapolated.position[0] += this.localState.velocity[0] * dt
    extrapolated.position[1] += this.localState.velocity[1] * dt
    extrapolated.position[2] += this.localState.velocity[2] * dt
    return extrapolated
  }

  onServerSnapshot(snapshot, tick) {
    for (const serverPlayer of snapshot.players) {
      if (serverPlayer.id === this.localPlayerId) {
        this.lastServerState = JSON.parse(JSON.stringify(serverPlayer))
        const reconciliation = this.reconciliationEngine.reconcile(
          this.lastServerState, this.localState, tick
        )
        if (reconciliation.needsCorrection) {
          this.reconciliationEngine.applyCorrection(this.localState, reconciliation.correction)
          this.resimulate()
        }
      }
    }
  }

  resimulate() {
    const baseState = JSON.parse(JSON.stringify(this.lastServerState))
    this.localState = baseState
    for (const input of this.inputHistory) {
      this.predict(input.data)
    }
  }

  getDisplayState(tick, ticksSinceLastSnapshot) {
    const alpha = (ticksSinceLastSnapshot % 1) / 1
    return this.interpolate(alpha)
  }

  getInputHistory() { return this.inputHistory }

  calculateDivergence() {
    if (!this.lastServerState || !this.localState) return 0
    const dx = this.localState.position[0] - this.lastServerState.position[0]
    const dy = this.localState.position[1] - this.lastServerState.position[1]
    const dz = this.localState.position[2] - this.lastServerState.position[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
}
