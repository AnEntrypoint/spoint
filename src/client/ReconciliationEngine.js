export class ReconciliationEngine {
  constructor(config = {}) {
    this.correctionThreshold = config.correctionThreshold || 0.5
    this._pending = null
  }

  reconcile(serverState, localState, tick) {
    const divergence = this.calculateDivergence(serverState, localState)
    if (divergence < this.correctionThreshold) {
      return { needsCorrection: false, divergence }
    }
    this._pending = { serverState, divergence }
    return { needsCorrection: true, correction: null, divergence }
  }

  calculateDivergence(serverState, localState) {
    if (!serverState || !localState) return 0
    const dx = serverState.position[0] - localState.position[0]
    const dy = serverState.position[1] - localState.position[1]
    const dz = serverState.position[2] - localState.position[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  applyCorrection(localState, _correction) {
    if (!this._pending) return
    const s = this._pending.serverState
    const alpha = Math.min(1, this._pending.divergence / 3.0)
    localState.position[0] = localState.position[0] + (s.position[0] - localState.position[0]) * alpha
    localState.position[1] = localState.position[1] + (s.position[1] - localState.position[1]) * alpha
    localState.position[2] = localState.position[2] + (s.position[2] - localState.position[2]) * alpha
    localState.velocity[0] = s.velocity[0]
    localState.velocity[1] = s.velocity[1]
    localState.velocity[2] = s.velocity[2]
    localState.onGround = s.onGround
    this._pending = null
  }
}
