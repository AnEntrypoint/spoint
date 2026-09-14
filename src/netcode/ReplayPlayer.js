import { decodeReplay } from './ReplayFile.js'

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

    const dtExact = Array.isArray(ticks) && ticks.length > 0
    let _origStep = null
    if (dtExact) {
      server.tickSystem.stop()
      if (Number.isFinite(header.collisionSteps) && typeof server.physics?.step === 'function') {
        _origStep = server.physics.step.bind(server.physics)
        const cs = header.collisionSteps
        server.physics.step = (dt) => _origStep(dt, cs)
      }
      const callbacks = server.tickSystem.callbacks
      let i = 0
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
