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

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

let ctx = null
let regionId = null
let cellSize = DEFAULT_CELL_SIZE
let ghostMargin = DEFAULT_GHOST_MARGIN
const transports = new Map()
const lastRegionForPlayer = new Map()

function send(msg) {
  process.send(msg)
}

async function init({ region, worldDef, cellSize: cs, ghostMargin: gm, port }) {
  await ensurePacked
  regionId = region
  cellSize = cs || DEFAULT_CELL_SIZE
  ghostMargin = gm != null ? gm : DEFAULT_GHOST_MARGIN
  const tickRate = worldDef.tickRate || 60
  const localApps = join(process.cwd(), 'apps'), sdkApps = join(SDK_ROOT, 'apps')
  const appsDirs = existsSync(localApps) ? [localApps, sdkApps] : [sdkApps]
  const config = {
    port: port || 0, tickRate, appsDirs, sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0,
    entityTickRate: worldDef.entityTickRate,
    staticDirs: buildStaticDirs(SDK_ROOT, process.cwd(), appsDirs)
  }
  const deps = await createServerDeps(config, tickRate)
  ctx = {
    config, port: config.port, tickRate, appsDirs, gravity: config.gravity || [0, -9.81, 0],
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
  ctx.worldSpawnPoint = ctx.worldSpawnPoints?.[0] || worldDef.spawnPoint || [0, 5, 0]
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
  ctx.physicsIntegration.addPlayerCollider(newId, playerConfig.capsuleRadius || 0.4)
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

process.on('message', async (msg) => {
  try {
    if (msg.type === 'INIT') { await init(msg); return }
    if (!ctx) return
    if (msg.type === 'CLIENT_CONNECT') {
      const transport = new RegionIPCTransport(msg.playerId, send)
      transports.set(msg.playerId, transport)
      ctx.onClientConnect(transport)
      const localId = [...ctx.playerManager.players.keys()].pop()
      lastRegionForPlayer.set(localId, regionId)
      send({ type: 'CLIENT_CONNECTED', region: regionId, requestId: msg.requestId, localPlayerId: localId })
      return
    }
    if (msg.type === 'CLIENT_FRAME') {
      const t = transports.get(msg.playerId)
      if (t) t.deliver(msg.dataB64)
      return
    }
    if (msg.type === 'CLIENT_DISCONNECT') {
      const t = transports.get(msg.playerId)
      if (t) t.close()
      transports.delete(msg.playerId)
      return
    }
    if (msg.type === 'ACCEPT_HANDOFF') { acceptHandoff(msg); return }
    if (msg.type === '__WITNESS_FORCE_POSITION') {
      const player = ctx.playerManager.getPlayer(msg.playerId)
      if (player && Array.isArray(msg.position) && msg.position.length === 3) {
        player.state.position = [...msg.position]
        ctx.physicsIntegration.setPlayerPosition(msg.playerId, msg.position)
      }
      return
    }
    if (msg.type === 'COMPLETE_HANDOFF_OUT') { completeHandoffOut(msg.playerId); return }
    if (msg.type === 'EVENT_REPLICATE_IN') { applyReplicatedEvent(msg); return }
    if (msg.type === '__WITNESS_RECORD_EVENT') {
      const event = ctx.eventLog?.record(msg.eventType, msg.data, msg.meta || {})
      send({ type: '__WITNESS_RECORD_EVENT_ACK', requestId: msg.requestId, event })
      return
    }
    if (msg.type === '__WITNESS_QUERY_EVENTLOG') {
      const events = ctx.eventLog?.query({ type: msg.filterType }) || []
      send({ type: '__WITNESS_QUERY_EVENTLOG_ACK', requestId: msg.requestId, events })
      return
    }
    if (msg.type === 'STATS_REQUEST') {
      send({
        type: 'STATS', region: regionId, requestId: msg.requestId,
        players: ctx.playerManager.getPlayerCount(), entities: ctx.appRuntime.entities.size,
        tick: ctx.tickSystem.currentTick
      })
      return
    }
  } catch (e) {
    console.error(`[region-worker ${regionId || '?'}] message handler error (${msg?.type}):`, e?.stack || e?.message || e)
  }
})

send({ type: 'WORKER_BOOTING', pid: process.pid })
