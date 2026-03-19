import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { pack } from '../protocol/msgpack.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'
import { applyPlayerCollisions } from '../netcode/CollisionSystem.js'

const MAX_SENDS_PER_TICK = 25
const PHYSICS_PLAYER_DIVISOR = 3
const SNAP_UNRELIABLE = true

let _lastYaw = NaN, _lastSinHalf = 0, _lastCosHalf = 1

function processPlayerMovement(players, deps, tick, dt, playerIdleCounts, playerAccumDt) {
  const { playerManager, physicsIntegration, lagCompensator, networkState, applyMovement, movement } = deps
  for (const player of players) {
    const inputs = playerManager.getInputs(player.id)
    const st = player.state
    if (inputs.length > 0) { player.lastInput = inputs[inputs.length - 1].data; playerManager.clearInputs(player.id) }
    const inp = player.lastInput || null
    if (inp) {
      const yaw = inp.yaw || 0
      if (yaw !== _lastYaw) { const half = yaw / 2; _lastSinHalf = Math.sin(half); _lastCosHalf = Math.cos(half); _lastYaw = yaw }
      st.rotation[0] = 0; st.rotation[1] = _lastSinHalf; st.rotation[2] = 0; st.rotation[3] = _lastCosHalf
      st.crouch = inp.crouch ? 1 : 0; st.lookPitch = inp.pitch || 0; st.lookYaw = yaw
    }
    applyMovement(st, inp, movement, dt)
    if (inp) physicsIntegration.setCrouch(player.id, !!inp.crouch)
    const wishedVx = st.velocity[0], wishedVz = st.velocity[2]
    const hasInput = inp && (inp.forward || inp.backward || inp.left || inp.right || inp.jump)
    const isIdle = !hasInput && st.onGround && wishedVx * wishedVx + wishedVz * wishedVz < 1e-4
    const idleCount = playerIdleCounts.get(player.id) || 0
    if (isIdle && idleCount >= 1) { playerIdleCounts.set(player.id, idleCount + 1); playerAccumDt.delete(player.id) }
    else {
      const accumDt = (playerAccumDt.get(player.id) || 0) + dt
      if ((tick + player.id) % PHYSICS_PLAYER_DIVISOR === 0 || inp?.jump || !st.onGround) {
        physicsIntegration.updatePlayerPhysics(player.id, st, dt); st.velocity[0] = wishedVx; st.velocity[2] = wishedVz; playerAccumDt.delete(player.id)
      } else { playerAccumDt.set(player.id, accumDt) }
      playerIdleCounts.set(player.id, isIdle ? idleCount + 1 : 0)
    }
    lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
    networkState.updatePlayer(player.id, st.position, st.rotation, st.velocity, st.onGround, st.health, player.inputSequence, st.crouch||0, st.lookPitch||0, st.lookYaw||0)
  }
}

const _spatialCache = new Map()
const _precomputedRemoved = []
const _cellPackCache = new Map()
const _packWrapper = { type: MSG.SNAPSHOT, payload: null }
const _packPayload = { seq: 0, tick: 0, serverTime: 0, players: null, entities: null, removed: undefined, delta: 1 }

function packSnapshot(seq, encoded) {
  _packPayload.seq = seq; _packPayload.tick = encoded.tick; _packPayload.serverTime = encoded.serverTime
  _packPayload.players = encoded.players; _packPayload.entities = encoded.entities
  _packPayload.removed = encoded.removed; _packPayload.delta = encoded.delta
  _packWrapper.payload = _packPayload
  return pack(_packWrapper)
}

function buildAndSendSnapshots(players, appRuntime, deps, tick, snapshotSeq, isKeyframe, state, serverNow) {
  const { connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps } = deps
  const playerSnap = networkState.getSnapshot()
  const playerCount = players.length
  const snapGroups = Math.max(1, Math.ceil(playerCount / 50))
  const curGroup = tick % snapGroups
  const activeStage = stageLoader ? stageLoader.getActiveStage() : null
  const relevanceRadius = activeStage ? activeStage.spatial.relevanceRadius : (getRelevanceRadius ? getRelevanceRadius() : 0)

  if (relevanceRadius > 0) {
    const curStaticVersion = appRuntime._staticVersion
    let activeStaticEntries = null
    if (isKeyframe || curStaticVersion !== state.lastStaticVersion) {
      const staticSnap = appRuntime.getStaticSnapshot()
      const prevStaticMap = isKeyframe ? new Map() : state.staticEntityMap
      const { staticEntries, changedEntries, staticMap, staticChanged } = SnapshotEncoder.encodeStaticEntities(staticSnap.entities, prevStaticMap)
      state.lastStaticEntries = staticEntries
      if (staticChanged || isKeyframe) { state.staticEntityMap = staticMap; state.staticEntityIds = SnapshotEncoder.buildStaticIds(staticMap); activeStaticEntries = isKeyframe ? staticEntries : changedEntries }
      state.lastStaticVersion = curStaticVersion
    }
    _precomputedRemoved.length = 0
    if (isKeyframe || curStaticVersion !== state.lastDynVersion) { state.prevDynCache = null; state.lastDynVersion = curStaticVersion }
    const allEncodedPlayers = SnapshotEncoder.encodePlayersOnce(playerSnap.players)
    _spatialCache.clear()
    _cellPackCache.clear()
    let dynCache = null
    for (const player of players) {
      if (player.id % snapGroups !== curGroup) continue
      if (dynCache === null) {
        const activeIds = appRuntime._activeDynamicIds
        if (state.prevDynCache === null) { state.prevDynCache = SnapshotEncoder.buildDynamicCache(activeIds, appRuntime._sleepingDynamicIds, appRuntime._suspendedEntityIds, appRuntime.entities, state.prevDynCache) }
        else { SnapshotEncoder.refreshDynamicCache(state.prevDynCache, activeIds, appRuntime.entities) }
        dynCache = state.prevDynCache
      }
      const isNewPlayer = !playerEntityMaps.has(player.id)
      const viewerPos = player.state.position
      const cellKey = (Math.floor(viewerPos[0] / relevanceRadius) * 65536 + Math.floor(viewerPos[2] / relevanceRadius)) | 0
      let cached = _spatialCache.get(cellKey)
      if (!cached) { cached = { nearbyPlayerIds: appRuntime._playerIndex.nearby(viewerPos, relevanceRadius), relevantIds: appRuntime.getRelevantDynamicIds(viewerPos, relevanceRadius) }; _spatialCache.set(cellKey, cached) }
      const preEncodedPlayers = SnapshotEncoder.filterEncodedPlayersWithSelf(allEncodedPlayers, cached.nearbyPlayerIds, player.id)
      const prevMap = isNewPlayer ? new Map() : playerEntityMaps.get(player.id)
      const { encoded, entityMap } = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverNow, dynCache, cached.relevantIds, prevMap, preEncodedPlayers, isNewPlayer ? state.lastStaticEntries : activeStaticEntries, state.staticEntityMap, state.staticEntityIds, isNewPlayer ? undefined : _precomputedRemoved, snapshotSeq, viewerPos)
      if (isNewPlayer) { for (const id of prevMap.keys()) { if (!dynCache.has(id) && !(state.staticEntityIds && state.staticEntityIds.has(id))) _precomputedRemoved.push(id) } }
      playerEntityMaps.set(player.id, entityMap)
      if (!isNewPlayer && encoded.entities.length === 0 && !encoded.removed) {
        let cellPack = _cellPackCache.get(cellKey)
        if (!cellPack) {
          cellPack = packSnapshot(snapshotSeq, encoded)
          _cellPackCache.set(cellKey, cellPack)
        }
        connections.sendPacked(player.id, cellPack, SNAP_UNRELIABLE)
      } else {
        const packedData = packSnapshot(snapshotSeq, encoded)
        connections.sendPacked(player.id, packedData, SNAP_UNRELIABLE)
      }
    }
  } else {
    const entitySnap = appRuntime.getSnapshot()
    const combined = { tick: playerSnap.tick, players: playerSnap.players, entities: entitySnap.entities, serverTime: serverNow }
    const prevMap = (isKeyframe || state.broadcastEntityMap.size === 0) ? new Map() : state.broadcastEntityMap
    const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap)
    state.broadcastEntityMap = entityMap
    const data = packSnapshot(snapshotSeq, encoded)
    for (const player of players) {
      if (!isKeyframe && player.id % snapGroups !== curGroup) continue
      connections.sendPacked(player.id, data, SNAP_UNRELIABLE)
    }
  }
}

export function createTickHandler(deps) {
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: m = {}, stageLoader, getRelevanceRadius, _movement, tickRate = 128 } = deps
  const KEYFRAME_INTERVAL = tickRate * 10
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  const mvDeps = { playerManager, physicsIntegration, lagCompensator, networkState, applyMovement, movement }
  const snapDeps = { connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps: new Map() }
  const snapState = { broadcastEntityMap: new Map(), staticEntityMap: new Map(), staticEntityIds: null, lastStaticEntries: null, lastStaticVersion: -1, lastDynVersion: -1, prevDynCache: null }
  const playerIdleCounts = new Map(), playerAccumDt = new Map()
  const grid = new Map(), gridCells = new Map()
  let snapshotSeq = 0, profileLog = 0, profileSum = 0, profileSumSnap = 0, profileSumPhys = 0, profileSumMv = 0, profileCount = 0

  return function onTick(tick, dt) {
    const t0 = performance.now()
    const serverNow = Date.now()
    networkState.setTick(tick, serverNow)
    const players = playerManager.getConnectedPlayers()
    processPlayerMovement(players, mvDeps, tick, dt, playerIdleCounts, playerAccumDt)
    const t1 = performance.now()
    const cellSz = physicsIntegration.config.capsuleRadius * 8, minDist = physicsIntegration.config.capsuleRadius * 2
    applyPlayerCollisions(players, grid, gridCells, cellSz, minDist * minDist, minDist, dt, physicsIntegration)
    const t2 = performance.now()
    physics.step(dt)
    const t3 = performance.now()
    appRuntime.tick(tick, dt)
    const t4 = performance.now()
    if (players.length > 0) { snapshotSeq++; buildAndSendSnapshots(players, appRuntime, snapDeps, tick, snapshotSeq, snapshotSeq % KEYFRAME_INTERVAL === 0, snapState, serverNow) }
    for (const id of snapDeps.playerEntityMaps.keys()) { if (!playerManager.getPlayer(id)) { snapDeps.playerEntityMaps.delete(id); playerIdleCounts.delete(id); playerAccumDt.delete(id) } }
    const t5 = performance.now()
    try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    if (players.length > 0) { profileSum += t5-t0; profileSumSnap += t5-t4; profileSumPhys += t3-t2; profileSumMv += t1-t0; profileCount++ }
    if (++profileLog % KEYFRAME_INTERVAL === 0) {
      const total=t5-t0, mem=process.memoryUsage(), avg=n => profileCount>0?(n/profileCount).toFixed(2):'0'
      const mb=n=>(n/1048576).toFixed(1)
      const dynIds=appRuntime._dynamicEntityIds?.size||0, activeDyn=appRuntime._activeDynamicIds?.size||0
      const avgTotal=avg(profileSum),avgSnap=avg(profileSumSnap),avgPhys=avg(profileSumPhys),avgMv=avg(profileSumMv)
      profileSum=0; profileSumSnap=0; profileSumPhys=0; profileSumMv=0; profileCount=0
      let idleSkipped = 0; if (players.length > 0) for (const c of playerIdleCounts.values()) if (c >= 2) idleSkipped++
      const physSkipped = players.length > 0 ? playerAccumDt.size : 0
      try { console.log(`[tick-profile] tick:${tick} players:${players.length} idle:${idleSkipped} physSkip:${physSkipped} entities:${appRuntime.entities.size} dynIds:${dynIds} activeDyn:${activeDyn} total:${total.toFixed(2)}ms(avg:${avgTotal}) | mv:${(t1-t0).toFixed(2)}(avg:${avgMv}) col:${(t2-t1).toFixed(2)} phys:${(t3-t2).toFixed(2)}(avg:${avgPhys}) app:${(t4-t3).toFixed(2)} sync:${(appRuntime._lastSyncMs||0).toFixed(2)} respawn:${(appRuntime._lastRespawnMs||0).toFixed(2)} spatial:${(appRuntime._lastSpatialMs||0).toFixed(2)} col2:${(appRuntime._lastCollisionMs||0).toFixed(2)} int:${(appRuntime._lastInteractMs||0).toFixed(2)} snap:${(t5-t4).toFixed(2)}(avg:${avgSnap}) | heap:${mb(mem.heapUsed)}MB rss:${mb(mem.rss)}MB ext:${mb(mem.external)}MB ab:${mb(mem.arrayBuffers)}MB`) } catch (_) {}
    }
  }
}
