const DEFAULT_WINDOW = 16

export function createRollbackLoop({ physics, simulateTick, playerManager, physicsIntegration = null, windowSize = DEFAULT_WINDOW, snapshotSimState = null, restoreSimState = null, appRuntime = null } = {}) {
  if (!physics || typeof physics.snapshotBodies !== 'function' || typeof physics.snapshotCharacters !== 'function') {
    throw new Error('[RollbackLoop] physics must expose snapshotBodies/restoreBodies + snapshotCharacters/restoreCharacters')
  }
  if (typeof simulateTick !== 'function') throw new Error('[RollbackLoop] simulateTick (TickHandler.onTick.simulateTick) is required')

  const ring = new Map()
  let newestTick = -1

  function save(tick) {
    ring.set(tick, {
      bodies: physics.snapshotBodies(),
      characters: physics.snapshotCharacters(),
      simState: snapshotSimState ? snapshotSimState() : null,
    })
    if (tick > newestTick) newestTick = tick
    if (ring.size > windowSize) {
      const oldestKey = ring.keys().next().value
      ring.delete(oldestKey)
    }
  }

  function has(tick) { return ring.has(tick) }
  function oldestTick() { const k = ring.keys().next(); return k.done ? -1 : k.value }

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
        }
        simulateTick(t, dt, players)
        save(t)
        ticksReplayed++
      }
    } finally {
      if (appRuntime) appRuntime.setResimSuppressed(false)
    }
    return { fromTick, toTick, ticksReplayed, suppressedEmissions: suppress }
  }

  return { save, has, oldestTick, get newestTick() { return newestTick }, get windowSize() { return windowSize }, resimulateFrom, _ring: ring }
}
