function refusal(code, message) {
  const err = new TypeError(`[vec3] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function readVec3(value, name = 'value') {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw refusal('vec3-invalid', `${name} must be an array of three finite numbers`)
  }
  return value
}

export function add(a, b) {
  readVec3(a, 'a'); readVec3(b, 'b')
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function sub(a, b) {
  readVec3(a, 'a'); readVec3(b, 'b')
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function scale(a, k) {
  readVec3(a, 'a')
  if (!Number.isFinite(k)) throw refusal('vec3-scale-invalid', 'scale must be finite')
  return [a[0] * k, a[1] * k, a[2] * k]
}

export function dot(a, b) {
  readVec3(a, 'a'); readVec3(b, 'b')
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function cross(a, b) {
  readVec3(a, 'a'); readVec3(b, 'b')
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function lengthSq(a) { return dot(a, a) }

export function length(a) { return Math.sqrt(lengthSq(a)) }

export function distance(a, b) { return length(sub(a, b)) }

export function normalize(a) {
  const len = length(a)
  if (len === 0) throw refusal('vec3-zero-length', 'cannot normalize a zero vector')
  return scale(a, 1 / len)
}

export function lerp(a, b, t) {
  readVec3(a, 'a'); readVec3(b, 'b')
  if (!Number.isFinite(t) || t < 0 || t > 1) throw refusal('vec3-t-invalid', 't must be a finite number in [0,1]')
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function clampLength(a, max) {
  const len = length(a)
  if (!Number.isFinite(max) || max < 0) throw refusal('vec3-max-invalid', 'max must be a non-negative finite number')
  if (len <= max || len === 0) return a.slice()
  return scale(a, max / len)
}

export function reflect(a, normal) {
  const n = normalize(normal)
  return sub(a, scale(n, 2 * dot(a, n)))
}

export function angleTo(a, b) {
  const denom = length(a) * length(b)
  if (denom === 0) throw refusal('vec3-zero-length', 'angle needs two non-zero vectors')
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / denom)))
}
