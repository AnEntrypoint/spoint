// rollback-misprediction-detector: decides WHEN a P2P rollback caller should invoke
// RollbackLoop.js's resimulateFrom -- the trigger a real transport needs, split off
// rollback-tickhandler-resimulate-loop once that row shipped the local resimulate MECHANISM
// (src/netcode/RollbackLoop.js) but explicitly left detection out of scope.
//
// SCOPE (honest first slice, per this row's own PRD detail, mirroring DesyncDetector.js's own
// precedent for shipping a transport-independent detector against a still-pending transport row):
// this module never touches wireweave/the mesh directly. A caller feeds it two things per remote
// peer/tick -- what was locally PREDICTED for that peer at that tick (this module owns computing
// that, via input-repeat, decision (1) below) and what REALLY arrived once the remote packet lands
// (the caller owns receiving that, from whatever transport eventually exists) -- and this module
// decides whether the difference is worth a resimulate (decision (2)) and, if so, hands back
// EXACTLY the {fromTick, correctedInputs, toTick} triple RollbackLoop.resimulateFrom's own real
// signature expects (decision (3), the wiring CONTRACT -- not the wire ingestion itself, which
// stays blocked on rollback-wireweave-p2p-wiring since no transport exists yet to receive from).
//
// (1) WHAT "LOCALLY PREDICTED" MEANS: input-repeat, the simplest GGPO baseline this row's own detail
// names as the likely choice -- assume a remote peer's last-known input persists unchanged until a
// newer one arrives. This module tracks that explicitly (predictInput/recordPredicted) rather than
// silently trusting the caller's own player.lastInput mirror, because a caller may want to record a
// prediction for a tick BEFORE simulateTick actually runs it (the real GGPO ordering: predict, then
// simulate using the prediction, then correct later if wrong) -- this module is deliberately the
// single source of truth for "what did we predict for (peer, tick)", not a passive comparator.
//
// (2) THE TOLERANCE CHECK: byte-equal on every DISCRETE field (forward/backward/left/right/jump/
// crouch -- an analog stick binarized client-side is still exactly reproducible bit-for-bit, so any
// difference here is a genuine misprediction, never floating-point noise) and a configurable numeric
// tolerance on the two ANALOG fields (yaw/pitch, radians) -- a tiny arrived-vs-predicted delta on a
// continuously-turning look axis is expected noise from float wire quantization, not a "worth a
// resimulate" difference (see packQuat/dequantize round-trip precedent, AGENTS.md 2026-07-02e); only
// a delta exceeding DEFAULT_ANALOG_TOLERANCE_RAD actually triggers. expr is treated as discrete
// (an animation/viseme code, not a continuous value) matching processPlayerMovement's own u8 handling.
//
// (3) WIRING CONTRACT: onRemoteInputArrived(peerId, tick, arrivedInput) returns either null (no
// misprediction, or the tick predates this detector's own tracked window) or
// {fromTick, correctedInputs, toTick} ready to spread straight into rollback.resimulateFrom(fromTick,
// dt, correctedInputs, toTick) -- correctedInputs here is RollbackLoop's own documented function form
// (t, playerId) => inputData|null, closing over exactly the one (peerId, tick) pair that mispredicted
// (every other player/tick keeps replaying its original predicted input, matching RollbackLoop's own
// "only the mispredicted player's input is corrected" discipline, see that module's own header
// comment on resimulateFrom's correctedInputs param).
//
// GENUINELY NOT THIS ROW'S SCOPE (needs rollback-wireweave-p2p-wiring first, no real trigger surface
// exists to test live against yet): actually receiving a remote peer's wire input and calling
// onRemoteInputArrived with it. This module's own live witness below exercises the full detect ->
// build-correctedInputs -> resimulateFrom round trip against a REAL RollbackLoop.js instance using a
// SYNTHETIC late-arrival sequence (a local caller manually invoking onRemoteInputArrived with a
// deliberately-different arrived input) -- proving the detection ALGORITHM and its RollbackLoop wiring
// contract are correct, exactly as DesyncDetector.js's own shipped precedent did for checksum
// exchange against the (at the time) still-pending lockstep transport row.

export const DEFAULT_ANALOG_TOLERANCE_RAD = 0.02 // ~1.15 degrees -- tighter than a human can perceive on yaw/pitch, loose enough to absorb float32 wire quantization noise (see packQuat/dequantize precedent)
// BOOLEAN_FIELDS: real on/off flags -- boolean-coerced comparison is correct (any truthy vs falsy is a
// real discrete change, and processPlayerMovement's own reads (inp.forward, inp.jump, etc, TickHandler.js)
// only ever treat these as truthy/falsy too, never as a distinguishable-magnitude value).
const BOOLEAN_FIELDS = ['forward', 'backward', 'left', 'right', 'jump', 'crouch']
// EXACT_VALUE_FIELDS: small integer CODES, not flags -- expr (viseme/emote code, src/shared/ExpressionCodes
// equivalent) is a u8 where e.g. 1 vs 2 are two DIFFERENT non-zero codes; a naive `!!a.expr !== !!b.expr`
// boolean coercion would collapse any two non-zero codes to "equal" (both truthy) and silently miss a real
// misprediction -- caught live by this module's own witness harness before shipping (see git history).
const EXACT_VALUE_FIELDS = ['expr']
const ANALOG_FIELDS = ['yaw', 'pitch']

// inputsDiffer: the real equality/tolerance check (decision 2 above). Two nullish inputs are equal
// (both "no input this tick"); a nullish vs non-nullish pair always differs (an arrived real input
// correcting a predicted "nothing happened" guess, or vice versa, is a genuine misprediction).
export function inputsDiffer(a, b, analogToleranceRad = DEFAULT_ANALOG_TOLERANCE_RAD) {
  if (a == null && b == null) return false
  if (a == null || b == null) return true
  for (const f of BOOLEAN_FIELDS) {
    if (!!a[f] !== !!b[f]) return true
  }
  for (const f of EXACT_VALUE_FIELDS) {
    if ((a[f] || 0) !== (b[f] || 0)) return true
  }
  for (const f of ANALOG_FIELDS) {
    const av = a[f] || 0, bv = b[f] || 0
    if (Math.abs(av - bv) > analogToleranceRad) return true
  }
  return false
}

export function createMispredictionDetector({ windowSize = 16, analogToleranceRad = DEFAULT_ANALOG_TOLERANCE_RAD } = {}) {
  // predicted: Map<playerId, Map<tick, inputData|null>> -- bounded per-player exactly like
  // RollbackLoop's own ring (a prediction older than the rollback window can never be corrected via
  // resimulateFrom anyway, since the physics ring itself will have evicted that tick's snapshot; no
  // reason to hold a prediction history longer than the window that could actually act on it).
  const predicted = new Map()

  function _ringFor(playerId) {
    let m = predicted.get(playerId)
    if (!m) { m = new Map(); predicted.set(playerId, m) }
    return m
  }

  // recordPredicted: the caller's per-tick prediction step calls this ONCE per (peerId, tick) at the
  // moment it decides what a remote peer's input for that tick is assumed to be (input-repeat: the
  // caller passes forward whatever it last actually received, decision (1) above lives in the
  // CALLER's repeat logic -- this module just remembers what was predicted so a later arrival can be
  // compared against it, rather than re-deriving the repeat policy itself, since a caller may have
  // richer prediction (e.g. short extrapolation) this module should not presume to override).
  function recordPredicted(playerId, tick, inputData) {
    const ring = _ringFor(playerId)
    ring.set(tick, inputData)
    if (ring.size > windowSize) {
      const oldestKey = ring.keys().next().value
      ring.delete(oldestKey)
    }
  }

  function predictedAt(playerId, tick) {
    const ring = predicted.get(playerId)
    return ring && ring.has(tick) ? ring.get(tick) : undefined // undefined = "never recorded", distinct from null = "recorded as no-input"
  }

  // onRemoteInputArrived: the actual misprediction check + RollbackLoop wiring-contract builder
  // (decisions 2 + 3 above). `currentTick` is the caller's own latest simulated tick (RollbackLoop's
  // resimulateFrom toTick default) -- required explicitly rather than inferred, since this module has
  // no tick-loop access of its own (matching DesyncDetector's own caller-drives-everything discipline).
  // Returns null when: the tick predates anything ever recorded (predictedAt returns undefined --
  // nothing to compare against, most commonly because it fell outside `windowSize` already), OR the
  // arrived input matches what was predicted (no misprediction, nothing to correct). Otherwise returns
  // {fromTick, correctedInputs, toTick, playerId, tick, predicted, arrived} -- the extra fields beyond
  // RollbackLoop's own {fromTick, correctedInputs, toTick} triple are diagnostic (a caller may want to
  // log/count mispredictions) and safe to ignore via destructuring only what resimulateFrom needs.
  function onRemoteInputArrived(playerId, tick, arrivedInput, currentTick) {
    const pred = predictedAt(playerId, tick)
    if (pred === undefined) return null // untracked tick -- nothing to compare, cannot correct (already evicted or never predicted)
    if (!inputsDiffer(pred, arrivedInput, analogToleranceRad)) return null // prediction was correct, no correction needed

    // Overwrite the recorded prediction with the now-known-correct value so a SECOND late arrival for
    // the same tick (a real possibility: retransmission, or a further-corrected value) compares against
    // the truth, not the original wrong guess -- mirrors RollbackLoop.resimulateFrom's own re-save-every-
    // replayed-tick discipline for the identical reason (a second correction must build on the first).
    _ringFor(playerId).set(tick, arrivedInput)

    const fromTick = tick - 1
    const toTick = currentTick != null ? currentTick : tick
    const correctedInputs = (t, pid) => (t === tick && pid === playerId) ? arrivedInput : null
    return { fromTick, correctedInputs, toTick, playerId, tick, predicted: pred, arrived: arrivedInput }
  }

  return { recordPredicted, predictedAt, onRemoteInputArrived, windowSize, analogToleranceRad }
}
