import { encodeReplay } from './ReplayFile.js'

// ReplayRecorder: records the REAL applied-input sequence of a live server session for later
// deterministic playback via ReplayPlayer. Deliberately hooks PlayerManager.addInput (the exact
// ingestion point ServerHandlers.js's PLAYER_INPUT case already calls after anti-cheat sanitization/
// rate-limiting -- see src/sdk/ServerHandlers.js) rather than re-deriving inputs from snapshots, so the
// recorded stream is byte-identical to what TickHandler.processPlayerMovement actually consumed.
//
// Also records the per-tick dt TickHandler.onTick actually received (src/netcode/TickSystem.js's
// dilationFactor-derived, real-load-adaptive, wall-clock-driven dt -- see deterministic-simulation-
// jolt-fixed-point-rollback's probe finding that THIS, not the Jolt solver, is the real replay-drift
// blocker: a single-tick 1e-6 relative dt perturbation alone produces 0.75mm divergence, a realistic
// 50-tick 10% dilation dip produces 25cm). Hooked via tickSystem.onTick, the same public registration
// API TickHandler itself uses (src/sdk/ServerAPI.js's `deps.tickSystem.onTick(ctx.onTick)`) -- multiple
// callbacks are supported natively (TickSystem.callbacks is an array), so this never displaces or
// wraps the real handler, it just observes the same (tick, dt) every real callback sees, in the same
// call this tick already makes.
//
// Usage (server-owning code, e.g. a CLI harness or an in-process recording toggle):
//   const rec = new ReplayRecorder({ playerManager, tickSystem, eventLog, worldName, tickRate })
//   rec.start()
//   ... real session runs (real ticks, real inputs) ...
//   const buf = rec.stop()   // Buffer/Uint8Array ready to write to a .spointreplay file
export class ReplayRecorder {
  constructor({ playerManager, tickSystem, eventLog = null, worldName = 'unknown', tickRate = 60, collisionSteps = 2 }) {
    if (!playerManager || typeof playerManager.addInput !== 'function') throw new Error('ReplayRecorder requires a real playerManager (with addInput)')
    if (!tickSystem) throw new Error('ReplayRecorder requires a real tickSystem')
    this._playerManager = playerManager
    this._tickSystem = tickSystem
    this._eventLog = eventLog
    this._worldName = worldName
    this._tickRate = tickRate
    // collisionSteps: World.js's step(dt, collisionSteps=2) parameter. The one production call site
    // (TickHandler.js) always omits it (always the default 2 today), but this is recorded explicitly
    // rather than assumed, so a future call site that DOES pass a non-default value still replays
    // correctly instead of silently drifting.
    this._collisionSteps = collisionSteps
    this._recording = false
    this._inputs = []
    this._ticks = [] // [{tick, dt}] -- the REAL dt TickSystem handed onTick this tick, in tick order
    this._playersSeen = new Map() // playerId -> {id,name,spawn}
    this._startTick = null
    this._endTick = null
    this._recordedAt = 0
    this._origAddInput = playerManager.addInput.bind(playerManager)
    this._onTickRecord = (tick, dt) => {
      if (!this._recording) return
      this._ticks.push({ tick, dt })
    }
  }

  // registerPlayer: capture a player's join-time spawn state so playback can reconstruct the same
  // initial condition. Call this once per player at join time (real session: from onClientConnect;
  // synthetic/bot session: right after playerManager.addPlayer).
  registerPlayer(playerId, name, spawnState) {
    this._playersSeen.set(playerId, {
      id: playerId,
      name: name || `Player ${playerId}`,
      spawn: {
        position: spawnState?.position ? [...spawnState.position] : [0, 0, 0],
        rotation: spawnState?.rotation ? [...spawnState.rotation] : [0, 0, 0, 1],
        health: spawnState?.health ?? 100,
      },
    })
  }

  start() {
    if (this._recording) return
    this._recording = true
    this._recordedAt = Date.now()
    this._inputs.length = 0
    this._ticks.length = 0
    // Monkeypatch addInput on the live instance: records every call with the CURRENT tick, then
    // forwards to the original so recording is fully transparent to the running session.
    const self = this
    this._playerManager.addInput = function (playerId, input, clientSeq) {
      if (self._recording) {
        const tick = self._tickSystem.currentTick
        if (self._startTick === null) self._startTick = tick
        self._endTick = tick
        self._inputs.push({ tick, playerId, sequence: clientSeq ?? null, data: input })
      }
      return self._origAddInput(playerId, input, clientSeq)
    }
    // Real public registration (not a monkeypatch) -- TickSystem.callbacks is an array, so this runs
    // alongside the production ctx.onTick every tick without touching or reordering it.
    this._tickSystem.onTick(this._onTickRecord)
  }

  stop() {
    if (!this._recording) return null
    this._recording = false
    this._playerManager.addInput = this._origAddInput
    // TickSystem.onTick dedupes by identity and has no removal API -- callbacks stays a live array for
    // the tickSystem's whole lifetime, so gate further recording via the _recording flag inside
    // _onTickRecord itself (checked above) rather than leaving a dangling unregistered reference.
    const header = {
      worldName: this._worldName,
      tickRate: this._tickRate,
      startTick: this._startTick ?? 0,
      endTick: this._endTick ?? 0,
      recordedAt: this._recordedAt,
      collisionSteps: this._collisionSteps,
      players: [...this._playersSeen.values()],
    }
    const events = this._eventLog && typeof this._eventLog._toArray === 'function' ? this._eventLog._toArray() : []
    return encodeReplay({ header, inputs: this._inputs, ticks: this._ticks, events })
  }

  get recording() { return this._recording }
  get inputCount() { return this._inputs.length }
  get tickCount() { return this._ticks.length }
}
