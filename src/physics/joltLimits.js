export const JOLT_RESERVATION_FIXED_BYTES = 10645288
export const JOLT_BYTES_PER_BODY = 33
export const JOLT_BYTES_PER_BODY_PAIR = 88
export const JOLT_BYTES_PER_CONTACT_CONSTRAINT = 336

export const DEFAULT_JOLT_LIMITS = Object.freeze({ maxBodies: 10240, maxBodyPairs: 65536, maxContactConstraints: 10240 })

const LIMIT_KEYS = ['maxBodies', 'maxBodyPairs', 'maxContactConstraints']

export class JoltLimitsError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'JoltLimitsError'
    this.code = code
  }
}

export function joltReservationBytes(limits) {
  return JOLT_RESERVATION_FIXED_BYTES
    + JOLT_BYTES_PER_BODY * limits.maxBodies
    + JOLT_BYTES_PER_BODY_PAIR * limits.maxBodyPairs
    + JOLT_BYTES_PER_CONTACT_CONSTRAINT * limits.maxContactConstraints
}

export function resolveJoltLimits(spec, fallback = null) {
  const source = spec ?? fallback
  if (!source) return null
  const out = {}
  for (const key of LIMIT_KEYS) {
    const value = source[key]
    if (!Number.isInteger(value) || value < 1) throw new JoltLimitsError('jolt-limits-invalid', `${key} must be a positive integer, got ${value}`)
    out[key] = value
  }
  return out
}
