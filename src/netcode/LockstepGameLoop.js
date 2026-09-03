// lockstep-input-transport-tick-driver-integration: wires the two already-shipped, previously-unconsumed
// lockstep primitives together into a real, standalone GGPO-style lockstep orchestrator --
// LockstepTickSystem.js (fixed-dt tick driver, zero wall-clock dilation) and LockstepInputTransport.js
// (P2P input-only broadcast over wireweave's mesh, GGPO-style input-delay buffer). Neither had a consumer
// before this module; per the sibling rows' own precedent (RollbackLoop.js shipping standalone before its
// transport wiring existed), this is deliberately a reusable orchestrator, not a hardwired game-mode --
// selecting/booting a lockstep game MODE at server.js/WorkerEntry.js is a separate decision left to
// whichever app/world actually wants lockstep instead of the default load-adaptive TickSystem path.
//
// REAL GGPO-STYLE LOCKSTEP DISCIPLINE (per this row's own PRD detail, not invented here): each fixed-dt
// tick, submit this peer's local input for tick+inputDelayTicks (LockstepInputTransport.targetTickFor),
// then BLOCK (stall/backpressure the local sim, never speculate) until every known peer's input for the
// CURRENT tick has arrived (waitForTick) before calling physics.step(dt) for that tick. Unlike rollback
// netcode (RollbackLoop.js), plain lockstep has no "simulate optimistically and resimulate on divergence"
// fallback -- a tick that isn't ready simply does not simulate yet, and LockstepTickSystem's own fixed-dt
// firing continues to accumulate real ticks behind it (its own maxSteps=4 catch-up-burst cap already
// handles "fell behind while stalled", exactly the same mechanism it uses for a slow machine).
//
// STALL POLICY (the row's own open decision: "what happens when getStalledPeers reports a peer that has
// gone dark past its stall threshold -- pause the whole session vs. drop the peer"): this module DROPS a
// stalled peer, never indefinitely pauses the whole session. Rationale, argued from this project's own
// engineering invariants (fail fast and loud over limping on bad state; every failure path explicit):
// pausing an entire N-peer lockstep session forever because ONE peer's data channel died (WebRTC transport
// failures are not rare -- see wireweave's own DISCONNECT_GRACE handling in data.js) means one dead peer
// can wedge every other still-healthy peer's simulation permanently, which is a worse failure mode than
// continuing without the stalled peer. A caller that WANTS pause-the-session-until-resync semantics instead
// (e.g. a strict tournament/replay-integrity mode where dropping a peer must never happen silently) can
// override via the `onStalledPeer` constructor option, which receives the stalled-peer list every tick and
// can call `loop.pause()` itself instead of relying on the default auto-drop -- the DEFAULT is drop, but it
// is not the ONLY policy this module allows. Dropping ties directly into DesyncDetector's own resync
// strategy (lockstep-desync-wireweave-transport-and-tickhandler-wiring, still pending): a dropped peer that
// later reconnects re-enters the roster via LockstepInputTransport's own peer-open handling and would need
// a fresh full-state resync (recoverSnapshot) before rejoining simulation, exactly the mechanism that
// sibling row is scoped to wire once its own two dependency rows (this one included) land.
//
// pruneBefore POLICY: called every tick with `simulatedTick - windowTicks` (default matches
// LockstepInputTransport's own DEFAULT_STALL_TICKS-adjacent scale so pruning never races a peer that is
// merely slow-but-not-yet-stalled) once local simulation has provably passed that tick -- "provably passed"
// here means THIS peer's own simulatedTick counter, the only ticks this module can be sure are done with
// (a remote peer's progress is exactly what getStalledPeers/roster tracking exists to monitor, not assumed).

export const DEFAULT_PRUNE_WINDOW_TICKS = 240 // 4s at 60Hz -- comfortably wider than LockstepInputTransport's own stall-detection window (180 ticks/~3s) so pruning never deletes a tick a still-live-but-slow peer might yet need

export function createLockstepGameLoop({
  tickSystem,
  transport,
  physics,
  tickRate = 60,
  pruneWindowTicks = DEFAULT_PRUNE_WINDOW_TICKS,
  onStalledPeer = null, // (stalled: [{pubkey,lastTick}], defaultAction: () => void) => void -- override the default auto-drop by NOT calling defaultAction
  onTickSimulated = null, // (tick, dt, inputs) => void -- caller's own gameplay simulation hook, called only once a tick's inputs are fully ready and physics.step has run
  desyncDetector = null, // optional DesyncDetector instance -- if supplied, reportChecksum is called with this peer's own checksum on every isChecksumTick using `physics.snapshotBodies()` via LockstepChecksum.checksumBodies, wired in exactly the shape lockstep-desync-wireweave-transport-and-tickhandler-wiring's own PRD detail names as step (a)
  localPeerId = null, // required only if desyncDetector is supplied -- the id this peer reports its own checksum under
  checksumFn = null, // required only if desyncDetector is supplied -- (tick, snap) => checksum string, e.g. LockstepChecksum.checksumBodies
} = {}) {
  if (!tickSystem || typeof tickSystem.onTick !== 'function') {
    throw new Error('[LockstepGameLoop] tickSystem (LockstepTickSystem instance) is required')
  }
  if (!transport || typeof transport.submitLocalInput !== 'function' || typeof transport.waitForTick !== 'function') {
    throw new Error('[LockstepGameLoop] transport (LockstepInputTransport instance) is required')
  }
  if (!physics || typeof physics.step !== 'function') {
    throw new Error('[LockstepGameLoop] physics (PhysicsWorld instance) is required')
  }
  if (desyncDetector && (!localPeerId || typeof checksumFn !== 'function')) {
    throw new Error('[LockstepGameLoop] desyncDetector requires both localPeerId and checksumFn')
  }

  // The tick this peer has actually SIMULATED (physics.step called for it) -- distinct from
  // tickSystem.getTick(), which is the fixed-dt driver's own real-time-paced counter and keeps advancing
  // even while this loop is stalled waiting on a peer. simulatedTick is always <= the driver's tick; the
  // gap between them IS the stall/backpressure this row's own detail names ("stalling/backpressuring the
  // local sim if it is not yet ready").
  let simulatedTick = 0
  let paused = false
  // Ticks currently mid-flight in _processTick (submitted + awaiting waitForTick) -- LockstepTickSystem
  // fires onTick synchronously in a tight while-loop (its own catch-up burst), but this loop's readiness
  // wait is inherently async (a remote peer's input may not have arrived yet), so consecutive fixed-dt
  // ticks are queued and drained strictly in order rather than processed concurrently/out-of-order, which
  // would let a later tick's physics.step race ahead of an earlier one still awaiting inputs -- a lockstep
  // sim replaying ticks out of order is a correctness bug the whole architecture exists to avoid.
  const _queue = []
  let _draining = false

  const stats = { submitted: 0, stalledWaits: 0, dropped: [], ticksSimulated: 0 }

  // BUG FOUND+FIXED LIVE (this row's own real 3-peer witness caught it, not reasoned from source): the
  // input-delay buffer means tick N's input is submitted at local tick N-inputDelayTicks, per
  // targetTickFor's own contract -- but tick 1 (the very first tick any driver fires) has NO earlier local
  // tick to have submitted it from at all (there is no tick 1-inputDelayTicks when inputDelayTicks>=1). A
  // naive per-tick submit-then-wait loop therefore waits forever on waitForTick(1): nobody, ever, submits
  // for tick 1 through tick inputDelayTicks under the steady-state per-tick submission scheme alone --
  // live-reproduced as ticksSimulated staying 0 across an entire real 900ms/54-driver-tick run. Every real
  // GGPO-style lockstep implementation has this same startup ramp and handles it by pre-seeding the initial
  // delay-buffer window with a defined (typically empty/neutral) input before steady-state submission takes
  // over -- done once, in start(), below.
  let _seeded = false
  function _seedInitialDelayWindow() {
    if (_seeded) return
    _seeded = true
    for (let t = 1; t <= transport.inputDelayTicks; t++) {
      const seedInput = typeof transport.getLocalInput === 'function' ? transport.getLocalInput(t) : {}
      transport.submitLocalInput(t, seedInput)
    }
  }

  function _defaultDropStalled(stalled) {
    for (const { pubkey } of stalled) {
      transport.dropPeer(pubkey)
      stats.dropped.push(pubkey)
    }
  }

  async function _drain() {
    if (_draining) return
    _draining = true
    try {
      while (_queue.length) {
        const { tick, dt } = _queue.shift()
        if (paused) { _queue.unshift({ tick, dt }); break }
        await _processTick(tick, dt)
      }
    } finally {
      _draining = false
    }
  }

  async function _processTick(tick, dt) {
    // Step 1: submit this peer's OWN input for the delay-buffered target tick, per targetTickFor's own
    // contract (submit ahead of the tick actually being simulated, never for the tick being simulated
    // right now -- see LockstepInputTransport's own header comment for why zero-delay submission would
    // defeat the whole point of the buffer).
    const targetTick = transport.targetTickFor(tick)
    const localInput = typeof transport.getLocalInput === 'function' ? transport.getLocalInput(tick) : {}
    transport.submitLocalInput(targetTick, localInput)
    stats.submitted++

    // Step 2: block (stall/backpressure) until every known peer's input for THIS tick (not the delayed
    // target) has arrived -- this is what makes it lockstep rather than rollback: no speculative simulate.
    //
    // BUG FOUND+FIXED LIVE (this row's own witness caught two DISTINCT bugs here across two iterations, not
    // reasoned from source):
    // (1) transport.getStalledPeers(nowTick) treats "this peer has never reported ANY input yet"
    // (lastTick===undefined) identically to "reported once, a long time ago" -- correct as a transport-level
    // diagnostic (both really do look the same from the transport's point of view), but WRONG to feed
    // straight into a drop policy at tick 1 of a fresh session: with the default inputDelayTicks buffer, no
    // peer submits its FIRST input until tick 1+inputDelayTicks, so every peer legitimately has
    // lastTick===undefined for the session's first few ticks -- checking BEFORE the wait dropped the entire
    // roster before anyone had a fair chance to submit at all.
    // (2) a naive "check stall status ONCE before awaiting" cannot ever apply the grace-period fix for (1)
    // correctly EITHER: if tick 1 itself is the one stuck (a genuinely-silent peer, not just startup ramp),
    // _drain's serial per-tick processing means _processTick for tick 1 never RETURNS until waitForTick(1)
    // resolves -- so a "wait until tick > stallTicks" grace check evaluated once, before the await, can never
    // re-fire for that same still-pending tick 1 once real time actually passes it, permanently deadlocking
    // the whole queue (live-reproduced: ticksSimulated stuck at 0 forever, queueDepth growing unboundedly as
    // the driver kept firing new ticks behind the stuck one). Fix: race the wait itself against a real
    // interval poll that re-evaluates getStalledPeers/applies the drop policy WHILE still waiting -- dropping
    // a peer via transport.dropPeer immediately unblocks any waiter stuck only on that peer (per dropPeer's
    // own documented contract), so the poll interval IS what lets a stuck tick 1 eventually resolve.
    if (!transport.isTickReady(tick)) {
      stats.stalledWaits++
      const pollMs = Math.max(1, Math.round((transport.stallTicks / tickRate) * 1000) / 4) || 50
      const pollHandle = setInterval(() => {
        if (transport.isTickReady(tick)) return
        const stalled = transport.getStalledPeers(tick)
        if (stalled.length) {
          if (onStalledPeer) onStalledPeer(stalled, () => _defaultDropStalled(stalled))
          else _defaultDropStalled(stalled)
        }
      }, pollMs)
      if (pollHandle.unref) pollHandle.unref()
      try {
        await transport.waitForTick(tick)
      } finally {
        clearInterval(pollHandle)
      }
    }
    const inputs = await transport.waitForTick(tick)

    // Step 3: simulate. physics.step(dt) uses LockstepTickSystem's own fixed, never-wall-clock-derived dt
    // (the sibling probe's proven bit-exactness precondition) -- this loop never substitutes a different dt.
    physics.step(dt)
    simulatedTick = tick

    if (onTickSimulated) onTickSimulated(tick, dt, inputs)

    // Step 4 (optional): desync checksum exchange, wired exactly per this row's own PRD detail's step (a)
    // for the still-pending lockstep-desync-wireweave-transport-and-tickhandler-wiring sibling row -- this
    // module supplies the real call site (isChecksumTick/reportChecksum on the real fixed-dt tick loop),
    // that sibling row still owns broadcasting the checksum to remote peers over the (also still-pending
    // wiring-wise) transport and the onDesync hard-pause+resync UX. Reporting our OWN checksum locally is
    // safe and useful even single-peer (establishes the call pattern, costs one checksumBodies() call every
    // checksumIntervalTicks), so this module does that much unconditionally when a detector is supplied.
    if (desyncDetector && desyncDetector.isChecksumTick(tick)) {
      const checksum = checksumFn(tick, physics.snapshotBodies())
      desyncDetector.reportChecksum(tick, localPeerId, checksum)
    }

    // Step 5: bounded pruning, per this row's own detail ("periodically pruneBefore() once every peer's
    // simulation has provably passed a given tick") -- only this peer's OWN progress is provable here.
    if (typeof transport.pruneBefore === 'function' && tick > pruneWindowTicks) {
      transport.pruneBefore(tick - pruneWindowTicks)
    }

    stats.ticksSimulated++
  }

  function _onDriverTick(tick, dt) {
    _queue.push({ tick, dt })
    _drain()
  }

  tickSystem.onTick(_onDriverTick)

  return {
    start() { paused = false; _seedInitialDelayWindow(); tickSystem.start() },
    stop() { tickSystem.stop() },
    pause() { paused = true },
    resume() { paused = false; _drain() },
    get paused() { return paused },
    get simulatedTick() { return simulatedTick },
    get driverTick() { return tickSystem.getTick() },
    get stalledBehind() { return tickSystem.getTick() - simulatedTick },
    getStats() { return { ...stats, dropped: [...stats.dropped], queueDepth: _queue.length } },
  }
}
