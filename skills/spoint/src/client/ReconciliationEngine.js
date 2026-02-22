export class ReconciliationEngine {
  constructor(config = {}) {
    this.correctionThreshold = config.correctionThreshold || 0.01
    this.correctionSpeed = config.correctionSpeed || 0.5
    this.lastReconcileTime = 0
    this.reconcileInterval = config.reconcileInterval || 100
  }

  reconcile(serverState, localState, tick) {
    const now = Date.now()
    if (now - this.lastReconcileTime < this.reconcileInterval) {
      return { needsCorrection: false, correction: null }
    }

    this.lastReconcileTime = now

    const divergence = this.calculateDivergence(serverState, localState)

    if (divergence < this.correctionThreshold) {
      return { needsCorrection: false, divergence }
    }

    const correction = this.generateCorrection(serverState, localState)
    return { needsCorrection: true, correction, divergence }
  }

  calculateDivergence(serverState, localState) {
    if (!serverState || !localState) return 0

    const dx = serverState.position[0] - localState.position[0]
    const dy = serverState.position[1] - localState.position[1]
    const dz = serverState.position[2] - localState.position[2]

    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  generateCorrection(serverState, localState) {
    return {
      position: [
        serverState.position[0] * this.correctionSpeed + localState.position[0] * (1 - this.correctionSpeed),
        serverState.position[1] * this.correctionSpeed + localState.position[1] * (1 - this.correctionSpeed),
        serverState.position[2] * this.correctionSpeed + localState.position[2] * (1 - this.correctionSpeed)
      ],
      velocity: [...serverState.velocity],
      onGround: serverState.onGround
    }
  }

  applyCorrection(localState, correction) {
    localState.position = correction.position
    localState.velocity = correction.velocity
    localState.onGround = correction.onGround
  }
}
