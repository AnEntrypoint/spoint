import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder, TombstoneLog, updateTombstones, PLAYER_LOD_REDUCED_HZ, filterEncodedPlayersTiered, encodeSelfBlock } from '../netcode/SnapshotEncoder.js'
import { pack } from '../protocol/msgpack.js'
import { currentChartEpoch, createChartReanchorMessage } from './chartWire.js'
import { createCollisionTileStreamer } from '../netcode/CollisionTileStreamer.js'
import { applyMovement as _applyMovement, DEFAULT_MOVEMENT as _DEFAULT_MOVEMENT } from '../shared/movement.js'
import { applyPlayerCollisions } from '../netcode/CollisionSystem.js'
import { worldToCell, packCellKey } from '../terrain/CubeSphereCells.js'
import { createServerTimeOfDay } from './ServerTimeOfDay.js'
import { createServerWeather } from './ServerWeather.js'
import { enforceMovementEnvelope } from '../netcode/InputGuard.js'
import { stepTeleportHold } from '../netcode/TeleportHold.js'
import { recordSnapshotBytes, recordTickPhase } from './Metrics.js'
import { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK, trimEntitiesToBudget, estimateEntityBytes, computeRingRelevantIds, getPlayerPriorityIds, clearPlayerPriorityAccumulator, _spatialCache, _ringCache } from './TickHandlerAOI.js'
export { PRIORITY_ENTITY_BUDGET, PRIORITY_DECAY, BANDWIDTH_BUDGET_BYTES_PER_TICK, trimEntitiesToBudget, estimateEntityBytes, getPlayerPriorityIds } from './TickHandlerAOI.js'

const INPUT_BUFFER_CATCHUP_DEPTH = 8
const STARVE_HOLD_SECONDS = 0.25
const INPUT_STEP_BANK = 16
const GAP_WAIT_MAX_TICKS = 4
const MAX_CATCHUP_STEPS_PER_TICK = 3
const PHYSICS_PLAYER_DIVISOR = 3
const PHYSICS_MAX_ACCUM_DT = 1 / 20
const SNAP_UNRELIABLE = true
const PLAYERS_PER_SNAP_GROUP = 50
const SNAP_RATE_MIN_HZ = 8
const SNAP_RATE_ADJUST_INTERVAL = 64
const AUTO_SAVE_INTERVAL = 300
const SNAP_COST_LOW_FRAC = 0.15
const SNAP_COST_HIGH_FRAC = 0.35
const SNAP_STALL_ENTER = 0.08
const SNAP_STALL_EXIT = 0.03
const SNAP_STALL_EMA_ALPHA = 0.02
const SNAP_STALL_MAX_INTERVAL = 2
const PLAYER_LOD_FULL_COUNT_THRESHOLD = 30
const BANDWIDTH_TRIM_MIN_ENTITIES = 6
const CROUCH_WIRE_BIT = 1
const SWIMMING_WIRE_BIT = 2
const DEFAULT_TICK_RATE_HZ = 60
const STATIC_MOTION_IDLE_SECONDS = 1

let _lastYaw = NaN, _lastSinHalf = 0, _lastCosHalf = 1

function createSnapState() {
  return { broadcastEntityMap: new Map(), staticEntityMap: new Map(), staticEntityIds: null, lastStaticEntries: null, staticByGroup: [], lastDynVersion: -1, prevDynCache: null, tombstoneLog: new TombstoneLog(), knownIds: null, playerLastTick: new Map(), cellEntityMaps: new Map(), cellLastTick: new Map(), playerCell: new Map() }
}

function accrueStepBudget(player, tickMs, stepsTaken) {
  const now = performance.now()
  const elapsedSteps = player.inputBudgetAt ? (now - player.inputBudgetAt) / tickMs : 1
  player.inputBudgetAt = now
  player.inputStepBudget = Math.max(-1, Math.min(INPUT_STEP_BANK, (player.inputStepBudget || 0) + elapsedSteps - stepsTaken))
}

function sequenceGapAhead(player, inputs) {
  const next = inputs[0].sequence
  return next != null && !!player.ackSequence && next > player.ackSequence + 1
}

function waitForSequenceGap(player, inputs) {
  if (!sequenceGapAhead(player, inputs)) { player.gapWaitTicks = 0; return false }
  if ((player.gapWaitTicks || 0) >= GAP_WAIT_MAX_TICKS) {
    player.gapWaitTicks = 0
    player.inputGapsSkipped = (player.inputGapsSkipped || 0) + (inputs[0].sequence - player.ackSequence - 1)
    return false
  }
  player.gapWaitTicks = (player.gapWaitTicks || 0) + 1
  return true
}

function neutralInput(last) {
  return { yaw: last.yaw || 0, pitch: last.pitch || 0, crouch: !!last.crouch, expr: last.expr || 0 }
}

function takeNextInput(player, inputs) {
  const next = inputs.shift()
  player.lastInput = next.data
  if (next.sequence != null) player.ackSequence = next.sequence
  player.hasSentInput = true
}

function stepPlayerMovement(player, deps, tick, dt, playerIdleCounts, playerAccumDt) {
  const { playerManager, physicsIntegration, applyMovement, movement } = deps
  const st = player.state
  const inp = player.lastInput || null
  if (inp) {
    const yaw = inp.yaw || 0
    if (yaw !== _lastYaw) { const half = yaw / 2; _lastSinHalf = Math.sin(half); _lastCosHalf = Math.cos(half); _lastYaw = yaw }
    st.rotation[0] = 0; st.rotation[1] = _lastSinHalf; st.rotation[2] = 0; st.rotation[3] = _lastCosHalf
    st.crouch = inp.crouch ? 1 : 0; st.lookPitch = inp.pitch || 0; st.lookYaw = yaw
    st.expr = inp.expr || 0
  }
  if (player.teleportHold && stepTeleportHold(player, physicsIntegration)) {
    playerIdleCounts.delete(player.id); playerAccumDt.delete(player.id)
    return
  }
  applyMovement(st, inp, movement, dt, playerManager.getMovementOverride?.(player.id) || null)
  if (inp) physicsIntegration.setCrouch(player.id, !!inp.crouch)
  const wishedVx = st.velocity[0], wishedVz = st.velocity[2]
  const hasInput = inp && (inp.forward || inp.backward || inp.left || inp.right || inp.jump)
  const atRest = wishedVx * wishedVx + wishedVz * wishedVz < 1e-4
  const isIdle = !hasInput && st.onGround && atRest
  const idleCount = playerIdleCounts.get(player.id) || 0
  if (isIdle && idleCount >= 1) { playerIdleCounts.set(player.id, idleCount + 1); playerAccumDt.delete(player.id); return }
  const accumDt = Math.min(PHYSICS_MAX_ACCUM_DT, (playerAccumDt.get(player.id) || 0) + dt)
  if (hasInput || !atRest || !st.onGround || (tick + player.id) % PHYSICS_PLAYER_DIVISOR === 0) {
    physicsIntegration.updatePlayerPhysics(player.id, st, accumDt); st.velocity[0] = wishedVx; st.velocity[2] = wishedVz; playerAccumDt.delete(player.id)
  } else { playerAccumDt.set(player.id, accumDt) }
  playerIdleCounts.set(player.id, isIdle ? idleCount + 1 : 0)
}

function processPlayerMovement(players, deps, tick, dt, playerIdleCounts, playerAccumDt, explicitInputs = null) {
  const { playerManager } = deps
  for (const player of players) {
    const inputs = playerManager.getInputs(player.id)
    if (explicitInputs) {
      player.lastInput = explicitInputs.get(player.id) ?? null
      stepPlayerMovement(player, deps, tick, dt, playerIdleCounts, playerAccumDt)
      recordPlayerTick(player, deps, tick)
      continue
    }
    let holdForInput = false
    if (inputs.length > 0 && !waitForSequenceGap(player, inputs)) { takeNextInput(player, inputs); player.starvedTicks = 0 }
    else if (player.hasSentInput) {
      player.inputStarves = (player.inputStarves || 0) + 1
      player.starvedTicks = (player.starvedTicks || 0) + 1
      holdForInput = player.starvedTicks <= deps.starveHoldTicks
      if (!holdForInput && player.lastInput) player.lastInput = neutralInput(player.lastInput)
    }
    if (!holdForInput) stepPlayerMovement(player, deps, tick, dt, playerIdleCounts, playerAccumDt)
    accrueStepBudget(player, deps.tickMs, holdForInput ? 0 : 1)
    let extra = 0
    while (inputs.length > INPUT_BUFFER_CATCHUP_DEPTH && extra < MAX_CATCHUP_STEPS_PER_TICK && player.inputStepBudget >= 1 && !sequenceGapAhead(player, inputs)) {
      takeNextInput(player, inputs)
      player.inputStepBudget -= 1
      player.inputCatchUps = (player.inputCatchUps || 0) + 1
      stepPlayerMovement(player, deps, tick, dt, playerIdleCounts, playerAccumDt)
      extra++
    }
    player.inputBufferDepth = inputs.length
    recordPlayerTick(player, deps, tick)
  }
}

function recordPlayerTick(player, deps, tick) {
  const { lagCompensator, networkState, movement, eventLog, transformRingWriter } = deps
  const st = player.state
  if (enforceMovementEnvelope(st, movement)) {
    eventLog?.record('anticheat_envelope_clamp', { playerId: player.id, position: [...st.position] }, { actor: player.id, reason: 'movement_envelope' })
  }
  lagCompensator.recordPlayerPosition(player.id, st.position, st.rotation, st.velocity, tick)
  const crouchFlags = (st.crouch ? CROUCH_WIRE_BIT : 0) | (st.swimming ? SWIMMING_WIRE_BIT : 0)
  networkState.updatePlayer(player.id, st.position, st.rotation, st.velocity, st.onGround, st.health, player.ackSequence ?? player.inputSequence, crouchFlags, st.lookPitch||0, st.lookYaw||0, st.expr||0, st.weapon||0, player.inputBufferDepth || 0, st.groundNormal || null, st.wallNormals || null)
  if (transformRingWriter) transformRingWriter.write(player.id, st.position, st.rotation, st.velocity)
}


const _playersByIdScratch = new Map()
const _packWrapper = { type: MSG.SNAPSHOT, payload: null }
const _packPayload = { seq: 0, tick: 0, serverTime: 0, players: null, entities: null, removed: undefined, delta: 1, dots: undefined, me: undefined, chartEpoch: 0 }

function packSnapshot(seq, encoded, me, chartEpoch) {
  _packPayload.seq = seq; _packPayload.tick = encoded.tick; _packPayload.serverTime = encoded.serverTime
  _packPayload.players = encoded.players; _packPayload.entities = encoded.entities
  _packPayload.removed = encoded.removed; _packPayload.delta = encoded.delta
  _packPayload.dots = encoded.dots
  _packPayload.me = me
  _packPayload.chartEpoch = chartEpoch
  _packWrapper.payload = _packPayload
  const buf = pack(_packWrapper)
  recordSnapshotBytes(buf.length)
  return buf
}

function resolvePlayerCell(viewerPos, planetRadius, relevanceRadius) {
  if (planetRadius > 0) {
    const c = worldToCell(viewerPos[0], viewerPos[1], viewerPos[2], planetRadius, relevanceRadius)
    const cellsPerFace = Math.ceil((2 * planetRadius) / relevanceRadius)
    return { cellKey: packCellKey(c.face, c.cx, c.cy, cellsPerFace), cellFace: c.face, cellCx: c.cx, cellCy: c.cy, cellsPerFace }
  }
  const cx = Math.floor(viewerPos[0] / relevanceRadius), cz = Math.floor(viewerPos[2] / relevanceRadius)
  return { cellKey: (cx * 65536 + cz) | 0, cellFace: -1, cellCx: 0, cellCy: 0, cellsPerFace: 0 }
}

function restoreTrimmedBaselines(sent, kept, staticCount, entityMap, prevMap) {
  const keptIds = new Set()
  for (let i = staticCount; i < kept.length; i++) keptIds.add(kept[i][0])
  for (let i = staticCount; i < sent.length; i++) {
    const id = sent[i][0]
    if (keptIds.has(id)) continue
    const prev = prevMap.get(id)
    if (prev) entityMap.set(id, prev); else entityMap.delete(id)
  }
}

const _playerCellScratch = new Map()
const _cellViewersScratch = new Map()
const _cellShareCache = new Map()

const _servedScratch = []

function selectServedPlayers(players, snapGroups, curGroup, serveAll) {
  _servedScratch.length = 0
  for (let i = 0; i < players.length; i++) if (serveAll || i % snapGroups === curGroup) _servedScratch.push(players[i])
  return _servedScratch
}

function groupPlayersByCell(served, planetRadius, relevanceRadius) {
  _playerCellScratch.clear(); _cellViewersScratch.clear()
  for (const player of served) {
    const p = player.state.position
    const cell = resolvePlayerCell(p, planetRadius, relevanceRadius)
    _playerCellScratch.set(player.id, cell)
    let viewers = _cellViewersScratch.get(cell.cellKey)
    if (!viewers) { viewers = []; _cellViewersScratch.set(cell.cellKey, viewers) }
    viewers.push(p[0], p[1], p[2])
  }
}

function buildAndSendSnapshots(players, appRuntime, deps, tick, snapshotSeq, isKeyframe, state, serverNow) {
  const { connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps } = deps
  const chartEpoch = deps.getChartEpoch()
  const playerSnap = networkState.getSnapshot()
  const playerCount = players.length
  const snapGroups = Math.max(1, Math.ceil(playerCount / PLAYERS_PER_SNAP_GROUP))
  const curGroup = snapshotSeq % snapGroups
  const clientSeq = Math.floor(snapshotSeq / snapGroups)
  const activeStage = stageLoader ? stageLoader.getActiveStage() : null
  const relevanceRadius = activeStage ? activeStage.spatial.relevanceRadius : (getRelevanceRadius ? getRelevanceRadius() : 0)
  const planetRadius = activeStage ? (activeStage.spatial.planetRadius || 0) : 0

  if (relevanceRadius > 0) {
    appRuntime.trackStaticMotion(Math.max(1, deps.getSnapshotHz ? deps.getSnapshotHz() : 20) * STATIC_MOTION_IDLE_SECONDS)
    const curStaticVersion = appRuntime._staticVersion
    const curStaticCustomSum = appRuntime.getStaticCustomVersionSum ? appRuntime.getStaticCustomVersionSum() : 0
    let activeStaticEntries = null
    if (state.staticByGroup.length !== snapGroups) state.staticByGroup = Array.from({ length: snapGroups }, () => ({ staticEntityMap: new Map(), lastStaticVersion: -1, lastStaticCustomSum: -1 }))
    const curGroupStatic = state.staticByGroup[curGroup]
    if (isKeyframe || curStaticVersion !== curGroupStatic.lastStaticVersion || curStaticCustomSum !== curGroupStatic.lastStaticCustomSum) {
      const staticSnap = appRuntime.getStaticSnapshot()
      const prevStaticMap = isKeyframe ? new Map() : curGroupStatic.staticEntityMap
      const { staticEntries, changedEntries, staticMap, staticChanged } = SnapshotEncoder.encodeStaticEntities(staticSnap.entities, prevStaticMap)
      state.lastStaticEntries = staticEntries
      if (staticChanged || isKeyframe) { state.staticEntityMap = staticMap; state.staticEntityIds = SnapshotEncoder.buildStaticIds(staticMap); curGroupStatic.staticEntityMap = staticMap; activeStaticEntries = isKeyframe ? staticEntries : changedEntries }
      curGroupStatic.lastStaticVersion = curStaticVersion
      curGroupStatic.lastStaticCustomSum = curStaticCustomSum
    }
    if (isKeyframe || curStaticVersion !== state.lastDynVersion) { state.prevDynCache = null; state.lastDynVersion = curStaticVersion }
    if (isKeyframe) { state.knownIds = null; state.playerLastTick.clear() }
    const allEncodedPlayers = SnapshotEncoder.encodePlayersOnce(playerSnap.players)
    const playersById = _playersByIdScratch; playersById.clear()
    for (const p of playerSnap.players) playersById.set(p.id, p)
    const snapshotHz = (deps.getSnapshotHz ? deps.getSnapshotHz() : 20) / snapGroups
    const reducedTickMod = Math.max(1, Math.round(snapshotHz / PLAYER_LOD_REDUCED_HZ))
    _spatialCache.clear()
    _ringCache.clear()
    _cellShareCache.clear()
    let dynCache = null
    let unmanagedIds = null
    const served = selectServedPlayers(players, snapGroups, curGroup, false)
    groupPlayersByCell(served, planetRadius, relevanceRadius)
    for (const player of served) {
      if (dynCache === null) {
        const activeIds = appRuntime.getActiveDynamicIds()
        unmanagedIds = appRuntime.getUnmanagedDynamicIds()
        if (state.prevDynCache === null) { state.prevDynCache = SnapshotEncoder.buildDynamicCache(activeIds, appRuntime.getSleepingDynamicIds(), appRuntime.getSuspendedEntityIds(), appRuntime.entities, state.prevDynCache, unmanagedIds) }
        else { SnapshotEncoder.refreshDynamicCache(state.prevDynCache, activeIds, appRuntime.entities, appRuntime.getSleepingDynamicIds(), appRuntime.getSuspendedEntityIds(), unmanagedIds) }
        dynCache = state.prevDynCache
        state.knownIds = updateTombstones(state.tombstoneLog, tick, dynCache, state.staticEntityIds, state.knownIds)
      }
      const isNewPlayer = !playerEntityMaps.has(player.id)
      const viewerPos = player.state.position
      const { cellKey, cellFace, cellCx, cellCy, cellsPerFace } = _playerCellScratch.get(player.id)
      let cached = _cellShareCache.get(cellKey)
      if (!cached) { cached = {}; _cellShareCache.set(cellKey, cached) }
      const nearbyPlayerIds = appRuntime.nearbyPlayerIds(viewerPos, relevanceRadius)
      let preEncodedPlayers, playerDots, isTiered = false, isFreshToCell = false
      if (nearbyPlayerIds.length > PLAYER_LOD_FULL_COUNT_THRESHOLD) {
        isTiered = true
        const tiered = filterEncodedPlayersTiered(allEncodedPlayers, playersById, nearbyPlayerIds, player.id, viewerPos, clientSeq, reducedTickMod)
        preEncodedPlayers = tiered.players; playerDots = tiered.dots.length ? tiered.dots : undefined
      } else {
        preEncodedPlayers = SnapshotEncoder.filterEncodedPlayersWithSelf(allEncodedPlayers, nearbyPlayerIds, player.id)
      }
      const scratch = deps.getPlayerScratch(player.id)
      const prevPlayerMap = isNewPlayer ? new Map() : playerEntityMaps.get(player.id)
      const ring = computeRingRelevantIds(cellKey, cellFace, cellCx, cellCy, cellsPerFace, planetRadius, relevanceRadius, appRuntime)
      const useSharedCell = ring.relevantIds.size <= PRIORITY_ENTITY_BUDGET
      let encoded, entityMap
      if (useSharedCell) {
        let cellMap = state.cellEntityMaps.get(cellKey)
        if (!cellMap) { cellMap = new Map(); state.cellEntityMaps.set(cellKey, cellMap) }
        let shared = cached.sharedEncode
        if (!shared || shared.tick !== tick) {
          let relevantIds = ring.relevantIds
          if (unmanagedIds && unmanagedIds.length) {
            const relSet = relevantIds === ring.relevantIds ? new Set(relevantIds) : relevantIds
            for (const id of unmanagedIds) relSet.add(id)
            relevantIds = relSet
          }
          const cellLastTick = state.cellLastTick.get(cellKey) || 0
          const r = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverNow, dynCache, relevantIds, cellMap, [], activeStaticEntries, state.staticEntityMap, state.staticEntityIds, clientSeq, _cellViewersScratch.get(cellKey), null, state.tombstoneLog, cellLastTick, snapshotHz)
          shared = { tick, entities: r.encoded.entities, removed: r.encoded.removed, entityMap: r.entityMap }
          r.entityMap._cellShared = true
          cached.sharedEncode = shared
          state.cellEntityMaps.set(cellKey, r.entityMap)
          state.cellLastTick.set(cellKey, tick)
        }
        isFreshToCell = state.playerCell.get(player.id) !== cellKey
        entityMap = isFreshToCell ? new Map(shared.entityMap) : shared.entityMap
        if (isFreshToCell) {
          let full = cached.sharedFull
          if (!full || full.tick !== tick) {
            const dynEntities = Array.from(shared.entityMap.values()).map(v => v[3]).filter(Boolean)
            const staticEnts = state.lastStaticEntries || []
            full = { tick, entities: staticEnts.map(se => se.enc).concat(dynEntities) }
            cached.sharedFull = full
          }
          encoded = { tick: playerSnap.tick || 0, serverTime: serverNow, players: preEncodedPlayers || [], entities: full.entities, removed: undefined, delta: 1 }
        } else {
          encoded = { tick: playerSnap.tick || 0, serverTime: serverNow, players: preEncodedPlayers || [], entities: shared.entities, removed: shared.removed, delta: 1 }
        }
        state.playerCell.set(player.id, cellKey)
      } else {
        let relevantIds = getPlayerPriorityIds(player.id, ring.relevantIds, dynCache, viewerPos, tick)
        if (unmanagedIds && unmanagedIds.length) {
          const relSet = relevantIds instanceof Set ? relevantIds : new Set(relevantIds)
          for (const id of unmanagedIds) relSet.add(id)
          relevantIds = relSet
        }
        const clientLastTick = isNewPlayer ? 0 : (state.playerLastTick.get(player.id) || 0)
        const staticEntriesForCall = isNewPlayer ? state.lastStaticEntries : activeStaticEntries
        const r = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverNow, dynCache, relevantIds, prevPlayerMap, preEncodedPlayers, staticEntriesForCall, state.staticEntityMap, state.staticEntityIds, clientSeq, viewerPos, scratch, state.tombstoneLog, clientLastTick, snapshotHz)
        encoded = r.encoded; entityMap = r.entityMap
        scratch.spareMap = prevPlayerMap._cellShared ? new Map() : prevPlayerMap
        state.playerCell.delete(player.id)
        const staticCountForTrim = staticEntriesForCall ? staticEntriesForCall.length : 0
        if (encoded.entities.length - staticCountForTrim >= BANDWIDTH_TRIM_MIN_ENTITIES) {
          const trim = trimEntitiesToBudget(encoded.entities, staticCountForTrim, viewerPos, dynCache)
          if (trim.trimmedCount > 0) {
            restoreTrimmedBaselines(encoded.entities, trim.entities, staticCountForTrim, entityMap, prevPlayerMap)
            encoded.entities = trim.entities
          }
        }
      }
      if (playerDots) encoded.dots = playerDots
      state.playerLastTick.set(player.id, tick)
      playerEntityMaps.set(player.id, entityMap)
      connections.sendPacked(player.id, packSnapshot(snapshotSeq, encoded, encodeSelfBlock(playersById.get(player.id)), chartEpoch), SNAP_UNRELIABLE, MSG.SNAPSHOT)
    }
    if (dynCache !== null && (state.playerLastTick.size > 0 || state.cellLastTick.size > 0)) {
      let minTick = tick
      for (const t of state.playerLastTick.values()) { if (t < minTick) minTick = t }
      for (const t of state.cellLastTick.values()) { if (t < minTick) minTick = t }
      state.tombstoneLog.pruneBefore(minTick)
      if (state.cellLastTick.size > 0) {
        const liveCells = new Set(state.playerCell.values())
        for (const key of state.cellLastTick.keys()) {
          if (!liveCells.has(key)) { state.cellLastTick.delete(key); state.cellEntityMaps.delete(key) }
        }
      }
      if ((snapshotSeq & 63) === 0) {
        appRuntime._playerIndex?.pruneIdleKeys?.(_spatialCache)
        appRuntime._stageLoader?._activeStage?.spatial?.pruneIdleKeys?.(_spatialCache)
      }
    }
  } else {
    const entitySnap = appRuntime.getSnapshot()
    const combined = { tick: playerSnap.tick, players: playerSnap.players, entities: entitySnap.entities, serverTime: serverNow }
    const prevMap = (isKeyframe || state.broadcastEntityMap.size === 0) ? new Map() : state.broadcastEntityMap
    const { encoded, entityMap } = SnapshotEncoder.encodeDelta(combined, prevMap)
    state.broadcastEntityMap = entityMap
    const selfById = _playersByIdScratch; selfById.clear()
    for (const p of playerSnap.players) selfById.set(p.id, p)
    for (const player of selectServedPlayers(players, snapGroups, curGroup, isKeyframe)) {
      connections.sendPacked(player.id, packSnapshot(snapshotSeq, encoded, encodeSelfBlock(selfById.get(player.id)), chartEpoch), SNAP_UNRELIABLE, MSG.SNAPSHOT)
    }
  }
}

export function createTickHandler(deps) {
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: m = {}, stageLoader, getRelevanceRadius, _movement, tickRate = DEFAULT_TICK_RATE_HZ, getWorldTimeOfDayConfig, getWorldWeatherConfig } = deps
  const serverTimeOfDay = createServerTimeOfDay(getWorldTimeOfDayConfig)
  const serverWeather = createServerWeather(getWorldWeatherConfig)
  const KEYFRAME_INTERVAL = tickRate * 10
  let _snapshotInterval = 1
  let _snapRateAdjustTick = 0
  let _lastSnapRate = tickRate
  const _PROFILE = deps.enableProfiling || (typeof process !== 'undefined' && process.env?.SPOINT_TICK_PROFILE === '1')
  const applyMovement = _movement?.applyMovement || _applyMovement
  const DEFAULT_MOVEMENT = _movement?.DEFAULT_MOVEMENT || _DEFAULT_MOVEMENT
  const movement = { ...DEFAULT_MOVEMENT, ...m }
  const mvDeps = { playerManager, physicsIntegration, lagCompensator, networkState, applyMovement, movement, eventLog: deps.eventLog, transformRingWriter: deps.transformRingWriter || null, starveHoldTicks: Math.max(1, Math.round(tickRate * STARVE_HOLD_SECONDS)), tickMs: 1000 / tickRate }
  const playerScratch = new Map()
  function getPlayerScratch(id) {
    let s = playerScratch.get(id)
    if (!s) { s = { entities: [], removed: [], spareMap: new Map() }; playerScratch.set(id, s) }
    return s
  }
  const snapDeps = { getChartEpoch: () => currentChartEpoch(physics), connections, stageLoader, getRelevanceRadius, networkState, playerEntityMaps: new Map(), playerScratch, getPlayerScratch, getSnapshotHz: () => _lastSnapRate }
  let snapState = createSnapState()
  let forceKeyframe = false
  const playerIdleCounts = new Map(), playerAccumDt = new Map()
  const grid = new Map(), gridCells = new Map()
  const collisionTiles = createCollisionTileStreamer({ physics, physicsIntegration, connections, getNetcodeConfig: deps.getNetcodeConfig })
  let snapshotSeq = 0, profileLog = 0, profileSum = 0, profileSumSnap = 0, profileSumPhys = 0, profileSumMv = 0, profileCount = 0
  let _lastBudgetWarnMs = 0

  let _snapCostEmaMs = 0
  const SNAP_COST_EMA_ALPHA = 0.2
  let _stallEma = 0
  let _stallInterval = 1

  function _configuredSnapshotHz() {
    const hz = deps.getNetcodeConfig?.()?.snapshotRate
    return Number.isFinite(hz) && hz > 0 ? Math.min(tickRate, hz) : tickRate
  }

  function _updateStallInterval(players) {
    if (deps.getNetcodeConfig?.()?.adaptiveSnapshotRate === false) { _stallEma = 0; _stallInterval = 1; return }
    if (!players.length) return
    let starved = 0
    for (const player of players) if ((player.starvedTicks || 0) > 0) starved++
    _stallEma += (starved / players.length - _stallEma) * SNAP_STALL_EMA_ALPHA
    if (_stallEma > SNAP_STALL_ENTER) _stallInterval = Math.min(SNAP_STALL_MAX_INTERVAL, _stallInterval + 1)
    else if (_stallEma < SNAP_STALL_EXIT) _stallInterval = Math.max(1, _stallInterval - 1)
  }

  function _computeSnapshotInterval() {
    let targetHz = _configuredSnapshotHz()
    const tickBudgetMs = 1000 / tickRate
    if (_snapCostEmaMs > tickBudgetMs * SNAP_COST_HIGH_FRAC) targetHz = targetHz * 0.5
    else if (_snapCostEmaMs > tickBudgetMs * SNAP_COST_LOW_FRAC) targetHz = targetHz * 0.75
    const base = Math.max(1, Math.round(tickRate / Math.max(SNAP_RATE_MIN_HZ, targetHz)))
    const maxInterval = Math.max(1, Math.round(tickRate / SNAP_RATE_MIN_HZ))
    return Math.min(maxInterval, Math.max(1, base * _stallInterval))
  }

  function invalidateChartLocalSnapshotState() {
    snapDeps.playerEntityMaps.clear()
    playerScratch.clear()
    snapState = createSnapState()
    forceKeyframe = true
    for (const player of playerManager.getConnectedPlayers()) collisionTiles.reset(player.id)
  }

  function announceChartReanchor(event, tick) {
    if (!connections) return
    for (const clientId of [...connections.clients.keys()]) {
      const ackSeq = playerManager.getPlayer(clientId)?.ackSequence ?? 0
      connections.send(clientId, MSG.CHART_REANCHOR, createChartReanchorMessage(event, tick, ackSeq))
    }
  }

  function stepChartReanchor(tick) {
    const service = physics._terrainStreamer?.chartReanchor
    if (!service) return
    const event = service.step()
    if (!event) return
    invalidateChartLocalSnapshotState()
    announceChartReanchor(event, tick)
    deps.onChartReanchor?.(event)
  }

  function simulateTick(tick, dt, players, explicitInputs = null) {
    processPlayerMovement(players, mvDeps, tick, dt, playerIdleCounts, playerAccumDt, explicitInputs)
    const cellSz = physicsIntegration.config.capsuleRadius * 8, minDist = physicsIntegration.config.capsuleRadius * 2
    applyPlayerCollisions(players, grid, gridCells, cellSz, minDist * minDist, minDist, dt, physicsIntegration)
    if (typeof physics.drainBodyQueue === 'function') physics.drainBodyQueue()
    if (explicitInputs === null) stepChartReanchor(tick)
    physics.step(dt)
    appRuntime.tick(tick, dt)
  }

  function onTick(tick, dt, explicitInputs = null) {
    const t0 = performance.now()
    const serverNow = Date.now()
    networkState.setTick(tick, serverNow)
    const players = playerManager.getConnectedPlayers()

    _updateStallInterval(players)
    if (tick - _snapRateAdjustTick >= SNAP_RATE_ADJUST_INTERVAL) {
      _snapRateAdjustTick = tick
      _snapshotInterval = _computeSnapshotInterval()
      if (players.length > 0 && connections) {
        _lastSnapRate = Math.round(tickRate / _snapshotInterval)
        connections.emit('snapshot-rate', { rate: _lastSnapRate, tick, interval: _snapshotInterval })
      }
    }

    const t1pre = performance.now()
    simulateTick(tick, dt, players, explicitInputs)
    if (connections) collisionTiles.tick(tick, players)
    const t4 = performance.now()
    const t1 = t1pre, t2 = t1pre, t3 = t4
    if (players.length > 0 && tick % _snapshotInterval === 0) {
      snapshotSeq++
      buildAndSendSnapshots(players, appRuntime, snapDeps, tick, snapshotSeq, forceKeyframe || snapshotSeq % KEYFRAME_INTERVAL === 0, snapState, serverNow)
      forceKeyframe = false
      const _snapCostMs = performance.now() - t4
      _snapCostEmaMs = _snapCostEmaMs === 0 ? _snapCostMs : (_snapCostEmaMs * (1 - SNAP_COST_EMA_ALPHA) + _snapCostMs * SNAP_COST_EMA_ALPHA)
    }
    if (players.length > 0 && tick % tickRate === 0) {
      const rttTable = {}, pubkeys = {}
      for (const p of players) {
        const c = connections.getClient(p.id)
        if (!c) continue
        if (c.rtt != null) rttTable[p.id] = c.rtt
        if (c.peerPubkey) pubkeys[p.id] = c.peerPubkey
      }
      connections.broadcast(MSG.PEER_RTT_TABLE, { rtt: rttTable, pubkeys })
    }
    serverTimeOfDay.tick(dt)
    if (players.length > 0 && serverTimeOfDay.shouldBroadcast()) {
      connections.broadcast(MSG.TIME_OF_DAY_SYNC, serverTimeOfDay.getSyncPayload())
    }
    if (players.length > 0 && serverWeather.shouldBroadcast()) {
      connections.broadcast(MSG.WEATHER_SYNC, serverWeather.getSyncPayload())
    }
    if (tick % (tickRate * AUTO_SAVE_INTERVAL) === 0 && tick > 0) {
      try { deps.onAutoSave?.() } catch (_) {}
    }
    for (const id of snapDeps.playerEntityMaps.keys()) { if (!playerManager.getPlayer(id)) { snapDeps.playerEntityMaps.delete(id); playerIdleCounts.delete(id); playerAccumDt.delete(id); clearPlayerPriorityAccumulator(id); playerScratch.delete(id); snapState.playerLastTick.delete(id); snapState.playerCell.delete(id) } }
    const t5 = performance.now()
    try { appRuntime._drainReloadQueue() } catch (e) { console.error('[TickHandler] reload queue error:', e.message) }
    if (players.length > 0) {
      profileSum += t5-t0; profileSumSnap += t5-t4; profileSumPhys += t3-t2; profileSumMv += t1-t0; profileCount++
      recordTickPhase('total', t5-t0); recordTickPhase('mv', t1-t0); recordTickPhase('phys', t3-t2); recordTickPhase('snap', t5-t4)
    }
    const tickBudgetMs = 1000 / tickRate
    if (t5 - t0 > tickBudgetMs * 2 && serverNow - _lastBudgetWarnMs > 1000) {
      _lastBudgetWarnMs = serverNow
      console.warn(`[TickHandler] tick ${tick} overran budget: ${(t5-t0).toFixed(2)}ms > ${(tickBudgetMs*2).toFixed(2)}ms (budget ${tickBudgetMs.toFixed(2)}ms) players:${players.length}`)
    }
    if (_PROFILE && ++profileLog % KEYFRAME_INTERVAL === 0) {
      const total=t5-t0, mem=typeof process!=='undefined'?process.memoryUsage():{heapUsed:0,rss:0,external:0,arrayBuffers:0}, avg=n => profileCount>0?(n/profileCount).toFixed(2):'0'
      const mb=n=>(n/1048576).toFixed(1)
      const dynIds=appRuntime._dynamicEntityIds?.size||0, activeDyn=appRuntime.getActiveDynamicIds()?.size||0
      const avgTotal=avg(profileSum),avgSnap=avg(profileSumSnap),avgPhys=avg(profileSumPhys),avgMv=avg(profileSumMv)
      profileSum=0; profileSumSnap=0; profileSumPhys=0; profileSumMv=0; profileCount=0
      let idleSkipped = 0; if (players.length > 0) for (const c of playerIdleCounts.values()) if (c >= 2) idleSkipped++
      const physSkipped = players.length > 0 ? playerAccumDt.size : 0
      try { console.log(`[tick-profile] tick:${tick} players:${players.length} idle:${idleSkipped} physSkip:${physSkipped} entities:${appRuntime.entities.size} dynIds:${dynIds} activeDyn:${activeDyn} total:${total.toFixed(2)}ms(avg:${avgTotal}) | mv:${(t1-t0).toFixed(2)}(avg:${avgMv}) col:${(t2-t1).toFixed(2)} phys:${(t3-t2).toFixed(2)}(avg:${avgPhys}) app:${(t4-t3).toFixed(2)} sync:${(appRuntime._lastSyncMs||0).toFixed(2)} respawn:${(appRuntime._lastRespawnMs||0).toFixed(2)} spatial:${(appRuntime._lastSpatialMs||0).toFixed(2)} col2:${(appRuntime._lastCollisionMs||0).toFixed(2)} int:${(appRuntime._lastInteractMs||0).toFixed(2)} snap:${(t5-t4).toFixed(2)}(avg:${avgSnap}) | heap:${mb(mem.heapUsed)}MB rss:${mb(mem.rss)}MB ext:${mb(mem.external)}MB ab:${mb(mem.arrayBuffers)}MB`) } catch (_) {}
    }
  }

  onTick.serverTimeOfDay = serverTimeOfDay
  onTick.getMetrics = () => ({
    avgTotalMs: profileCount > 0 ? profileSum / profileCount : 0,
    avgMvMs: profileCount > 0 ? profileSumMv / profileCount : 0,
    avgPhysMs: profileCount > 0 ? profileSumPhys / profileCount : 0,
    avgSnapMs: profileCount > 0 ? profileSumSnap / profileCount : 0,
    sampleCount: profileCount,
  })
  onTick.simulateTick = simulateTick
  onTick.snapshotSimState = () => ({ playerIdleCounts: new Map(playerIdleCounts), playerAccumDt: new Map(playerAccumDt) })
  onTick.restoreSimState = (s) => {
    if (!s) return
    playerIdleCounts.clear(); for (const [k, v] of s.playerIdleCounts) playerIdleCounts.set(k, v)
    playerAccumDt.clear(); for (const [k, v] of s.playerAccumDt) playerAccumDt.set(k, v)
  }
  onTick.serverWeather = serverWeather
  onTick.collisionTiles = collisionTiles
  return onTick
}
