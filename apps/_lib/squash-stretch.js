// computeSquashStretchScale(impactSpeed, elapsedMs, opts) -> [sx, sy, sz]; createSquashStretch(mesh, opts) ->
// stateful per-mesh driver. Cheap client-side visual "juice", NOT a soft-body simulation: on impact
// (a sudden drop in an entity's velocity magnitude -- a collision signature, not a server event) the mesh
// scales non-uniformly (flattened along the impact axis, bulged on the other two, volume-preserving-ish)
// then springs back to identity over time. Generalized from a prior prototype (jello-royale, deleted) that
// hardcoded this same mesh.scale distortion per-game; this makes it reusable by any client app driving a
// three.js mesh (GLTF, primitive, ModelPool root) off per-frame position/velocity snapshot data.
//
// Usage (pure core, no dependencies):
//   const scale = computeSquashStretchScale(impactSpeed, elapsedMs, opts)  // -> [sx, sy, sz]
//   mesh.scale.set(...scale)
//
// Usage (stateful driver, owns its own clock + impact-detection):
//   const squash = createSquashStretch(mesh, { axis: 'y', strength: 0.4, durationMs: 350 })
//   squash.onVelocity(velocity, nowMs)  // call every time a fresh velocity sample arrives (e.g. per snapshot)
//   squash.update(nowMs)                // call every render frame; writes mesh.scale
//   squash.trigger(impactSpeed, nowMs)  // or drive it directly if the impact speed is already known
//   squash.reset()

function _clampNonNeg(v, fallback) {
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

// Decaying-oscillation envelope, 0 at t=0 (peak distortion) and 0 at/after t=durationMs (fully settled),
// with one visible overshoot past identity (the "jello" wobble) before it dies out. Pure function of
// elapsedMs alone, matching game-fsm.js's own "pure function of ctx-free inputs" testable-core shape.
function _envelope(elapsedMs, durationMs) {
  if (durationMs <= 0) return 0
  const t = elapsedMs / durationMs
  if (t >= 1) return 0
  // damped cosine: decays from 1 to 0 across [0,1], oscillating (wobble) at frequency `cycles`
  const cycles = 2.2
  const decay = Math.pow(1 - t, 2)
  return decay * Math.cos(t * Math.PI * 2 * cycles)
}

// impactSpeed: m/s magnitude of the velocity change at the moment of impact (>= 0; NaN/negative clamp to 0).
// elapsedMs: ms since that impact (>= 0; values >= opts.durationMs return identity scale [1,1,1]).
// opts: { axis?: 'x'|'y'|'z' (default 'y', the squash axis), strength?: number (default 0.5, distortion per
//   m/s of impact speed, clamped below), maxStrength?: number (default 0.6, hard cap on peak distortion so
//   an extreme impact can't invert/degenerate the mesh), durationMs?: number (default 350) }
// Returns [sx, sy, sz] uniform-elsewhere scale: the squash axis compresses, the other two bulge, so the
// distortion is volume-preserving-ish (never exact, cheap approximation only) rather than a flat squish.
export function computeSquashStretchScale(impactSpeed, elapsedMs, opts = {}) {
  const axis = opts.axis === 'x' || opts.axis === 'z' ? opts.axis : 'y'
  const strength = _clampNonNeg(opts.strength, 0.5)
  const maxStrength = _clampNonNeg(opts.maxStrength, 0.6)
  const durationMs = _clampNonNeg(opts.durationMs, 350)

  const speed = Number.isFinite(impactSpeed) && impactSpeed > 0 ? impactSpeed : 0
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0

  const rawMag = speed * strength * 0.1
  const mag = Math.min(rawMag, maxStrength) * _envelope(t, durationMs)

  // squash axis: 1 - mag (compress on impact, then oscillate back through 1 toward overshoot-stretch)
  // other two axes: 1 + mag*0.5 each (bulge), so total volume change is damped relative to a naive squash
  const squash = 1 - mag
  const bulge = 1 + mag * 0.5

  return axis === 'x' ? [squash, bulge, bulge]
       : axis === 'z' ? [bulge, bulge, squash]
       : [bulge, squash, bulge]
}

// Stateful driver wrapping the pure function above around a live three.js-like mesh (any object exposing
// .scale.set(x,y,z) -- three.js Object3D/Mesh/Group, or a ModelPool proxy root satisfy this duck type).
// opts is forwarded to computeSquashStretchScale on every trigger; impactThreshold (default 1.5 m/s) gates
// onVelocity's auto-detection so small resting jitter never fires a squash.
export function createSquashStretch(mesh, opts = {}) {
  if (!mesh || typeof mesh !== 'object' || !mesh.scale || typeof mesh.scale.set !== 'function') {
    throw new TypeError('[squash-stretch] mesh must be an object exposing scale.set(x,y,z)')
  }
  const impactThreshold = _clampNonNeg(opts.impactThreshold, 1.5)

  let _impactSpeed = 0
  let _impactAtMs = -Infinity
  let _lastSpeed = 0
  let _active = false

  function _now() { return typeof performance !== 'undefined' ? performance.now() : Date.now() }

  return {
    get active() { return _active },

    // Explicit trigger: call with the impact speed (m/s) directly, e.g. from a known collision event.
    trigger(impactSpeed, nowMs) {
      const speed = Number.isFinite(impactSpeed) && impactSpeed > 0 ? impactSpeed : 0
      if (speed <= 0) return
      _impactSpeed = speed
      _impactAtMs = Number.isFinite(nowMs) ? nowMs : _now()
      _active = true
    },

    // Auto-detection: feed every fresh velocity sample (e.g. from a decoded snapshot's entity.velocity).
    // Fires trigger() when speed drops by more than impactThreshold between two consecutive samples --
    // the same "sudden deceleration = impact" signature the deleted jello-royale prototype used.
    onVelocity(velocity, nowMs) {
      const vx = velocity?.[0] || 0, vy = velocity?.[1] || 0, vz = velocity?.[2] || 0
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const drop = _lastSpeed - speed
      if (drop > impactThreshold) this.trigger(drop, nowMs)
      _lastSpeed = speed
    },

    // Call once per render frame; writes mesh.scale. Returns the scale array applied (or null if idle,
    // scale left untouched at whatever it already was -- callers driving non-squash scale elsewhere are
    // not clobbered on idle frames).
    update(nowMs) {
      if (!_active) return null
      const t = (Number.isFinite(nowMs) ? nowMs : _now()) - _impactAtMs
      const durationMs = _clampNonNeg(opts.durationMs, 350)
      if (t >= durationMs) { _active = false; mesh.scale.set(1, 1, 1); return [1, 1, 1] }
      const scale = computeSquashStretchScale(_impactSpeed, t, opts)
      mesh.scale.set(scale[0], scale[1], scale[2])
      return scale
    },

    reset() {
      _active = false
      _impactSpeed = 0
      _impactAtMs = -Infinity
      _lastSpeed = 0
      mesh.scale.set(1, 1, 1)
    }
  }
}

export default createSquashStretch
