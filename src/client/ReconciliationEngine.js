const DEFAULT_TELEPORT_THRESHOLD_GROUNDED = 5.0
const DEFAULT_TELEPORT_THRESHOLD_AIRBORNE = 8.0
const DEFAULT_SMOOTHING_TIME_CONSTANT_S = 0.08
const SETTLE_EPSILON_M = 0.002
const MAX_DECAY_STEP_S = 0.1

export class ReconciliationEngine {
  constructor(config = {}) {
    this.timeConstantS = config.timeConstantS ?? DEFAULT_SMOOTHING_TIME_CONSTANT_S
    this.groundedTeleportThreshold = config.groundedTeleportThreshold ?? config.teleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_GROUNDED
    this.airborneTeleportThreshold = config.airborneTeleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_AIRBORNE
    this.errorOffset = [0, 0, 0]
    this._lastDecayMs = 0
  }

  get teleportThreshold() { return this.groundedTeleportThreshold }

  teleportThresholdFor(onGround) {
    return onGround ? this.groundedTeleportThreshold : this.airborneTeleportThreshold
  }

  absorb(dx, dy, dz, onGround) {
    const o = this.errorOffset
    o[0] += dx; o[1] += dy; o[2] += dz
    if (Math.hypot(o[0], o[1], o[2]) >= this.teleportThresholdFor(onGround)) this.reset()
  }

  decay(nowMs) {
    const o = this.errorOffset
    const dt = this._lastDecayMs ? Math.min(MAX_DECAY_STEP_S, Math.max(0, (nowMs - this._lastDecayMs) / 1000)) : 0
    this._lastDecayMs = nowMs
    if (o[0] === 0 && o[1] === 0 && o[2] === 0) return o
    const keep = Math.exp(-dt / this.timeConstantS)
    o[0] *= keep; o[1] *= keep; o[2] *= keep
    if (o[0] * o[0] + o[1] * o[1] + o[2] * o[2] < SETTLE_EPSILON_M * SETTLE_EPSILON_M) { o[0] = 0; o[1] = 0; o[2] = 0 }
    return o
  }

  getErrorOffset() { return this.errorOffset }

  reset() {
    this.errorOffset[0] = 0; this.errorOffset[1] = 0; this.errorOffset[2] = 0
  }
}
