// rollback-wireweave-p2p-wiring-input-ingestion: wires the three already-shipped, previously-unconsumed
// rollback primitives into a real, standalone GGPO-style rollback orchestrator --
// RollbackLoop.js (local rewind+replay mechanism), MispredictionDetector.js (input-repeat prediction
// bookkeeping + tolerance-checked late-arrival detection), and client/RollbackInputTransport.js (the P2P
// wire this row's own PRD detail names as missing). Mirrors LockstepGameLoop.js's own precedent exactly
// (same shape: a reusable orchestrator, not a hardwired game mode -- selecting a rollback game MODE at
// server.js/WorkerEntry.js is a separate decision left to whichever app/world wants it) but the actual
// per-tick discipline is the OPPOSITE of lockstep's, per RollbackInputTransport.js's own header note:
//
//   1. Every tick: for each OTHER connected peer, predict their input via input-repeat (this module's own
//      job, per MispredictionDetector's own header comment: "the caller's per-tick prediction step... the
//      caller passes forward whatever it last actually received" -- decision (1) from that module's own
//      doc, implemented here) and record it via detector.recordPredicted(peerId, tick, predicted).
//   2. Simulate THIS tick immediately using the prediction -- never block/wait, unlike LockstepGameLoop.
//   3. Broadcast this peer's own REAL local input for this tick over the transport (no input-delay buffer
//      needed here, unlike lockstep -- rollback's whole point is to simulate ahead of confirmation, not
//      hide RTT behind a fixed buffer).
//   4. When a remote peer's real input for a PAST tick arrives (RollbackInputTransport's onRemoteInput
//      hook, wired to detector.onRemoteInputArrived), if it differs from what was predicted, call
//      rollback.resimulateFrom(fromTick, dt, correctedInputs, toTick) with the caller's own FINAL-PASS
//      judgement (see FINAL-PASS DISCIPLINE below).
//
// FINAL-PASS DISCIPLINE (this row's own new-scope decision, per its PRD detail: "unlike a lockstep peer
// which blocks synchronously on a full roster before ever stepping, a rollback peer speculates forward
// immediately and may receive several corrections for overlapping ranges before settling, so this row
// needs a real is-this-resimulate-the-final-one-for-now heuristic"). Chosen policy: DEBOUNCE-THEN-FLUSH.
// Every onRemoteInputArrived-triggered resimulateFrom call runs SUPPRESSED (RollbackLoop's own default,
// per rollback-resimulate-duplicate-emission-suppression's already-shipped policy -- a mid-window
// correction's replayed ticks must not double-broadcast/double-log yet, since a LATER correction for an
// overlapping range may supersede it before the caller's next real tick catches up). A short real-time
// debounce window (flushDebounceMs, default 30ms -- roughly two tick-periods at 60Hz, long enough to
// coalesce a small burst of near-simultaneous late arrivals from several peers for the same rough tick
// range, short enough that a single isolated correction still flushes promptly) tracks the HIGHEST tick
// any pending correction has touched; once the window elapses with no further correction, one final
// UNSUPPRESSED resimulateFrom re-runs the same [fromTick, toTick] range (toTick pinned to the loop's own
// current tick at flush time, matching the "resimulation has caught back up to currentTick with no
// further correction pending" alternative this row's own detail names) so its output actually reaches
// clients exactly once. Chosen over the row's other named alternative (track-highest-corrected-tick and
// unsuppress once caught up to currentTick with no pending correction) because debounce-then-flush is
// simpler to reason about under concurrent multi-peer corrections (one timer, one flush, no separate
// "still pending" bookkeeping needed beyond the timer handle itself) and gives the same end result: every
// tick's FINAL corrected state reaches clients exactly once, no tick's output is silently dropped forever.

const DEFAULT_FLUSH_DEBOUNCE_MS = 30
const DEFAULT_STALL_TICKS = 180 // matches RollbackInputTransport's own default, reused not re-derived

export function createRollbackGameLoop({
  tickSystem, // any onTick(cb)/start()/stop()/getTick() driver -- TickSystem.js or LockstepTickSystem.js both satisfy this, this module has no dilation opinion either way
  transport, // RollbackInputTransport instance
  rollback, // RollbackLoop instance (createRollbackLoop(...))
  detector, // MispredictionDetector instance (createMispredictionDetector(...))
  playerManager,
  localPeerId, // this peer's own PlayerManager id -- required so prediction/broadcast never target ourselves
  getLocalInput = null, // (tick) => inputData -- caller's own current local input snapshot for this tick, required for real broadcast; defaults to {} (a caller with no local-input source, e.g. a pure spectator/server-authority peer, still gets a functioning loop, just broadcasting empty input every tick)
  flushDebounceMs = DEFAULT_FLUSH_DEBOUNCE_MS,
  onStalledPeer = null, // (stalled: [{pubkey,lastTick}], defaultAction: () => void) => void, mirrors LockstepGameLoop's own override hook
  onMisprediction = null, // (detection, resimResult) => void -- diagnostic hook, called on every triggered resimulateFrom (both the initial suppressed pass and the final debounced flush)
} = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    throw new Error('[RollbackGameLoop] tickSystem is required')
  }
  if (!transport || typeof transport.submitLocalInput !== 'function') {
    throw new Error('[RollbackGameLoop] transport (RollbackInputTransport instance) is required')
  }
  if (!rollback || typeof rollback.resimulateFrom !== 'function' || typeof rollback.save !== 'function') {
    throw new Error('[RollbackGameLoop] rollback (RollbackLoop instance) is required')
  }
  if (!detector || typeof detector.recordPredicted !== 'function' || typeof detector.onRemoteInputArrived !== 'function') {
    throw new Error('[RollbackGameLoop] detector (MispredictionDetector instance) is required')
  }
  if (!playerManager || typeof playerManager.getConnectedPlayers !== 'function') {
    throw new Error('[RollbackGameLoop] playerManager is required')
  }
  if (!localPeerId) throw new Error('[RollbackGameLoop] localPeerId is required')

  let currentTick = 0
  let currentDt = 0
  const stats = { ticksSimulated: 0, predicted: 0, mispredictions: 0, resimulates: 0, finalFlushes: 0, dropped: [] }

  // Pending-flush bookkeeping for the debounce-then-flush discipline above: one timer, re-armed on every
  // new correction; tracks the widest [fromTick, toTick] any pending (not-yet-finally-flushed) correction
  // has touched so the eventual final pass covers every tick a suppressed pass already replayed.
  let _flushTimer = null
  let _pendingFromTick = null // the SMALLEST fromTick among pending corrections (the earliest rewind point still owed a final unsuppressed pass)
  let _pendingToTick = null // the LARGEST toTick among pending corrections

  function _scheduleFinalFlush(fromTick, toTick) {
    _pendingFromTick = _pendingFromTick == null ? fromTick : Math.min(_pendingFromTick, fromTick)
    _pendingToTick = _pendingToTick == null ? toTick : Math.max(_pendingToTick, toTick)
    if (_flushTimer) clearTimeout(_flushTimer)
    _flushTimer = setTimeout(() => {
      _flushTimer = null
      const from = _pendingFromTick, to = Math.max(_pendingToTick, currentTick)
      _pendingFromTick = null; _pendingToTick = null
      if (!rollback.has(from)) return // fell out of the ring window before the debounce elapsed -- nothing left to flush correctly, matches RollbackLoop's own has()-first-check discipline rather than throwing
      const result = rollback.resimulateFrom(from, currentDt, () => null, to, { suppressEmissions: false })
      stats.finalFlushes++
      if (onMisprediction) onMisprediction({ finalFlush: true, fromTick: from, toTick: to }, result)
    }, flushDebounceMs)
    if (_flushTimer.unref) _flushTimer.unref()
  }

  // The actual wire-ingestion this row exists to ship: a remote peer's real input for a past tick
  // arriving over RollbackInputTransport routes straight into the detector, and a genuine misprediction
  // triggers a real (suppressed) resimulateFrom -- then schedules the debounced final unsuppressed flush.
  function _onRemoteInput(peerId, tick, arrivedInput) {
    const detection = detector.onRemoteInputArrived(peerId, tick, arrivedInput, currentTick)
    if (!detection) return // no misprediction, or an untracked/evicted tick -- nothing to correct
    stats.mispredictions++
    if (!rollback.has(detection.fromTick)) return // rewind point already evicted from the ring -- cannot correct, same honest no-op RollbackLoop itself would throw on if forced; a caller this far behind has bigger problems than one missed correction
    const result = rollback.resimulateFrom(detection.fromTick, currentDt, detection.correctedInputs, detection.toTick, { suppressEmissions: true })
    stats.resimulates++
    if (onMisprediction) onMisprediction(detection, result)
    _scheduleFinalFlush(detection.fromTick, detection.toTick)
  }
  transport.onRemoteInput = _onRemoteInput

  function _defaultDropStalled(stalled) {
    for (const { pubkey } of stalled) {
      transport.dropPeer(pubkey)
      stats.dropped.push(pubkey)
    }
  }

  function _predictRemoteInputs(tick) {
    const players = playerManager.getConnectedPlayers()
    for (const p of players) {
      if (p.id === localPeerId) continue
      // input-repeat (MispredictionDetector's own documented decision (1)): assume this peer's last-known
      // real input persists. p.lastInput already IS that value (TickHandler's own per-player mirror,
      // updated whenever a real input for this player was last received/simulated) -- reusing it rather
      // than this module tracking a second parallel copy, matching RollbackLoop.resimulateFrom's own
      // "leave p.lastInput at whatever it already holds" input-repeat discipline for the identical reason.
      const predicted = p.lastInput ?? null
      detector.recordPredicted(p.id, tick, predicted)
      stats.predicted++
    }
  }

  function _tick(tick, dt) {
    currentTick = tick
    currentDt = dt

    // Step 1: predict every OTHER connected peer's input for this tick (this row's own new job --
    // MispredictionDetector deliberately does not presume a prediction policy, see that module's header).
    _predictRemoteInputs(tick)

    // Step 2: broadcast THIS peer's own real local input for this tick -- no delay buffer (unlike
    // lockstep), rollback's whole design is to simulate ahead of confirmation rather than hide RTT behind
    // a fixed submission delay.
    const localInput = getLocalInput ? getLocalInput(tick) : {}
    transport.submitLocalInput(tick, localInput)

    // Step 3: simulate THIS tick immediately (never block) and save it into the rollback ring -- the
    // caller's own tickSystem.onTick wiring is expected to have already run simulateTick for `tick`
    // BEFORE this loop's own onTick handler fires (see start()'s registration order below: the caller's
    // real physics/app tick handler registers first, this module's bookkeeping handler registers second,
    // so by the time this fires the tick's simulation has already happened and is ready to snapshot).
    rollback.save(tick)
    stats.ticksSimulated++

    // Step 4: stall/roster hygiene, mirroring LockstepGameLoop's own default-drop policy exactly (same
    // rationale: a rollback session that pauses forever because one peer's data channel died is a worse
    // failure mode than continuing without them -- see that module's own header comment for the full
    // argument, reused verbatim here since the failure mode is transport-generic, not lockstep-specific).
    const stalled = transport.getStalledPeers(tick)
    if (stalled.length) {
      if (onStalledPeer) onStalledPeer(stalled, () => _defaultDropStalled(stalled))
      else _defaultDropStalled(stalled)
    }
  }

  tickSystem.onTick(_tick)

  return {
    start() { tickSystem.start() },
    stop() { tickSystem.stop(); if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null } },
    get currentTick() { return currentTick },
    getStats() { return { ...stats, dropped: [...stats.dropped], pendingFlush: _flushTimer != null } },
  }
}
