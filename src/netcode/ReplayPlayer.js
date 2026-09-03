import { decodeReplay } from './ReplayFile.js'

// ReplayPlayer: drives a REAL server session (createServer/loadWorld/start from src/sdk/server.js --
// the same construction path playtest harnesses use) by feeding back a recorded .spointreplay's input
// stream on the exact tick numbers they were originally applied, through the real production tick loop
// (TickHandler.onTick via the real TickSystem). This is deterministic PLAYBACK of the recorded inputs,
// not a mock: the same applyMovement/physics.step/appRuntime.tick calls a live session makes are made
// here.
//
// dt-exact mode (v2 replays, header.ticks non-empty -- see deterministic-simulation-record-and-replay-dt):
// once the live server has finished booting (server.start() has already registered the real onTick
// callback[s] on tickSystem.callbacks and started its wall-clock setInterval), this STOPS the live
// TickSystem and drives tickSystem.callbacks directly, tick-by-tick, passing the EXACT recorded dt
// instead of a freshly wall-clock/dilation-derived one -- eliminating the dt-mismatch the determinism
// probe found to be the real replay-drift source (Jolt's own solver is bit-exact given identical dt/
// collisionSteps; the drift was always upstream, in TickSystem re-deriving a different dt on replay).
// Recorded ticks are consumed in order with no wall-clock pacing at all (a synchronous loop, yielding
// periodically so this stays a good citizen in a shared event loop) -- deterministic replay has no
// reason to also reproduce real-time pacing, only the tick/dt/input SEQUENCE.
//
// v1-file fallback (no header.ticks, or a header.collisionSteps-less v1 envelope -- see decodeReplay):
// falls back to the original wall-clock-driven polling loop (real TickSystem ticks, unmodified
// dilation), preserving today's behavior for any replay recorded before this fix shipped.
//
// Usage:
//   const player = new ReplayPlayer({ createServer, worldDef, replayBuf })
//   const result = await player.play()   // { finalStates: Map<playerId, {position,rotation,velocity,health}>, ticksRun, dtExact }
//   await player.stop()
export class ReplayPlayer {
  constructor({ createServer, worldDef, replayBuf, sdkConfig = {} }) {
    if (typeof createServer !== 'function') throw new Error('ReplayPlayer requires createServer')
    if (!worldDef) throw new Error('ReplayPlayer requires worldDef (must match the world the replay was recorded against)')
    this._createServer = createServer
    this._worldDef = worldDef
    this._env = decodeReplay(replayBuf)
    this._sdkConfig = sdkConfig
    this._server = null
  }

  get header() { return this._env.header }

  async play({ extraTicks = 30, onTick = null } = {}) {
    const { header, inputs, ticks } = this._env
    const config = {
      tickRate: header.tickRate,
      ...this._sdkConfig,
    }
    const server = await this._createServer(config)
    this._server = server
    await server.loadWorld(this._worldDef)

    // Reconstruct each recorded player at its recorded spawn state, in the same join order, using the
    // same real join sequence a live connect uses (addPlayer + networkState.addPlayer + physics capsule
    // + initial position) -- see src/sdk/ServerHandlers.js's onClientConnect for the reference sequence
    // this mirrors. idMap translates the ORIGINAL recorded playerId -> this run's freshly assigned id
    // (PlayerManager.nextPlayerId always starts at 1 for a fresh server, so a single-session replay maps
    // 1:1, but this stays correct even if ids ever diverge).
    const idMap = new Map()
    const fakeSocket = { send() {}, close() {} }
    for (const p of header.players) {
      const newId = server.playerManager.addPlayer(fakeSocket, { position: p.spawn.position, rotation: p.spawn.rotation, health: p.spawn.health, name: p.name })
      idMap.set(p.id, newId)
      server.networkState.addPlayer(newId, { position: p.spawn.position })
      const capsuleRadius = this._worldDef.player?.capsuleRadius || 0.4
      server.physicsIntegration.addPlayerCollider(newId, capsuleRadius)
      server.physicsIntegration.setPlayerPosition(newId, p.spawn.position)
    }

    // Group recorded inputs by tick for O(1) per-tick lookup during playback.
    const byTick = new Map()
    for (const rec of inputs) {
      if (!byTick.has(rec.tick)) byTick.set(rec.tick, [])
      byTick.get(rec.tick).push(rec)
    }
    const applyInputsForTick = (tick) => {
      const recs = byTick.get(tick)
      if (!recs) return
      for (const r of recs) {
        const mappedId = idMap.get(r.playerId)
        if (mappedId != null) server.playerManager.addInput(mappedId, r.data, r.sequence ?? undefined)
      }
      byTick.delete(tick)
    }

    const lastTick = header.endTick + extraTicks
    await server.start()

    // dt-exact mode: only available when the recording captured per-tick dt (v2+ .spointreplay). A v1
    // file (ticks empty) falls back to the original wall-clock-driven poll loop below, unmodified.
    const dtExact = Array.isArray(ticks) && ticks.length > 0
    let _origStep = null
    if (dtExact) {
      // server.start()'s attachWSHandlers already called tickSystem.onTick(ctx.onTick) and
      // tickSystem.start() synchronously before resolving -- stop the live wall-clock loop and drive
      // the SAME registered callbacks (tickSystem.callbacks) directly with the exact recorded dt, so
      // this replay reproduces the exact dilationFactor-derived dt sequence TickSystem produced during
      // recording instead of a fresh, independently-load-derived one (the determinism probe's root
      // cause -- see this file's header comment).
      server.tickSystem.stop()
      // Pin collisionSteps to the recorded value (World.js step(dt, collisionSteps=2)). The one
      // production call site (TickHandler.js) always omits it today, so this is a no-op in practice
      // (recorded value is always the same default 2), but a future call site that DOES vary it would
      // otherwise silently replay with the wrong sub-stepping -- a real accuracy difference, not noise,
      // per the determinism probe's own confirmation. Restored in stop()/finally below.
      if (Number.isFinite(header.collisionSteps) && typeof server.physics?.step === 'function') {
        _origStep = server.physics.step.bind(server.physics)
        const cs = header.collisionSteps
        server.physics.step = (dt) => _origStep(dt, cs)
      }
      const callbacks = server.tickSystem.callbacks
      let i = 0
      // Yield to the event loop periodically (setImmediate/setTimeout(0)) so a long replay doesn't block
      // a shared process -- purely a cooperative-scheduling courtesy, not a determinism requirement:
      // nothing here is wall-clock-derived, the recorded (tick, dt) pairs alone drive the simulation.
      const YIELD_EVERY = 32
      await new Promise((resolve) => {
        const step = () => {
          let n = 0
          while (i < ticks.length && n < YIELD_EVERY) {
            const { tick, dt } = ticks[i]
            applyInputsForTick(tick)
            server.tickSystem.currentTick = tick
            for (const cb of callbacks) {
              try { cb(tick, dt) } catch (e) { console.error('[tick]', e?.stack || e?.message || e) }
            }
            if (typeof onTick === 'function') onTick(tick)
            i++
            n++
          }
          if (i >= ticks.length) { resolve(); return }
          setImmediate(step)
        }
        step()
      })
      // extraTicks (settle time past the last recorded input/dt) has no recorded dt to replay exactly --
      // reuse the last recorded dt (closest available truth) rather than falling back to a fresh
      // wall-clock-derived value, keeping the whole playback dt-sequence-driven end to end.
      const lastDt = ticks[ticks.length - 1]?.dt ?? (header.tickRate ? 1 / header.tickRate : 1 / 60)
      let extraTick = ticks[ticks.length - 1]?.tick ?? header.endTick
      const callbacksTail = server.tickSystem.callbacks
      while (extraTick < lastTick) {
        extraTick++
        server.tickSystem.currentTick = extraTick
        for (const cb of callbacksTail) {
          try { cb(extraTick, lastDt) } catch (e) { console.error('[tick]', e?.stack || e?.message || e) }
        }
        if (typeof onTick === 'function') onTick(extraTick)
      }
      if (_origStep) { server.physics.step = _origStep; _origStep = null }
    } else {
      await new Promise((resolve) => {
        const check = () => {
          const tick = server.tickSystem.currentTick
          // Feed every recorded input whose tick has just been reached (real TickSystem ticks are
          // wall-clock driven; we poll each interval rather than hooking onTick ourselves so this file
          // makes zero assumptions about TickHandler's internal callback-ordering).
          applyInputsForTick(tick)
          if (typeof onTick === 'function') onTick(tick)
          if (tick >= lastTick) { resolve(); return }
          setTimeout(check, Math.max(1, (1000 / header.tickRate) / 4))
        }
        check()
      })
    }

    const finalStates = new Map()
    for (const [origId, newId] of idMap) {
      const p = server.playerManager.getPlayer(newId)
      if (p) finalStates.set(origId, { position: [...p.state.position], rotation: [...p.state.rotation], velocity: [...p.state.velocity], health: p.state.health })
    }
    return { finalStates, ticksRun: server.tickSystem.currentTick, idMap, dtExact }
  }

  async stop() {
    if (this._server) { this._server.stop(); this._server = null }
  }
}
