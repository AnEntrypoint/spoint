import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { pack } from '../protocol/msgpack.js'
import { isUnreliable } from '../protocol/MessageTypes.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'

const MAX_SENDS_PER_TICK = 25
const PHYSICS_PLAYER_DIVISOR = 3

function applyPlayerCollisions(players, grid, gridCells, cellSz, minDist2, minDist, dt, physicsIntegration) {
  grid.clear()
  for (const p of players) {
    const cx=Math.floor(p.state.position[0]/cellSz), cz=Math.floor(p.state.position[2]/cellSz), ck=cx*65536+cz
    let cell=grid.get(ck); if (!cell){cell=gridCells.get(ck);if(!cell){cell=[];gridCells.set(ck,cell)}else{cell.length=0}grid.set(ck,cell)}; cell.push(p)
  }
  for (const player of players) {
    const px=player.state.position[0],py=player.state.position[1],pz=player.state.position[2]
    const cx=Math.floor(px/cellSz),cz=Math.floor(pz/cellSz)
    for (let ddx=-1;ddx<=1;ddx++) for (let ddz=-1;ddz<=1;ddz++) {
      const neighbors=grid.get((cx+ddx)*65536+(cz+ddz)); if (!neighbors) continue
      for (const other of neighbors) {
        if (other.id<=player.id) continue
        const ox=other.state.position[0],oy=other.state.position[1],oz=other.state.position[2]
        const dx=ox-px,dy=oy-py,dz=oz-pz,dist2=dx*dx+dy*dy+dz*dz
        if (dist2>=minDist2||dist2===0) continue
        const dist=Math.sqrt(dist2),nx=dx/dist,nz=dz/dist,overlap=minDist-dist,halfPush=overlap*0.5,pushVel=Math.min(halfPush/dt,3.0)
        player.state.position[0]-=nx*halfPush; player.state.position[2]-=nz*halfPush; player.state.velocity[0]-=nx*pushVel; player.state.velocity[2]-=nz*pushVel
        other.state.position[0]+=nx*halfPush; other.state.position[2]+=nz*halfPush; other.state.velocity[0]+=nx*pushVel; other.state.velocity[2]+=nz*pushVel
        physicsIntegration.setPlayerPosition(player.id,player.state.position); physicsIntegration.setPlayerPosition(other.id,other.state.position)
      }
    }
  }
}

export function createTickHandler(deps) {
  const {
    networkState, playerManager, physicsIntegration,
    lagCompensator, physics, appRuntime, connections,
    movement: m = {}, stageLoader, eventLog, _movement, getRelevanceRadius,
    tickRate = 128
  } = deps
  const KEYFRAME_INTERVAL = tickRate * 10
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  let snapshotSeq = 0
  const playerEntityMaps = new Map()
  let broadcastEntityMap = new Map()
  let staticEntityMap = new Map()
  let staticEntityIds = new Set()
  let lastStaticEntries = null
  let lastStaticVersion = -1
  let lastDynVersion = -1
  let prevDynCache = null
  let profileLog = 0
  let profileSum = 0, profileSumSnap = 0, profileSumPhys = 0, profileSumMv = 0, profileCount = 0
  const snapUnreliable = isUnreliable(MSG.SNAPSHOT)
  let grid = new Map()
  const gridCells = new Map()
  const playerIdleCounts = new Map()
  const playerAccumDt = new Map()

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
      const hasInput = inp && (inp.forward || inp.backward || inp.left || inp.right || inp.jump)
      const vx2 = wishedVx * wishedVx, vz2 = wishedVz * wishedVz
      const isIdle = !hasInput && st.onGround && vx2 + vz2 < 1e-4
      const idleCount = playerIdleCounts.get(player.id) || 0
      if (isIdle && idleCount >= 1) {
        playerIdleCounts.set(player.id, idleCount + 1)
        playerAccumDt.delete(player.id)
      } else {
        const accumDt = (playerAccumDt.get(player.id) || 0) + dt
        if ((tick + player.id) % PHYSICS_PLAYER_DIVISOR === 0 || inp?.jump || !st.onGround) {
          physicsIntegration.updatePlayerPhysics(player.id, st, dt)
          st.velocity[0] = wishedVx
          st.velocity[2] = wishedVz
          playerAccumDt.delete(player.id)
        } else {
          playerAccumDt.set(player.id, accumDt)
        }
        playerIdleCounts.set(player.id, isIdle ? idleCount + 1 : 0)
      }
      lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
      networkState.updatePlayer(player.id, st.position, st.rotation, st.velocity, st.onGround, st.health, player.inputSequence, st.crouch||0, st.lookPitch||0, st.lookYaw||0)
    }

    const t1 = performance.now()
    const cellSz = physicsIntegration.config.capsuleRadius * 8
    const minDist = physicsIntegration.config.capsuleRadius * 2
    applyPlayerCollisions(players, grid, gridCells, cellSz, minDist * minDist, minDist, dt, physicsIntegration)

    const t2 = performance.now()
    physics.step(dt)
    const t3 = performance.now()
    appRuntime.tick(tick, dt)
    const t4 = performance.now()

    if (players.length > 0) {
      const playerSnap = networkState.getSnapshot()
      snapshotSeq++
      const isKeyframe = snapshotSeq % KEYFRAME_INTERVAL === 0
      const playerCount = players.length
      const snapGroups = playerCount >= 50
        ? Math.max(1, Math.ceil(playerCount / 25))
        : Math.max(1, Math.ceil(playerCount / MAX_SENDS_PER_TICK))
      const curGroup = tick % snapGroups

      const activeStage = stageLoader ? stageLoader.getActiveStage() : null
      const relevanceRadius = activeStage
        ? activeStage.spatial.relevanceRadius
        : (getRelevanceRadius ? getRelevanceRadius() : 0)
      const serverNow = Date.now()
      if (relevanceRadius > 0) {
        const curStaticVersion = appRuntime._staticVersion
        let activeStaticEntries = null
        if (isKeyframe || curStaticVersion !== lastStaticVersion) {
          const staticSnap = appRuntime.getStaticSnapshot()
          const prevStaticMap = isKeyframe ? new Map() : staticEntityMap
          const { staticEntries, changedEntries, staticMap, staticChanged } = SnapshotEncoder.encodeStaticEntities(staticSnap.entities, prevStaticMap)
          lastStaticEntries = staticEntries
          if (staticChanged || isKeyframe) {
            staticEntityMap = staticMap
            staticEntityIds = SnapshotEncoder.buildStaticIds(staticMap)
            activeStaticEntries = isKeyframe ? staticEntries : changedEntries
          }
          lastStaticVersion = curStaticVersion
        }
        const serverTime = serverNow
        const precomputedRemoved = []
        let dynCache = null
        const prevDynCacheForRebuild = prevDynCache
        if (isKeyframe || curStaticVersion !== lastDynVersion) { prevDynCache = null; lastDynVersion = curStaticVersion }
        const allEncodedPlayers = SnapshotEncoder.encodePlayersOnce(playerSnap.players)
        const spatialCache = new Map()
        for (const player of players) {
          if (player.id % snapGroups !== curGroup) continue
          if (dynCache === null) {
            const activeIds = appRuntime._activeDynamicIds
            if (prevDynCache === null) {
              prevDynCache = SnapshotEncoder.buildDynamicCache(activeIds, appRuntime._sleepingDynamicIds, appRuntime._suspendedEntityIds, appRuntime.entities, prevDynCacheForRebuild)
            } else {
              SnapshotEncoder.refreshDynamicCache(prevDynCache, activeIds, appRuntime.entities)
            }
            dynCache = prevDynCache
          }
          const isNewPlayer = !playerEntityMaps.has(player.id)
          const viewerPos = player.state.position
          const cellKey = (Math.floor(viewerPos[0] / relevanceRadius) * 65536 + Math.floor(viewerPos[2] / relevanceRadius)) | 0
          let cached = spatialCache.get(cellKey)
          if (!cached) {
            cached = { nearbyPlayerIds: appRuntime._playerIndex.nearby(viewerPos, relevanceRadius), relevantIds: appRuntime.getRelevantDynamicIds(viewerPos, relevanceRadius) }
            spatialCache.set(cellKey, cached)
          }
          const nearbyPlayerIds = cached.nearbyPlayerIds
          const preEncodedPlayers = SnapshotEncoder.filterEncodedPlayersWithSelf(allEncodedPlayers, nearbyPlayerIds, player.id)
          const relevantIds = cached.relevantIds
          const prevMap = isNewPlayer ? new Map() : playerEntityMaps.get(player.id)
          const staticForPlayer = isNewPlayer ? lastStaticEntries : activeStaticEntries
          const removed = isNewPlayer ? undefined : precomputedRemoved
          const { encoded, entityMap } = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverTime, dynCache, relevantIds, prevMap, preEncodedPlayers, staticForPlayer, staticEntityMap, staticEntityIds, removed, snapshotSeq, viewerPos)
          if (isNewPlayer) { for (const id of prevMap.keys()) { if (!dynCache.has(id) && !(staticEntityIds && staticEntityIds.has(id))) precomputedRemoved.push(id) } }
          playerEntityMaps.set(player.id, entityMap)
          connections.send(player.id, MSG.SNAPSHOT, { seq: snapshotSeq, ...encoded })
        }
      } else {
        const entitySnap = appRuntime.getSnapshot()
        const combined = { tick: playerSnap.tick, players: playerSnap.players, entities: entitySnap.entities, serverTime: serverNow }
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

    for (const id of playerEntityMaps.keys()) { if (!playerManager.getPlayer(id)) { playerEntityMaps.delete(id); playerIdleCounts.delete(id); playerAccumDt.delete(id) } }
    const t5 = performance.now()
    try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    if (players.length > 0) { profileSum += t5-t0; profileSumSnap += t5-t4; profileSumPhys += t3-t2; profileSumMv += t1-t0; profileCount++ }
    if (++profileLog % KEYFRAME_INTERVAL === 0) {
      const total=t5-t0, mem=process.memoryUsage(), avg=n => profileCount>0?(n/profileCount).toFixed(2):'0'
      const mb=n=>(n/1048576).toFixed(1)
      const dynIds=appRuntime._dynamicEntityIds?.size||0, activeDyn=appRuntime._activeDynamicIds?.size||0
      const avgTotal=avg(profileSum),avgSnap=avg(profileSumSnap),avgPhys=avg(profileSumPhys),avgMv=avg(profileSumMv)
      profileSum=0; profileSumSnap=0; profileSumPhys=0; profileSumMv=0; profileCount=0
      const idleSkipped = players.length > 0 ? [...playerIdleCounts.values()].filter(c=>c>=2).length : 0
      const physSkipped = players.length > 0 ? playerAccumDt.size : 0
      try { console.log(`[tick-profile] tick:${tick} players:${players.length} idle:${idleSkipped} physSkip:${physSkipped} entities:${appRuntime.entities.size} dynIds:${dynIds} activeDyn:${activeDyn} total:${total.toFixed(2)}ms(avg:${avgTotal}) | mv:${(t1-t0).toFixed(2)}(avg:${avgMv}) col:${(t2-t1).toFixed(2)} phys:${(t3-t2).toFixed(2)}(avg:${avgPhys}) app:${(t4-t3).toFixed(2)} sync:${(appRuntime._lastSyncMs||0).toFixed(2)} respawn:${(appRuntime._lastRespawnMs||0).toFixed(2)} spatial:${(appRuntime._lastSpatialMs||0).toFixed(2)} col2:${(appRuntime._lastCollisionMs||0).toFixed(2)} int:${(appRuntime._lastInteractMs||0).toFixed(2)} snap:${(t5-t4).toFixed(2)}(avg:${avgSnap}) | heap:${mb(mem.heapUsed)}MB rss:${mb(mem.rss)}MB ext:${mb(mem.external)}MB ab:${mb(mem.arrayBuffers)}MB`) } catch (_) {}
    }
  }
}
