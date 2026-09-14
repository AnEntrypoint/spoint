function _clampNonNeg(v, fallback) {
  return Number.isFinite(v) && v >= 0 ? v : fallback
}

function _envelope(elapsedMs, durationMs) {
  if (durationMs <= 0) return 0
  const t = elapsedMs / durationMs
  if (t >= 1) return 0
  const wobbleCycles = 2.2
  const decay = Math.pow(1 - t, 2)
  return decay * Math.cos(t * Math.PI * 2 * wobbleCycles)
}

export function computeSquashStretchScale(impactSpeed, elapsedMs, opts = {}) {
  const axis = opts.axis === 'x' || opts.axis === 'z' ? opts.axis : 'y'
  const strength = _clampNonNeg(opts.strength, 0.5)
  const maxStrength = _clampNonNeg(opts.maxStrength, 0.6)
  const durationMs = _clampNonNeg(opts.durationMs, 350)

  const speed = Number.isFinite(impactSpeed) && impactSpeed > 0 ? impactSpeed : 0
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0

  const rawMag = speed * strength * 0.1
  const mag = Math.min(rawMag, maxStrength) * _envelope(t, durationMs)

  const squash = 1 - mag
  const bulge = 1 + mag * 0.5

  return axis === 'x' ? [squash, bulge, bulge]
       : axis === 'z' ? [bulge, bulge, squash]
       : [bulge, squash, bulge]
}

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

    trigger(impactSpeed, nowMs) {
      const speed = Number.isFinite(impactSpeed) && impactSpeed > 0 ? impactSpeed : 0
      if (speed <= 0) return
      _impactSpeed = speed
      _impactAtMs = Number.isFinite(nowMs) ? nowMs : _now()
      _active = true
    },

    onVelocity(velocity, nowMs) {
      const vx = velocity?.[0] || 0, vy = velocity?.[1] || 0, vz = velocity?.[2] || 0
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz)
      const speedDrop = _lastSpeed - speed
      if (speedDrop > impactThreshold) this.trigger(speedDrop, nowMs)
      _lastSpeed = speed
    },

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
