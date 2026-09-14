import { slerpQuat } from './interpolation.js'

const DEFAULT_TELEPORT_THRESHOLD_GROUNDED = 5.0

const DEFAULT_TELEPORT_THRESHOLD_AIRBORNE = 8.0

const DEFAULT_POSITION_SMOOTHING = 0.18

const DEFAULT_ROTATION_SMOOTHING = 0.35

const SETTLE_EPSILON = 0.01

const ROTATION_SETTLE_EPSILON = 0.0005

const CORRECTION_EPSILON = 0.02

export class ReconciliationEngine {
  constructor(config = {}) {
    this.positionSmoothing = config.positionSmoothing ?? config.smoothing ?? DEFAULT_POSITION_SMOOTHING
    this.rotationSmoothing = config.rotationSmoothing ?? DEFAULT_ROTATION_SMOOTHING
    this.groundedTeleportThreshold = config.groundedTeleportThreshold ?? config.teleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_GROUNDED
    this.airborneTeleportThreshold = config.airborneTeleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_AIRBORNE
    this.errorOffset = [0, 0, 0]
    this.renderRotation = null
  }

  get teleportThreshold() { return this.groundedTeleportThreshold }

  teleportThresholdFor(onGround) {
    return onGround ? this.groundedTeleportThreshold : this.airborneTeleportThreshold
  }

  reconcile(serverState, localState, tick) {
    const divergence = this.calculateDivergence(serverState, localState)
    if (divergence < CORRECTION_EPSILON) {
      return { needsCorrection: false, divergence }
    }
    const onGround = localState ? localState.onGround : true
    const threshold = this.teleportThresholdFor(onGround)
    return { needsCorrection: true, correction: serverState, divergence, teleport: divergence >= threshold }
  }

  calculateDivergence(serverState, localState) {
    if (!serverState || !localState) return 0
    const dx = serverState.position[0] - localState.position[0]
    const dy = serverState.position[1] - localState.position[1]
    const dz = serverState.position[2] - localState.position[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  applyCorrection(localState, serverState) {
    const sp = serverState.position
    if (!sp || sp.length < 3 || !Number.isFinite(sp[0]) || !Number.isFinite(sp[1]) || !Number.isFinite(sp[2])) return

    const onGround = localState.onGround
    const threshold = this.teleportThresholdFor(onGround)

    const beforeDisplayX = localState.position[0] - this.errorOffset[0]
    const beforeDisplayY = localState.position[1] - this.errorOffset[1]
    const beforeDisplayZ = localState.position[2] - this.errorOffset[2]

    const beforeDisplayRot = this.renderRotation
      ? [this.renderRotation[0], this.renderRotation[1], this.renderRotation[2], this.renderRotation[3]]
      : (localState.rotation ? [localState.rotation[0], localState.rotation[1], localState.rotation[2], localState.rotation[3]] : null)

    localState.position[0] = sp[0]
    localState.position[1] = sp[1]
    localState.position[2] = sp[2]
    if (serverState.velocity) {
      localState.velocity[0] = serverState.velocity[0]
      localState.velocity[1] = serverState.velocity[1]
      localState.velocity[2] = serverState.velocity[2]
    }
    if (serverState.rotation && localState.rotation && serverState.rotation.length === 4) {
      localState.rotation[0] = serverState.rotation[0]
      localState.rotation[1] = serverState.rotation[1]
      localState.rotation[2] = serverState.rotation[2]
      localState.rotation[3] = serverState.rotation[3]
    }
    localState.onGround = serverState.onGround

    const dx = beforeDisplayX - localState.position[0]
    const dy = beforeDisplayY - localState.position[1]
    const dz = beforeDisplayZ - localState.position[2]
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz)

    if (mag >= threshold) {
      this.errorOffset[0] = 0; this.errorOffset[1] = 0; this.errorOffset[2] = 0
      this.renderRotation = null
    } else {
      this.errorOffset[0] = dx; this.errorOffset[1] = dy; this.errorOffset[2] = dz
      this.renderRotation = beforeDisplayRot
    }
  }

  decay() {
    const o = this.errorOffset
    const mag2 = o[0] * o[0] + o[1] * o[1] + o[2] * o[2]
    if (mag2 < SETTLE_EPSILON * SETTLE_EPSILON) {
      o[0] = 0; o[1] = 0; o[2] = 0
    } else {
      const keep = 1 - this.positionSmoothing
      o[0] = o[0] * keep + 0; o[1] = o[1] * keep + 0; o[2] = o[2] * keep + 0
    }
    return o
  }

  decayRotation(targetRotation) {
    if (!this.renderRotation || !targetRotation) { this.renderRotation = null; return null }
    const r = this.renderRotation
    const dot = Math.abs(r[0] * targetRotation[0] + r[1] * targetRotation[1] + r[2] * targetRotation[2] + r[3] * targetRotation[3])
    if (dot > 1 - ROTATION_SETTLE_EPSILON) {
      this.renderRotation = null
      return null
    }
    slerpQuat(r, r, targetRotation, this.rotationSmoothing)
    return r
  }

  getErrorOffset() { return this.errorOffset }
  getRenderRotation() { return this.renderRotation }

  reset() {
    this.errorOffset[0] = 0; this.errorOffset[1] = 0; this.errorOffset[2] = 0
    this.renderRotation = null
  }
}
