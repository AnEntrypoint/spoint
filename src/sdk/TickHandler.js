import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { pack } from '../protocol/msgpack.js'
import { isUnreliable } from '../protocol/MessageTypes.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'

const KEYFRAME_INTERVAL = 128
const MAX_SENDS_PER_TICK = 25

export function createTickHandler(deps) {
  const {
    networkState, playerManager, physicsIntegration,
    lagCompensator, physics, appRuntime, connections,
    movement: m = {}, stageLoader, eventLog, _movement, getRelevanceRadius
  } = deps
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  let snapshotSeq = 0
  const playerEntityMaps = new Map()
  let broadcastEntityMap = new Map()
  let profileLog = 0
  const snapUnreliable = isUnreliable(MSG.SNAPSHOT)

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
        st.rotation[0] = 0
        st.rotation[1] = Math.sin(yaw / 2)
        st.rotation[2] = 0
        st.rotation[3] = Math.cos(yaw / 2)
        st.crouch = inp.crouch ? 1 : 0
        st.lookPitch = inp.pitch || 0
        st.lookYaw = yaw
      }
      applyMovement(st, inp, movement, dt)
      if (inp) physicsIntegration.setCrouch(player.id, !!inp.crouch)
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
        health: st.health, inputSequence: player.inputSequence,
        crouch: st.crouch || 0, lookPitch: st.lookPitch || 0, lookYaw: st.lookYaw || 0
      })
    }

    const t1 = performance.now()
    const cellSz = physicsIntegration.config.capsuleRadius * 8
    const minDist = physicsIntegration.config.capsuleRadius * 2
    const minDist2 = minDist * minDist
    const grid = new Map()
    for (const p of players) {
      const cx = Math.floor(p.state.position[0] / cellSz)
      const cz = Math.floor(p.state.position[2] / cellSz)
      const ck = cx * 65536 + cz
      let cell = grid.get(ck)
      if (!cell) { cell = []; grid.set(ck, cell) }
      cell.push(p)
    }
    for (const player of players) {
      const px = player.state.position[0], py = player.state.position[1], pz = player.state.position[2]
      const cx = Math.floor(px / cellSz), cz = Math.floor(pz / cellSz)
      for (let ddx = -1; ddx <= 1; ddx++) {
        for (let ddz = -1; ddz <= 1; ddz++) {
          const neighbors = grid.get((cx + ddx) * 65536 + (cz + ddz))
          if (!neighbors) continue
          for (const other of neighbors) {
            if (other.id <= player.id) continue
            const ox = other.state.position[0], oy = other.state.position[1], oz = other.state.position[2]
            const dx = ox - px, dy = oy - py, dz = oz - pz
            const dist2 = dx * dx + dy * dy + dz * dz
            if (dist2 >= minDist2 || dist2 === 0) continue
            const distance = Math.sqrt(dist2)
            const nx = dx / distance, nz = dz / distance
            const overlap = minDist - distance
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
      const snapGroups = Math.max(1, Math.ceil(players.length / MAX_SENDS_PER_TICK))
      const curGroup = tick % snapGroups

      const relevanceRadius = (stageLoader && stageLoader.getActiveStage())
        ? stageLoader.getActiveStage().spatial.relevanceRadius
        : (getRelevanceRadius ? getRelevanceRadius() : 0)
      if (relevanceRadius > 0) {
        for (const player of players) {
          if (!isKeyframe && player.id % snapGroups !== curGroup) continue
          const nearbyPlayers = appRuntime.getNearbyPlayers(player.state.position, relevanceRadius, playerSnap.players)
          const preEncodedPlayers = SnapshotEncoder.encodePlayers(nearbyPlayers)
          const entitySnap = appRuntime.getSnapshotForPlayer(player.state.position, relevanceRadius)
          const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, entities: entitySnap.entities }
          const prevMap = (isKeyframe || !playerEntityMaps.has(player.id)) ? new Map() : playerEntityMaps.get(player.id)
          const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap, preEncodedPlayers)
          playerEntityMaps.set(player.id, entityMap)
          connections.send(player.id, MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
        }
      } else {
        const entitySnap = appRuntime.getSnapshot()
        const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: entitySnap.entities }
        const prevMap = (isKeyframe || broadcastEntityMap.size === 0) ? new Map() : broadcastEntityMap
        const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap)
        broadcastEntityMap = entityMap
        const data = pack({ type: MSG.SNAPSHOT, payload: { seq: snapshotSeq, ...encoded } })
        for (const player of players) {
          if (!isKeyframe && player.id % snapGroups !== curGroup) continue
          connections.sendPacked(player.id, data, snapUnreliable)
        }
      }
    }

    for (const id of playerEntityMaps.keys()) {
      if (!playerManager.getPlayer(id)) playerEntityMaps.delete(id)
    }
    const t5 = performance.now()
    try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    profileLog++
    if (profileLog % 1280 === 0) {
      const total = t5 - t0
      const mem = process.memoryUsage()
      const heap = (mem.heapUsed / 1048576).toFixed(1)
      const rss = (mem.rss / 1048576).toFixed(1)
      const ext = (mem.external / 1048576).toFixed(1)
      const ab = (mem.arrayBuffers / 1048576).toFixed(1)
      try { console.log(`[tick-profile] tick:${tick} players:${players.length} total:${total.toFixed(2)}ms | mv:${(t1 - t0).toFixed(2)} col:${(t2 - t1).toFixed(2)} phys:${(t3 - t2).toFixed(2)} app:${(t4 - t3).toFixed(2)} snap:${(t5 - t4).toFixed(2)} | heap:${heap}MB rss:${rss}MB ext:${ext}MB ab:${ab}MB`) } catch (_) {}
    }
  }
}
