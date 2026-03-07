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
    this._inputSeq = 0
    this.reconciliationEngine = new ReconciliationEngine()
    this.movement = { ...DEFAULT_MOVEMENT }
    this.gravityY = -9.81
  }

  setMovement(m) { Object.assign(this.movement, m) }

  setGravity(g) { if (g && g[1] != null) this.gravityY = g[1] }

  init(playerId, initialState = {}) {
    this.localPlayerId = playerId
    const pos = initialState.position || [0, 0, 0]
    const rot = initialState.rotation || [0, 0, 0, 1]
    const vel = initialState.velocity || [0, 0, 0]
    this.localState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health: initialState.health || 100 }
    this.lastServerState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health: initialState.health || 100 }
  }

  addInput(input) {
    const seq = this._inputSeq++
    this.inputHistory.push({ sequence: seq, data: input })
    if (this.inputHistory.length > 256) this.inputHistory.shift()
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
    const dt = (this.tickDuration / 1000) * ticksAhead
    const s = this.localState, v = s.velocity
    if (!this._extrapolated) this._extrapolated = { id: null, position: [0,0,0], rotation: [0,0,0,1], velocity: [0,0,0], onGround: false, health: 0 }
    this._copyState(s, this._extrapolated)
    const p = this._extrapolated.position
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt
    return this._extrapolated
  }

  _copyState(src, dst) {
    dst.id = src.id; dst.onGround = src.onGround; dst.health = src.health; dst.inputSequence = src.inputSequence
    const sp = src.position, dp = dst.position; dp[0] = sp[0]; dp[1] = sp[1]; dp[2] = sp[2]
    const sr = src.rotation, dr = dst.rotation; dr[0] = sr[0]; dr[1] = sr[1]; dr[2] = sr[2]; dr[3] = sr[3]
    const sv = src.velocity, dv = dst.velocity; dv[0] = sv[0]; dv[1] = sv[1]; dv[2] = sv[2]
  }

  onServerSnapshot(snapshot, tick) {
    for (const serverPlayer of snapshot.players) {
      if (serverPlayer.id === this.localPlayerId) {
        this._copyState(serverPlayer, this.lastServerState)
        const ackedSeq = serverPlayer.inputSequence ?? -1
        if (ackedSeq >= 0) {
          while (this.inputHistory.length > 0 && this.inputHistory[0].sequence <= ackedSeq) {
            this.inputHistory.shift()
          }
        }
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
    this._copyState(this.lastServerState, this.localState)
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
