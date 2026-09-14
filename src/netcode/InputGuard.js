const INPUT_BUCKET_CAPACITY = 120
const INPUT_BUCKET_REFILL_PER_SEC = 90
const _inputBuckets = new Map()

export function isInputRateLimited(clientId) {
  const now = Date.now()
  let b = _inputBuckets.get(clientId)
  if (!b) { b = { tokens: INPUT_BUCKET_CAPACITY, lastRefillMs: now, droppedSinceLog: 0, totalDropped: 0 }; _inputBuckets.set(clientId, b) }
  const elapsedSec = (now - b.lastRefillMs) / 1000
  if (elapsedSec > 0) {
    b.tokens = Math.min(INPUT_BUCKET_CAPACITY, b.tokens + elapsedSec * INPUT_BUCKET_REFILL_PER_SEC)
    b.lastRefillMs = now
  }
  if (b.tokens < 1) { b.droppedSinceLog++; b.totalDropped++; return true }
  b.tokens -= 1
  return false
}

export function clearInputBucket(clientId) {
  _inputBuckets.delete(clientId)
}

export function inputGuardStats() {
  const out = []
  for (const [clientId, b] of _inputBuckets) {
    if (b.totalDropped > 0) out.push({ clientId, tokensRemaining: Math.round(b.tokens * 10) / 10, droppedSinceLog: b.droppedSinceLog, totalDropped: b.totalDropped })
  }
  return out
}

const NUMERIC_INPUT_FIELDS = ['yaw', 'pitch', 'analogForward', 'analogRight']
const MAX_ABS_ANGLE = 1e6

export function sanitizeInputPayload(input) {
  if (!input || typeof input !== 'object') return input
  for (const field of NUMERIC_INPUT_FIELDS) {
    const v = input[field]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_ABS_ANGLE) input[field] = 0
  }
  return input
}

const ENVELOPE_HEADROOM_MULT = 3
const ENVELOPE_MIN_CAP = 20

export function envelopeSpeedCap(movement) {
  const candidates = [movement?.maxSpeed, movement?.sprintSpeed, movement?.airSpeedCap, movement?.slideMinSpeed]
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
  const base = candidates.length ? Math.max(...candidates) : ENVELOPE_MIN_CAP
  return Math.max(ENVELOPE_MIN_CAP, base * ENVELOPE_HEADROOM_MULT)
}

export function enforceMovementEnvelope(state, movement) {
  const v = state.velocity
  if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return false
  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  const cap = envelopeSpeedCap(movement)
  if (speed <= cap) return false
  const scale = cap / speed
  v[0] *= scale; v[1] *= scale; v[2] *= scale
  return true
}
