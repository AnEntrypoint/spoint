import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'

const KEYFRAME_INTERVAL = 128

export function createTickHandler(deps) {
  const {
    networkState, playerManager, physicsIntegration,
    lagCompensator, physics, appRuntime, connections,
    movement: m = {}, stageLoader, eventLog, _movement
  } = deps
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  const collisionRestitution = movement.collisionRestitution || 0.2
  const collisionDamping = movement.collisionDamping || 0.25
  let snapshotSeq = 0

  const playerEntityMaps = new Map()
  let broadcastEntityMap = new Map()

  let profileLog = 0
  const separated = new Set()
  return function onTick(tick, dt) {
    const t0 = performance.now()
    networkState.setTick(tick, Date.now())
    const players = playerManager.getConnectedPlayers()
    for (const player of players) {
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
      const wishedVx = st.velocity[0], wishedVz = st.velocity[2]
      const updated = physicsIntegration.updatePlayerPhysics(player.id, st, dt)
      st.position = updated.position
      st.velocity = updated.velocity
      st.velocity[0] = wishedVx
      st.velocity[2] = wishedVz
      st.onGround = updated.onGround
      lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
      networkState.updatePlayer(player.id, {
        position: st.position, rotation: st.rotation,
        velocity: st.velocity, onGround: st.onGround,
        health: st.health, inputSequence: player.inputSequence
      })
    }
    const t1 = performance.now()
    separated.clear()
    for (const player of players) {
      const collisions = physicsIntegration.checkCollisionWithOthers(player.id, players)
      for (const collision of collisions) {
        const pairKey = player.id < collision.playerId ? `${player.id}-${collision.playerId}` : `${collision.playerId}-${player.id}`
        if (separated.has(pairKey)) continue
        separated.add(pairKey)
        const other = playerManager.getPlayer(collision.playerId)
        if (!other) continue
        const nx = collision.normal[0], nz = collision.normal[2]
        const minDist = physicsIntegration.config.capsuleRadius * 2
        const overlap = minDist - collision.distance
        const halfPush = overlap * 0.5
        const pushVel = Math.min(halfPush / dt, 3.0)
        player.state.position[0] -= nx * halfPush
        player.state.position[2] -= nz * halfPush
        player.state.velocity[0] -= nx * pushVel
        player.state.velocity[2] -= nz * pushVel
        other.state.position[0] += nx * halfPush
        other.state.position[2] += nz * halfPush
        other.state.velocity[0] += nx * pushVel
        other.state.velocity[2] += nz * pushVel
        physicsIntegration.setPlayerPosition(player.id, player.state.position)
        physicsIntegration.setPlayerPosition(other.id, other.state.position)
      }
    }
    const t2 = performance.now()
    physics.step(dt)
    const t3 = performance.now()
    appRuntime.tick(tick, dt)
    const t4 = performance.now()
    if (players.length > 0) {
      const playerSnap = networkState.getSnapshot()
      snapshotSeq++
      const isKeyframe = snapshotSeq % KEYFRAME_INTERVAL === 0
      if (stageLoader && stageLoader.getActiveStage()) {
        for (const player of players) {
          const pos = player.state.position
          const entitySnap = appRuntime.getSnapshotForPlayer(pos, stageLoader.getActiveStage().spatial.relevanceRadius)
          const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: entitySnap.entities }
          if (isKeyframe || !playerEntityMaps.has(player.id)) {
            const encoded = SnapshotEncoder.encode(combined)
            const { entityMap } = SnapshotEncoder.encodeDelta(combined, new Map())
            playerEntityMaps.set(player.id, entityMap)
            connections.send(player.id, MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
          } else {
            const prevMap = playerEntityMaps.get(player.id)
            const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap)
            playerEntityMaps.set(player.id, entityMap)
            connections.send(player.id, MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
          }
        }
      } else {
        const entitySnap = appRuntime.getSnapshot()
        const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: entitySnap.entities }
        if (isKeyframe || broadcastEntityMap.size === 0) {
          const encoded = SnapshotEncoder.encode(combined)
          const { entityMap } = SnapshotEncoder.encodeDelta(combined, new Map())
          broadcastEntityMap = entityMap
          connections.broadcast(MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
        } else {
          const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, broadcastEntityMap)
          broadcastEntityMap = entityMap
          connections.broadcast(MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
        }
      }
    }
    for (const id of playerEntityMaps.keys()) {
      if (!playerManager.getPlayer(id)) playerEntityMaps.delete(id)
    }
    const t5 = performance.now()
    try {
      appRuntime._drainReloadQueue()
    } catch (e) {
      console.error('[TickHandler] reload queue error:', e.message)
    }
    profileLog++
    if (profileLog % 1280 === 0) {
      const total = t5 - t0
      const mem = process.memoryUsage()
      const heap = (mem.heapUsed / 1048576).toFixed(1)
      const rss = (mem.rss / 1048576).toFixed(1)
      const ext = (mem.external / 1048576).toFixed(1)
      const ab = (mem.arrayBuffers / 1048576).toFixed(1)
      console.log(`[tick-profile] tick:${tick} players:${players.length} total:${total.toFixed(2)}ms | mv:${(t1-t0).toFixed(2)} col:${(t2-t1).toFixed(2)} phys:${(t3-t2).toFixed(2)} app:${(t4-t3).toFixed(2)} snap:${(t5-t4).toFixed(2)} | heap:${heap}MB rss:${rss}MB ext:${ext}MB ab:${ab}MB`)
    }
  }
}
