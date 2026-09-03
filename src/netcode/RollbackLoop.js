// rollback-tickhandler-resimulate-loop: GGPO-style rewind + replay-inputs-forward orchestration, built
// on the already-shipped PhysicsWorld.snapshotBodies/restoreBodies + snapshotCharacters/restoreCharacters
// primitive (src/physics/World.js) and TickHandler.js's simulateTick (the pure deterministic-simulation
// subset of onTick -- movement, player collisions, physics.step, appRuntime.tick -- with zero network I/O
// side effects, exported specifically for this consumer).
//
// SCOPE (honest first slice, per this row's own PRD detail): the local resimulate MECHANISM only -- a
// bounded per-tick ring buffer of physics-layer save-states, and a resimulateFrom(tick, dt, correctedInputs)
// call that restores the ring's snapshot at `tick` and replays simulateTick forward to the ring's newest
// tick using the corrected input for the mispredicted player. Misprediction DETECTION (comparing a
// late-arriving remote input against what was locally predicted) and the actual P2P wireweave transport
// wiring are explicitly NOT this row's scope -- they are the two already-filed sibling rows
// (rollback-entity-gamestate-snapshot, rollback-wireweave-p2p-wiring) plus a misprediction-detector row
// this session adds (see AGENTS.md/prd.yml). This module is deliberately usable standalone against ANY
// tick-boundary trigger a future caller supplies (a detected misprediction, a manual test harness, etc.)
// rather than wired to a specific transport, since no transport exists yet to wire it to.
//
// rollback-resimulate-duplicate-emission-suppression: the OPTIONAL `appRuntime` dependency (the same
// AppRuntime instance simulateTick's own appRuntime.tick(tick,dt) call runs against) lets resimulateFrom
// suppress a resimulated tick's one-shot side effects (network broadcasts/sends, EventLog records) via
// AppRuntime.setResimSuppressed -- see that method's own header comment for the full policy (suppressed by
// default per call, opt out via {suppressEmissions:false} for a caller's actually-final pass) and
// resimulateFrom's own header comment for why. Omitting appRuntime (undefined) is a valid degraded mode
// that skips suppression entirely -- a caller with no AppRuntime in play (a pure physics-only rollback
// harness) has no emission surface to suppress in the first place.
//
// WHY ONLY PHYSICS-LAYER STATE ROUND-TRIPS TODAY: PhysicsWorld.snapshotBodies/restoreBodies +
// snapshotCharacters/restoreCharacters cover Jolt-simulated dynamics (position/rotation/velocity for
// bodies, position/velocity for characters) -- exactly what physics.step() needs to resimulate correctly.
// They do NOT cover non-physics game state a tick can mutate (entity.custom fields, PlayerManager health/
// inventory bookkeeping, NetworkState's per-player wire cache) -- that is rollback-entity-gamestate-snapshot's
// explicit scope, including the one-shot-side-effect-vs-idempotent-pure-function audit that row's own detail
// calls for. A resimulate pass using ONLY this module's snapshot is therefore correct for PURELY
// physics-driven ticks (movement + collision + physics.step + any appRuntime app whose update() reads/writes
// nothing but physics state) and will NOT correctly rewind an app that also mutates non-physics custom/
// player-manager state during the replayed window -- documented here, not silently assumed away.
//
// RING SIZING: a rollback window only needs to cover "how many ticks can pass before I learn a remote
// input for tick T was wrong" -- bounded by real P2P RTT via wireweave. At 60Hz a 250ms RTT is ~15 ticks;
// DEFAULT_WINDOW=16 covers that with one tick of margin and matches this row's own PRD detail ("bounded
// window, e.g. last 8-16 ticks"). Configurable per caller (small-lobby duel modes may want more margin).

const DEFAULT_WINDOW = 16

export function createRollbackLoop({ physics, simulateTick, playerManager, physicsIntegration = null, windowSize = DEFAULT_WINDOW, snapshotSimState = null, restoreSimState = null, appRuntime = null } = {}) {
  if (!physics || typeof physics.snapshotBodies !== 'function' || typeof physics.snapshotCharacters !== 'function') {
    throw new Error('[RollbackLoop] physics must expose snapshotBodies/restoreBodies + snapshotCharacters/restoreCharacters')
  }
  if (typeof simulateTick !== 'function') throw new Error('[RollbackLoop] simulateTick (TickHandler.onTick.simulateTick) is required')
  // physicsIntegration: OPTIONAL but required for correct player-character rollback -- see
  // PhysicsIntegration.resyncPlayerFromPhysics's own header comment for the real divergence bug this closes
  // (physics.restoreCharacters only touches the Jolt-native character; the JS-side player.state mirror +
  // PhysicsIntegration's own onGround cache are separate hidden state that must be explicitly re-synced or
  // the very next resimulated tick's physics integration starts from stale values). Omitting it is a valid
  // degraded mode ONLY for a caller with no player characters in play (pure-physics/entity rollback).
  // snapshotSimState/restoreSimState (TickHandler.onTick.snapshotSimState/restoreSimState): OPTIONAL but
  // strongly recommended -- see their own header comment in TickHandler.js for the real divergence bug this
  // closes (processPlayerMovement's idle/accumDt physics-decimation scheduling state is tick-history-
  // dependent hidden state outside the physics snapshot; omitting this makes a resim's replayed trajectory
  // NOT bit-reproduce the original even given byte-identical input, which defeats the entire premise of a
  // GGPO-style rollback). A caller that omits both (undefined) gets a functioning but KNOWINGLY-INEXACT
  // resim -- accepted as a valid degraded mode (e.g. a caller with no idle-decimation-sensitive gameplay)
  // rather than a hard constructor throw, but every consumer wiring this up for real should pass both.

  // Ring buffer keyed by tick, capped at windowSize entries -- a plain Map used as an ordered ring (insertion
  // order === tick order since save() is called once per real tick in strictly increasing order by the
  // caller's own TickHandler-adjacent loop); oldest entry evicted once the window is full. A Map (not a
  // fixed-size array indexed by tick%windowSize) is used deliberately: an array-ring silently aliases two
  // ticks windowSize apart onto the same slot with no signal, which is exactly the kind of "looks fine,
  // silently wrong under real load" bug this project's own engineering invariants forbid; a Map makes a
  // stale/missing tick an explicit has()===false rather than a quietly-overwritten wrong entry.
  const ring = new Map()
  let newestTick = -1

  // save: called once per real (non-rolled-back) tick, mirroring the tick boundary onTick already runs at
  // -- captures the physics-layer state AFTER that tick's simulation completed, so resimulateFrom(tick,...)
  // restores to "the state the world was in right after tick `tick` finished", the correct GGPO save point
  // (the tick boundary a corrected input for tick+1 onward needs to replay from).
  function save(tick) {
    ring.set(tick, {
      bodies: physics.snapshotBodies(),
      characters: physics.snapshotCharacters(),
      simState: snapshotSimState ? snapshotSimState() : null,
    })
    if (tick > newestTick) newestTick = tick
    if (ring.size > windowSize) {
      // evict the single oldest entry (Map iteration order === insertion order === tick order, guaranteed
      // by save() always being called in increasing-tick order)
      const oldestKey = ring.keys().next().value
      ring.delete(oldestKey)
    }
  }

  function has(tick) { return ring.has(tick) }
  function oldestTick() { const k = ring.keys().next(); return k.done ? -1 : k.value }

  // resimulateFrom: restore the ring's saved state at `fromTick` (must be a tick this ring actually saved --
  // see has()/oldestTick() for the caller-facing preconditions) then replay simulateTick forward through
  // every tick up to and including `toTick` (defaults to the ring's own newest known tick), applying
  // `correctedInputs` (Map<playerId, {tick, data}[]> or a plain function (tick, playerId) => inputData|null)
  // for whichever (tick, playerId) pairs the caller wants overridden -- every player/tick NOT present in
  // correctedInputs keeps replaying its ORIGINAL predicted input via player.lastInput's existing pre-replay
  // value (a real rewind only corrects the mispredicted player's input; every other player's already-locally-
  // simulated input was correct and must not be perturbed, or the resimulation diverges from what was
  // actually locally correct for them). Returns { fromTick, toTick, ticksReplayed } for the caller to log/
  // assert against, or throws if fromTick isn't in the ring (a caller asking to rewind past the window is a
  // real logic error worth a loud failure, not a silent no-op).
  //
  // rollback-resimulate-duplicate-emission-suppression: `opts.suppressEmissions` (default TRUE) gates
  // whether replayed ticks' one-shot side effects (network broadcasts/sends, EventLog records -- see
  // AppRuntime.setResimSuppressed's own header comment for the full rationale, including why ctx.bus.emit
  // is DELIBERATELY exempt) actually reach a client/durable log during this call. Defaulting to
  // suppressed-on is the safe default for the reason the PRD row itself names: every `resimulateFrom` call
  // is, from ITS OWN perspective, replaying tick range [fromTick+1, toTick] that a later correction might
  // supersede again before the caller's next real (non-rolled-back) onTick catches up -- an orchestration
  // loop that calls resimulateFrom more than once for overlapping ranges (rollback-misprediction-detector's
  // eventual job) MUST NOT let every one of those calls double-emit for the same logical tick. The one
  // caller-known exception -- "this is the actually-final corrective pass, its output IS what a client
  // should receive" -- is opt-in via `{suppressEmissions:false}`, never inferred here: this module has no
  // way to know from inside one synchronous call whether a LATER call will supersede it, so the safe
  // default suppresses and the caller (who alone knows its own retry/settle logic) explicitly un-suppresses
  // only the pass it has decided is final. A caller that never resimulates the same range twice (the common
  // case: one correction, one resimulateFrom call, done) should pass {suppressEmissions:false} for that
  // single call so its replayed ticks' output actually reaches clients -- suppressing by default and never
  // un-suppressing would silently blackhole every corrected tick's snapshot/broadcast forever, which is
  // exactly the kind of "looks fine, silently wrong" failure mode this project's engineering invariants
  // forbid, so this is opt-OUT-of-suppression per call, not a fire-and-forget default. No-op (skipped
  // entirely, not merely a false flag) when the caller never provided `appRuntime`, matching every other
  // optional dependency's degraded-mode discipline in this module (see the constructor's own header note).
  function resimulateFrom(fromTick, dt, correctedInputs, toTick = newestTick, opts = {}) {
    if (!ring.has(fromTick)) {
      throw new Error(`[RollbackLoop] resimulateFrom(${fromTick}): not in ring (oldest=${oldestTick()}, newest=${newestTick}, window=${windowSize}) -- caller must check has(fromTick) first`)
    }
    if (toTick < fromTick) throw new Error(`[RollbackLoop] resimulateFrom: toTick (${toTick}) must be >= fromTick (${fromTick})`)
    const snap = ring.get(fromTick)
    physics.restoreBodies(snap.bodies)
    physics.restoreCharacters(snap.characters)
    if (restoreSimState) restoreSimState(snap.simState)
    if (physicsIntegration) {
      for (const p of playerManager.getConnectedPlayers()) physicsIntegration.resyncPlayerFromPhysics(p.id, p.state)
    }

    const getCorrected = typeof correctedInputs === 'function'
      ? correctedInputs
      : (t, playerId) => correctedInputs?.get(playerId)?.find(e => e.tick === t)?.data ?? null

    const suppress = opts.suppressEmissions !== false
    if (appRuntime) appRuntime.setResimSuppressed(suppress)
    const players = playerManager.getConnectedPlayers()
    let ticksReplayed = 0
    try {
      for (let t = fromTick + 1; t <= toTick; t++) {
        for (const p of players) {
          const corrected = getCorrected(t, p.id)
          if (corrected != null) p.lastInput = corrected
          // else: leave p.lastInput at whatever it already holds -- simulateTick's own processPlayerMovement
          // drains fresh queued inputs off playerManager's inputBuffers for players who have new ones, but a
          // resimulate pass runs OUTSIDE the normal per-tick input-arrival cadence, so a player with no
          // correction for this specific replayed tick simply keeps predicting forward from their last-known
          // input, matching how the original (non-rolled-back) tick actually ran for them.
        }
        simulateTick(t, dt, players)
        // re-save this tick's post-simulation state into the ring so a SECOND rollback (a later correction
        // arriving for an even-later tick) rewinds from the now-corrected trajectory, not the stale
        // pre-rollback one -- without this, two corrections in the same window would silently discard the
        // first one's effect on every subsequent replay.
        save(t)
        ticksReplayed++
      }
    } finally {
      // Unconditionally un-suppress on the way out, success or throw (a mid-replay exception must not
      // leave the runtime permanently silenced for every subsequent normal onTick -- a stuck-suppressed
      // runtime would be a far worse failure mode than the duplicate-emission bug this row exists to fix).
      if (appRuntime) appRuntime.setResimSuppressed(false)
    }
    return { fromTick, toTick, ticksReplayed, suppressedEmissions: suppress }
  }

  return { save, has, oldestTick, get newestTick() { return newestTick }, get windowSize() { return windowSize }, resimulateFrom, _ring: ring }
}
