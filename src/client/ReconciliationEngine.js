const TELEPORT_THRESHOLD = 5.0

export class ReconciliationEngine {
  constructor(config = {}) {}

  reconcile(serverState, localState, tick) {
    const divergence = this.calculateDivergence(serverState, localState)
    if (divergence < TELEPORT_THRESHOLD) {
      return { needsCorrection: false, divergence }
    }
    return { needsCorrection: true, correction: serverState, divergence }
  }

  calculateDivergence(serverState, localState) {
    if (!serverState || !localState) return 0
    const dx = serverState.position[0] - localState.position[0]
    const dy = serverState.position[1] - localState.position[1]
    const dz = serverState.position[2] - localState.position[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  applyCorrection(localState, serverState) {
    localState.position[0] = serverState.position[0]
    localState.position[1] = serverState.position[1]
    localState.position[2] = serverState.position[2]
    localState.velocity[0] = serverState.velocity[0]
    localState.velocity[1] = serverState.velocity[1]
    localState.velocity[2] = serverState.velocity[2]
    localState.onGround = serverState.onGround
  }
}
