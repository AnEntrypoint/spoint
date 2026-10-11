import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MSG } from '../protocol/MessageTypes.js'
import { ensurePacked, WIRE_STRUCT_HASH } from '../protocol/msgpack.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createServerDeps, wireServerHandlers, buildStaticDirs } from '../sdk/server.js'
import { RegionIPCTransport } from './RegionIPCTransport.js'
import {
  regionBoundsWithGhost, authoritativeRegionFor, DEFAULT_CELL_SIZE, DEFAULT_GHOST_MARGIN
} from './RegionGrid.js'
import { worldTickRate, DEFAULT_GRAVITY, DEFAULT_SPAWN_POINT, playerDefault } from '../shared/worldDefaults.js'
import { resolveAppsDirs } from '../sdk/ServerBoot.js'
import {
  dispatchMessage, errorRefusal, messageTable, refusalText, WORKER_NOT_INITIALIZED, WORKER_REFUSED
} from './ShardingRefusal.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

let ctx = null
let regionId = null
let cellSize = DEFAULT_CELL_SIZE
let ghostMargin = DEFAULT_GHOST_MARGIN
const transports = new Map()
const lastRegionForPlayer = new Map()

function send(msg, flushCallback) {
  process.send(msg, flushCallback)
}

async function init({ region, worldDef, cellSize: cs, ghostMargin: gm, port }) {
  await ensurePacked
  regionId = region
  cellSize = cs || DEFAULT_CELL_SIZE
  ghostMargin = gm != null ? gm : DEFAULT_GHOST_MARGIN
  const tickRate = worldTickRate(worldDef)
  const appsDirs = resolveAppsDirs(process.cwd(), SDK_ROOT)
  const config = {
    port: port || 0, tickRate, appsDirs, sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0,
    entityTickRate: worldDef.entityTickRate,
    staticDirs: buildStaticDirs(SDK_ROOT, process.cwd(), appsDirs)
  }
  const deps = await createServerDeps(config, tickRate)
  ctx = {
    config, port: config.port, tickRate, appsDirs, gravity: config.gravity || [...DEFAULT_GRAVITY],
    movement: config.movement || {}, staticDirs: config.staticDirs, ...deps,
    currentWorldDef: null, worldSpawnPoint: [0, 5, 0], snapshotSeq: 0,
    handlerState: { fn: null },
    onTick: (tick, dt) => {
      if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt)
      deps.connections.flushAll()
      checkHandoffs()
    },
    setTickHandler: fn => { ctx.handlerState.fn = fn },
    placedModelStorage: { persist: () => {} }
  }
  if (deps._ctxRef) deps._ctxRef.current = ctx
  wireServerHandlers(ctx)
  installCrossShardEventForwarding(ctx)

  ctx.currentWorldDef = worldDef
  if (worldDef.spawnPoints?.length) ctx.worldSpawnPoints = worldDef.spawnPoints
  else if (worldDef.spawnPoint) ctx.worldSpawnPoints = [worldDef.spawnPoint]
  ctx.worldSpawnPoint = ctx.worldSpawnPoints?.[0] || worldDef.spawnPoint || [...DEFAULT_SPAWN_POINT]
  await ctx.appLoader.loadAll()
  const scopedWorldDef = {
    ...worldDef,
    entities: (worldDef.entities || []).filter(e => {
      const p = e.position
      if (!Array.isArray(p) || p.length !== 3) return true
      const gb = regionBoundsWithGhost(regionId, cellSize, ghostMargin)
      return p[0] >= gb.minX && p[0] <= gb.maxX && p[2] >= gb.minZ && p[2] <= gb.maxZ
    })
  }
  ctx.stageLoader.loadFromDefinition('main', scopedWorldDef)

  ctx.tickSystem.onTick(ctx.onTick)
  ctx.tickSystem.start()
  ctx.appLoader.watchAll()

  send({ type: 'WORKER_READY', region: regionId, pid: process.pid })
}

function installCrossShardEventForwarding(ctx) {
  if (!ctx.eventLog) return
  const originalRecord = ctx.eventLog.record.bind(ctx.eventLog)
  ctx.eventLog.record = (type, data, meta = {}) => {
    const event = originalRecord(type, data, meta)
    if (event && meta.crossShard === true) {
      send({ type: 'EVENT_REPLICATE', originRegion: regionId, event })
    }
    return event
  }
}

function applyReplicatedEvent({ originRegion, event }) {
  if (!ctx || !ctx.eventLog || originRegion === regionId) return
  ctx.eventLog.ingestRemote(event, originRegion)
}

function checkHandoffs() {
  if (!ctx) return
  for (const player of ctx.playerManager.getConnectedPlayers()) {
    const pos = player.state.position
    if (!pos) continue
    const cur = authoritativeRegionFor(pos[0], pos[2], cellSize)
    const prev = lastRegionForPlayer.get(player.id)
    if (prev === undefined) { lastRegionForPlayer.set(player.id, cur); continue }
    if (cur !== prev && cur !== regionId) {
      lastRegionForPlayer.set(player.id, cur)
      send({
        type: 'BOUNDARY_CROSSING', playerId: player.id, fromRegion: regionId, toRegion: cur,
        state: {
          position: [...player.state.position], rotation: [...player.state.rotation],
          velocity: [...player.state.velocity], health: player.state.health, name: player.name
        },
        sessionToken: ctx.connections.getClient(player.id)?.sessionToken || null
      })
    } else if (cur === regionId) {
      lastRegionForPlayer.set(player.id, cur)
    }
  }
}

function acceptHandoff({ playerId, fromRegion, state, sessionToken }) {
  const transport = new RegionIPCTransport(playerId, send)
  transports.set(playerId, transport)
  const playerConfig = ctx.currentWorldDef?.player || {}
  const newId = ctx.playerManager.addPlayer(transport, {
    position: state.position, rotation: state.rotation, velocity: state.velocity, health: state.health, name: state.name
  })
  ctx.networkState.addPlayer(newId, { position: state.position })
  ctx.physicsIntegration.addPlayerCollider(newId, playerDefault(playerConfig, 'capsuleRadius'))
  ctx.physicsIntegration.setPlayerPosition(newId, state.position)
  const client = ctx.connections.addClient(newId, transport)
  client.sessionToken = sessionToken || ctx.sessions.create(newId, ctx.playerManager.getPlayer(newId).state)
  lastRegionForPlayer.set(newId, regionId)
  ctx.connections.send(newId, MSG.RECONNECT_ACK, {
    playerId: newId, tick: ctx.tickSystem.currentTick, sessionToken: client.sessionToken,
    tickRate: ctx.tickRate, position: state.position, health: state.health, structHash: WIRE_STRUCT_HASH
  })
  const worldDefForClient = { ...ctx.currentWorldDef }
  delete worldDefForClient.entities
  ctx.connections.send(newId, MSG.WORLD_DEF, worldDefForClient)
  for (const [appName, code] of Object.entries(ctx.appLoader.getClientModules())) {
    ctx.connections.send(newId, MSG.APP_MODULE, { app: appName, code })
  }
  const snap = ctx.networkState.getSnapshot()
  const ents = ctx.appRuntime.getSnapshot()
  ctx.connections.send(newId, MSG.STATE_RECOVERY, {
    snapshot: SnapshotEncoder.encode({ tick: snap.tick, timestamp: snap.timestamp, players: snap.players, entities: ents.entities }),
    tick: ctx.tickSystem.currentTick
  })
  ctx.connections.flushAll()
  send({ type: 'HANDOFF_ACCEPTED', region: regionId, fromRegion, oldPlayerId: playerId, newLocalPlayerId: newId, sessionToken: client.sessionToken })
}

function completeHandoffOut(playerId) {
  const t = transports.get(playerId)
  if (t) { t.ready = false; transports.delete(playerId) }
  if (ctx.playerManager.getPlayer(playerId)) {
    ctx.playerManager.removePlayer(playerId)
    ctx.networkState.removePlayer(playerId)
    ctx.physicsIntegration.removePlayerCollider(playerId)
    ctx.lagCompensator.clearPlayerHistory(playerId)
  }
  lastRegionForPlayer.delete(playerId)
}

async function handleInit(msg) {
  try {
    await init(msg)
  } catch (error) {
    const refusal = errorRefusal(error)
    const region = msg?.region ?? regionId ?? null
    console.error(`[region-worker ${region || '?'}] boot refused: ${refusalText(refusal)}`)
    send({ type: WORKER_REFUSED, region, ...refusal }, () => process.exit(1))
  }
}

function handleClientConnect(msg) {
  const transport = new RegionIPCTransport(msg.playerId, send)
  transports.set(msg.playerId, transport)
  ctx.onClientConnect(transport)
  const localId = [...ctx.playerManager.players.keys()].pop()
  lastRegionForPlayer.set(localId, regionId)
  send({ type: 'CLIENT_CONNECTED', region: regionId, requestId: msg.requestId, localPlayerId: localId })
}

function handleClientFrame(msg) {
  transports.get(msg.playerId)?.deliver(msg.dataB64)
}

function handleClientDisconnect(msg) {
  transports.get(msg.playerId)?.close()
  transports.delete(msg.playerId)
}

function handleWitnessForcePosition(msg) {
  const player = ctx.playerManager.getPlayer(msg.playerId)
  if (player && Array.isArray(msg.position) && msg.position.length === 3) {
    player.state.position = [...msg.position]
    ctx.physicsIntegration.setPlayerPosition(msg.playerId, msg.position)
  }
}

function handleWitnessRecordEvent(msg) {
  const event = ctx.eventLog?.record(msg.eventType, msg.data, msg.meta || {})
  send({ type: '__WITNESS_RECORD_EVENT_ACK', requestId: msg.requestId, event })
}

function handleWitnessQueryEventLog(msg) {
  const events = ctx.eventLog?.query({ type: msg.filterType }) || []
  send({ type: '__WITNESS_QUERY_EVENTLOG_ACK', requestId: msg.requestId, events })
}

function handleStatsRequest(msg) {
  send({
    type: 'STATS', region: regionId, requestId: msg.requestId,
    players: ctx.playerManager.getPlayerCount(), entities: ctx.appRuntime.entities.size,
    tick: ctx.tickSystem.currentTick
  })
}

const HANDLERS = messageTable([
  ['INIT', handleInit],
  ['CLIENT_CONNECT', handleClientConnect],
  ['CLIENT_FRAME', handleClientFrame],
  ['CLIENT_DISCONNECT', handleClientDisconnect],
  ['ACCEPT_HANDOFF', acceptHandoff],
  ['__WITNESS_FORCE_POSITION', handleWitnessForcePosition],
  ['COMPLETE_HANDOFF_OUT', msg => completeHandoffOut(msg.playerId)],
  ['EVENT_REPLICATE_IN', applyReplicatedEvent],
  ['__WITNESS_RECORD_EVENT', handleWitnessRecordEvent],
  ['__WITNESS_QUERY_EVENTLOG', handleWitnessQueryEventLog],
  ['STATS_REQUEST', handleStatsRequest],
])

function refusalLine(region, code, type) {
  console.error(`[region-worker ${region || '?'}] refused message ${JSON.stringify(type ?? null)}: ${code}`)
}

process.on('message', (msg) => {
  if (msg?.type !== 'INIT' && !ctx) {
    refusalLine(regionId, WORKER_NOT_INITIALIZED, msg?.type)
    return
  }
  const outcome = dispatchMessage(HANDLERS, msg)
  if (!outcome.ok) {
    refusalLine(regionId, outcome.code, outcome.detail?.type)
    return
  }
  Promise.resolve(outcome.value).catch(error => {
    console.error(`[region-worker ${regionId || '?'}] message handler error (${msg?.type}):`, error?.stack || error?.message || error)
  })
})

send({ type: 'WORKER_BOOTING', pid: process.pid })
