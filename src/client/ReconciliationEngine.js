import { slerpQuat } from './interpolation.js'

// beyond this divergence (m) the client hard-snaps instead of smoothing, while GROUNDED.
// Grounded divergence is the more suspicious case (no legitimate reason for the predicted and
// server position to differ by much while walking on a surface), so this stays tight.
const DEFAULT_TELEPORT_THRESHOLD_GROUNDED = 5.0

// beyond this divergence (m) the client hard-snaps instead of smoothing, while AIRBORNE.
// Airborne divergence legitimately runs larger: falling under gravity, knockback impulses, and
// server-vs-client integration drift over multiple unacked ticks all inflate it without indicating
// a real desync, so the airborne band is wider to avoid snapping mid-jump/mid-fall.
const DEFAULT_TELEPORT_THRESHOLD_AIRBORNE = 8.0

// per-frame fraction of residual POSITION render error bled off; only the DISPLAYED position
// smooths, predicted state always corrects immediately.
const DEFAULT_POSITION_SMOOTHING = 0.18

// per-frame fraction of residual ROTATION render error bled off (slerp t per decay() call).
// Rotation correction is kept snappier than position: a stale-looking aim/facing direction reads
// as much more "wrong" to the eye than a few centimeters of positional smear at the same
// correction magnitude, so this settles in fewer frames than position at the same input divergence.
const DEFAULT_ROTATION_SMOOTHING = 0.35

// below this residual (m) the position offset zeroes instead of decaying forever
const SETTLE_EPSILON = 0.01

// below this residual (dot-product-from-1) the rotation glide snaps to the target instead of
// decaying forever (quaternions never reach bit-exact equality via repeated slerp)
const ROTATION_SETTLE_EPSILON = 0.0005

// below this divergence (m), reconcile() reports no correction (float noise); must stay well below
// the smaller (grounded) teleport threshold or the glide path never runs
const CORRECTION_EPSILON = 0.02

export class ReconciliationEngine {
  constructor(config = {}) {
    // back-compat: a bare `smoothing`/`teleportThreshold` config key still applies to position only
    this.positionSmoothing = config.positionSmoothing ?? config.smoothing ?? DEFAULT_POSITION_SMOOTHING
    this.rotationSmoothing = config.rotationSmoothing ?? DEFAULT_ROTATION_SMOOTHING
    this.groundedTeleportThreshold = config.groundedTeleportThreshold ?? config.teleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_GROUNDED
    this.airborneTeleportThreshold = config.airborneTeleportThreshold ?? DEFAULT_TELEPORT_THRESHOLD_AIRBORNE
    // displayedPosition = predictedPosition - errorOffset; decays to zero over time
    this.errorOffset = [0, 0, 0]
    // displayedRotation glides toward localState.rotation each decay() call; null until the first
    // correction establishes a starting point (getRenderState falls back to localState.rotation
    // directly when null, i.e. no glide in progress)
    this.renderRotation = null
  }

  // teleportThreshold accessor kept for back-compat call sites that only care about "the" threshold
  // (e.g. a UI readout) -- resolves to the grounded (tighter) band.
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

  // rejects a degenerate (NaN/wrong-length) server position so it can't poison the offset or predicted state
  applyCorrection(localState, serverState) {
    const sp = serverState.position
    if (!sp || sp.length < 3 || !Number.isFinite(sp[0]) || !Number.isFinite(sp[1]) || !Number.isFinite(sp[2])) return

    // onGround BEFORE the snap decides which teleport band this correction belongs to -- the
    // player's state going into the correction is what determines whether the divergence was
    // "expected" (airborne) or not (grounded), not the post-snap state the server just handed us.
    const onGround = localState.onGround
    const threshold = this.teleportThresholdFor(onGround)

    // preserve pre-snap display position so the new offset (oldDisplayed - newPredicted) is what decays, not a pop
    const beforeDisplayX = localState.position[0] - this.errorOffset[0]
    const beforeDisplayY = localState.position[1] - this.errorOffset[1]
    const beforeDisplayZ = localState.position[2] - this.errorOffset[2]

    // preserve pre-snap DISPLAYED rotation the same way, so the rotation glide starts from what's
    // actually on screen, not from a rotation that already silently jumped
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
      // hard teleport: clear the offset, don't glide-smear a large jump
      this.errorOffset[0] = 0; this.errorOffset[1] = 0; this.errorOffset[2] = 0
      // rotation snaps in lockstep with a position teleport -- a glide toward a rotation that
      // belongs to a position 5m+ away would visibly swim independent of the pop
      this.renderRotation = null
    } else {
      this.errorOffset[0] = dx; this.errorOffset[1] = dy; this.errorOffset[2] = dz
      this.renderRotation = beforeDisplayRot
    }
  }

  // call once per render frame (decoupled from snapshot rate); distributes both the positional and
  // rotational residual error over N frames, each smoothed by its OWN constant so a large rotation
  // snap-correction doesn't have to share (or be capped by) the position glide's settle time.
  decay() {
    const o = this.errorOffset
    const mag2 = o[0] * o[0] + o[1] * o[1] + o[2] * o[2]
    if (mag2 < SETTLE_EPSILON * SETTLE_EPSILON) {
      o[0] = 0; o[1] = 0; o[2] = 0
    } else {
      const keep = 1 - this.positionSmoothing
      // `+ 0` normalizes -0 so it doesn't leak into the render offset
      o[0] = o[0] * keep + 0; o[1] = o[1] * keep + 0; o[2] = o[2] * keep + 0
    }
    return o
  }

  // rotation glide is queried separately from decay() (position) since callers need the target
  // localState.rotation to slerp toward; returns the current DISPLAYED rotation (mutates in place),
  // or null if no glide is in progress (caller should use localState.rotation directly).
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
