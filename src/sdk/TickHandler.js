import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'

export function createTickHandler(deps) {
  const {
    networkState, playerManager, physicsIntegration,
    lagCompensator, physics, appRuntime, connections,
    movement: m = {}, stageLoader, eventLog, _movement
  } = deps
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  const collisionRestitution = m.collisionRestitution || 0.2
  const collisionDamping = m.collisionDamping || 0.25
  let snapshotSeq = 0

  let profileLog = 0
  return function onTick(tick, dt) {
    const t0 = performance.now()
    networkState.setTick(tick, Date.now())
    for (const player of playerManager.getConnectedPlayers()) {
      const inputs = playerManager.getInputs(player.id)
      const st = player.state

      if (inputs.length > 0) {
        player.lastInput = inputs[inputs.length - 1].data
        playerManager.clearInputs(player.id)
      }
      const inp = player.lastInput || null
      if (inp) {
        const yaw = inp.yaw || 0
        st.rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
      }

      applyMovement(st, inp, movement, dt)
      const updated = physicsIntegration.updatePlayerPhysics(player.id, st, dt)
      st.position = updated.position
      st.velocity = updated.velocity
      st.onGround = updated.onGround
      lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
      networkState.updatePlayer(player.id, {
        position: st.position, rotation: st.rotation,
        velocity: st.velocity, onGround: st.onGround,
        health: st.health, inputSequence: player.inputSequence
      })
    }
    const t1 = performance.now()
    const players = playerManager.getConnectedPlayers()
    for (const player of players) {
      const collisions = physicsIntegration.checkCollisionWithOthers(player.id, players)
      for (const collision of collisions) {
        const other = playerManager.getPlayer(collision.playerId)
        if (!other) continue
        const dx = collision.normal[0], dy = collision.normal[1], dz = collision.normal[2]
        const relVx = other.state.velocity[0] - player.state.velocity[0]
        const relVz = other.state.velocity[2] - player.state.velocity[2]
        const relDotNorm = relVx * dx + relVz * dz
        if (relDotNorm >= 0) continue
        const impulse = (1 + collisionRestitution) * relDotNorm * 0.5
        player.state.velocity[0] += impulse * dx * collisionDamping * 0.1
        player.state.velocity[2] += impulse * dz * collisionDamping * 0.1
        other.state.velocity[0] -= impulse * dx * collisionDamping * 0.1
        other.state.velocity[2] -= impulse * dz * collisionDamping * 0.1
      }
    }
    const t2 = performance.now()
    physics.step(dt)
    const t3 = performance.now()
    appRuntime.tick(tick, dt)
    const t4 = performance.now()
    const playerSnap = networkState.getSnapshot()
    snapshotSeq++
    if (stageLoader && stageLoader.getActiveStage()) {
      for (const player of players) {
        const pos = player.state.position
        const entitySnap = appRuntime.getSnapshotForPlayer(pos, stageLoader.getActiveStage().spatial.relevanceRadius)
        const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: entitySnap.entities }
        connections.send(player.id, MSG.SNAPSHOT, { seq: snapshotSeq, ...SnapshotEncoder.encode(combined) })
      }
    } else {
      const entitySnap = appRuntime.getSnapshot()
      const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: entitySnap.entities }
      connections.broadcast(MSG.SNAPSHOT, { seq: snapshotSeq, ...SnapshotEncoder.encode(combined) })
    }
    const t5 = performance.now()
    try {
      appRuntime._drainReloadQueue()
    } catch (e) {
      console.error('[TickHandler] reload queue error:', e.message)
    }
    profileLog++
    if (profileLog % 256 === 0) {
      const total = t5 - t0
      console.log(`[tick-profile] players:${players.length} total:${total.toFixed(2)}ms | movement:${(t1-t0).toFixed(2)} collision:${(t2-t1).toFixed(2)} physics:${(t3-t2).toFixed(2)} apps:${(t4-t3).toFixed(2)} snapshot:${(t5-t4).toFixed(2)} budget:${(7.81).toFixed(2)}ms`)
    }
  }
}
