// Server-side hardening for the PLAYER_INPUT/INPUT wire message -- the one channel a client fully
// controls the CONTENT of on every tick. Two concerns live here because they guard the exact same
// ingestion boundary (ServerHandlers.js's PLAYER_INPUT case, before playerManager.addInput ever
// stores the payload): (1) a per-connection token bucket capping how OFTEN a client may send input
// messages, catching a flood beyond the legitimate ~60/sec input-loop rate (client/app.js's
// startInputLoop, see project/sim-render-pacing-vsync-input-stamp); (2) sanitizing the numeric
// FIELDS of one input payload so a non-finite yaw/pitch/analog value can never reach movement.js or
// PhysicsIntegration.js's Jolt calls.
//
// (2) is a REAL, live-witnessed gap, not defensive paranoia: TickHandler.js's processPlayerMovement
// computes `st.rotation` directly from `inp.yaw` via Math.sin/cos(yaw/2) OUTSIDE applyMovement's own
// (accidentally NaN-safe, every accel step gates on `if (add > 0)` which is false for NaN) math --
// `yaw: Infinity` poisons st.rotation to [0,NaN,0,NaN] in-memory, cached across ticks via the
// _lastYaw dedupe (only recomputed when yaw changes), and threaded into
// lagCompensator.recordPlayerPosition every tick for that player. The wire ENCODE path
// (SnapshotEncoder.js's packQuat/pitchN/yawN math) already degrades a NaN input to a clamped 0
// harmlessly at the bit level, so this is not a decode-crash risk -- but the in-memory server state
// stays corrupted, which is the wrong end for an authoritative simulation to be wrong at.

// --- (1) Per-connection input rate limiter ---------------------------------------------------
// Mirrors ServerAPI.js's DEBUG_LOG_BUCKET_CAPACITY/REFILL_PER_SEC shape (a proven pattern already
// shipped in this codebase), sized for the real client cadence: startInputLoop samples at exactly
// 1000/60 via setInterval, and PhysicsNetworkClient.sendInput additionally piggybacks up to 4
// redundant unacked inputs INSIDE that same message (not as separate sends), so the on-wire message
// rate is 60/sec even under packet loss, never higher. Capacity/refill both sit comfortably above
// 60/sec to absorb setInterval jitter (a slow event-loop tick can legitimately double up two fires
// in quick succession) without ever throttling a real client; a bucket this size takes a sustained
// flood at multiples of the legitimate rate to actually drain.
const INPUT_BUCKET_CAPACITY = 120   // burst allowance, messages
const INPUT_BUCKET_REFILL_PER_SEC = 90 // steady-state cap, messages/sec (1.5x the real 60/sec loop)
const _inputBuckets = new Map() // clientId -> { tokens, lastRefillMs, droppedSinceLog }

// Returns true if this message should be DROPPED (rate limited). Mirrors debugLogRateLimited's
// token-bucket math exactly. Never disconnects on its own -- matches this codebase's existing
// discipline (debugLogRateLimited also just drops/429s, never tears down the connection) since a
// silently-dropped input is self-correcting (the client's own reconciliation/prediction just sees
// one fewer ack) whereas a disconnect on a single burst would punish a legitimate client caught in
// a scheduler hiccup. Sustained abuse still shows up in the dropped-count an operator can query via
// inputGuardStats().
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

// Called on disconnect/removePlayer so a churned clientId (numeric, reused by PlayerManager's
// nextPlayerId counter) never inherits a stale bucket -- without this, a long-lived server could
// have a NEW player at a recycled id start already-throttled from a PREVIOUS occupant's history,
// or (the actually-observable direction, since nextPlayerId only increments) just leak one Map
// entry per connection for the process lifetime.
export function clearInputBucket(clientId) {
  _inputBuckets.delete(clientId)
}

// Operator-facing visibility: which connections are actively being throttled right now, and how
// much has been dropped total. Read-only snapshot, no side effects (does not reset droppedSinceLog).
export function inputGuardStats() {
  const out = []
  for (const [clientId, b] of _inputBuckets) {
    if (b.totalDropped > 0) out.push({ clientId, tokensRemaining: Math.round(b.tokens * 10) / 10, droppedSinceLog: b.droppedSinceLog, totalDropped: b.totalDropped })
  }
  return out
}

// --- (2) Input payload sanitization -----------------------------------------------------------
// The exact set of numeric fields TickHandler.js/movement.js read off an input payload. Booleans
// (forward/backward/left/right/jump/sprint/crouch) are safe regardless of client-sent type --
// `if (input.forward)` truthy-coerces any garbage harmlessly -- so only the NUMERIC fields (used in
// trig/accel/normalization math that a non-finite value can poison) need validation.
const NUMERIC_INPUT_FIELDS = ['yaw', 'pitch', 'analogForward', 'analogRight']
// Rotation math (Math.sin/cos(yaw/2)) has no natural bound on a raw radian value the way a
// normalized analog stick does, but any real client only ever sends camera-derived yaw/pitch, which
// never exceeds a few multiples of 2*PI even across a long play session (InputHandler accumulates
// real mouse-delta radians, never wraps/clamps, but genuine human mouse motion cannot rack up
// thousands of radians). A generous finite bound catches "someone is calling the wire API directly
// with garbage" without ever clamping a real client's legitimate value.
const MAX_ABS_ANGLE = 1e6

// Sanitizes ONE input payload's numeric fields in place. Returns the same object for chaining.
// Non-finite (NaN/Infinity/-Infinity) or out-of-bound-magnitude values are replaced with 0 --
// silently, not by rejecting the whole input -- since a malicious/corrupt yaw shouldn't also
// invalidate that same tick's legitimate forward/jump booleans; degrading gracefully to "no
// rotation change this tick" is the safe-fail here, not dropping movement entirely.
export function sanitizeInputPayload(input) {
  if (!input || typeof input !== 'object') return input
  for (const field of NUMERIC_INPUT_FIELDS) {
    const v = input[field]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > MAX_ABS_ANGLE) input[field] = 0
  }
  return input
}

// --- (3) Movement envelope check ----------------------------------------------------------------
// A defense-in-depth speed clamp, independent of HOW an excess velocity could occur (today
// applyMovement's own accel-toward-wishSpeed math is already structurally bounded by
// movement.maxSpeed/sprintSpeed/airSpeedCap -- verified live, every accel step gates on `if (add >
// 0)` which NaN/garbage input can never satisfy -- so this exists as a second, independent layer
// against a FUTURE bug: a buggy app calling ctx.physics with a bad force, a Jolt-native edge case,
// or a not-yet-written movement variant that skips the existing caps). Ceiling is derived from the
// world's OWN configured movement caps (never a hardcoded absolute), with generous headroom so it
// never clips legitimate play: airSpeedCap already re-clamps every airborne tick (movement.js line
// ~120), slide boosts to at most maxSpeed*slideSpeedMul (~1.15x), and knockback impulses
// (hitKnockback/shootKnockback, both single-digit m/s ADDs in every shipped world) can stack a few
// consecutive hits before friction/airCap re-clamp -- ENVELOPE_HEADROOM_MULT=3 comfortably covers a
// worst-case stacked-knockback-during-a-slide burst without ever being reachable by normal input.
const ENVELOPE_HEADROOM_MULT = 3
const ENVELOPE_MIN_CAP = 20 // m/s -- floor for a world with a tiny/unset speed config, still generous

// Returns the per-axis-agnostic horizontal+vertical speed cap (m/s) this world's movement config
// implies a legitimate player could ever reach, with headroom. `movement` is the same resolved
// {...DEFAULT_MOVEMENT, ...worldOverrides} object TickHandler.js already threads through applyMovement.
export function envelopeSpeedCap(movement) {
  const candidates = [movement?.maxSpeed, movement?.sprintSpeed, movement?.airSpeedCap, movement?.slideMinSpeed]
    .filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
  const base = candidates.length ? Math.max(...candidates) : ENVELOPE_MIN_CAP
  return Math.max(ENVELOPE_MIN_CAP, base * ENVELOPE_HEADROOM_MULT)
}

// Clamps state.velocity's magnitude to envelopeSpeedCap(movement) IN PLACE if exceeded. Returns
// true if it clamped (caller may want to log/flag this -- a genuinely legitimate player can never
// hit this branch, so every occurrence is either a real bug upstream or an adversarial input that
// found a gap sanitizeInputPayload/applyMovement's own bounds didn't cover). Never touches
// state.position directly -- clamping velocity is sufficient; the next physics/fallback step
// naturally integrates the corrected (bounded) velocity instead of an already-corrupted position.
export function enforceMovementEnvelope(state, movement) {
  const v = state.velocity
  if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) return false // non-finite velocity is PhysicsIntegration._applyKillPlane's job, not this check's
  const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
  const cap = envelopeSpeedCap(movement)
  if (speed <= cap) return false
  const scale = cap / speed
  v[0] *= scale; v[1] *= scale; v[2] *= scale
  return true
}
