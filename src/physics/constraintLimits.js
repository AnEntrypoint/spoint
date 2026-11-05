const PI = Math.PI
const LIMP_CONE = PI

export class ConstraintLimitError extends Error {
  constructor(reasonCode, field) {
    super(`[constraint-limits] ${reasonCode}: ${field}`)
    this.name = 'ConstraintLimitError'
    this.reasonCode = reasonCode
    this.field = field
  }
}

function finiteIn(value, field, lo, hi) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
    throw new ConstraintLimitError('angle-out-of-range', field)
  }
  return value
}

function coneHalfAngle(limits) {
  return limits.cone === undefined ? LIMP_CONE : finiteIn(limits.cone, 'cone', 0, PI)
}

function twistRange(limits) {
  if (limits.twist === undefined) return [-PI, PI]
  const twist = limits.twist
  if (!Array.isArray(twist) || twist.length !== 2) throw new ConstraintLimitError('twist-not-pair', 'twist')
  const min = finiteIn(twist[0], 'twist', -PI, PI)
  const max = finiteIn(twist[1], 'twist', -PI, PI)
  if (min > max) throw new ConstraintLimitError('twist-inverted', 'twist')
  return [min, max]
}

function softSpring(softness) {
  if (softness === undefined || softness === null) return null
  const { frequency, damping } = softness
  if (typeof frequency !== 'number' || !(frequency > 0) || !Number.isFinite(frequency)) {
    throw new ConstraintLimitError('softness-frequency', 'softness.frequency')
  }
  if (typeof damping !== 'number' || !(damping >= 0) || !Number.isFinite(damping)) {
    throw new ConstraintLimitError('softness-damping', 'softness.damping')
  }
  return { frequency, damping }
}

export function swingTwistLimits(limits = {}, softness = null) {
  const cone = coneHalfAngle(limits)
  const [twistMin, twistMax] = twistRange(limits)
  return { cone, twistMin, twistMax, spring: softSpring(softness) }
}

export function hingeLimits(limits = {}, softness = null) {
  const min = limits.min === undefined ? -PI : finiteIn(limits.min, 'min', -PI, PI)
  const max = limits.max === undefined ? PI : finiteIn(limits.max, 'max', -PI, PI)
  if (min > max) throw new ConstraintLimitError('hinge-inverted', 'max')
  return { min, max, spring: softSpring(softness) }
}
