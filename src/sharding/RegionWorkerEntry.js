// Region-shard worker: a real, independent Node child_process running its OWN Jolt physics world,
// TickSystem, PlayerManager, and full server-side app/handler stack -- scoped to one cell of the
// planet's X/Z grid (see RegionGrid.js). Spawned and owned by RegionRouter.js via child_process.fork.
//
// Reuses createServerDeps/wireServerHandlers from ../sdk/server.js -- the exact same real
// construction path a single-process server boots with -- so a region worker is not a parallel
// reimplementation of the server; it is the SAME server, just with an IPC transport standing in for
// the HTTP+WS listener (owned instead by the router) and a bounded region AABB (+ ghost margin) it
// polls each tick to detect players crossing into a neighbor's territory.
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
// playerId -> RegionIPCTransport, for every player CURRENTLY resident in this worker (owned or
// still-draining-out during a handoff).
const transports = new Map()
// playerId -> last known authoritative region computed for that player by THIS worker's own tick
// loop, used to detect a boundary crossing (see checkHandoffs below).
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
    // no local disk persistence per shard worker -- placement persistence stays router/main-world owned
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
  // Only entities whose position falls inside THIS region's ghost-expanded bounds are spawned here --
  // every other shard independently loads only ITS own slice, so the planet's entity set is
  // partitioned by region instead of duplicated N times across every worker.
  const scopedWorldDef = {
    ...worldDef,
    entities: (worldDef.entities || []).filter(e => {
      const p = e.position
      if (!Array.isArray(p) || p.length !== 3) return true // config-only/non-positioned entities load everywhere (rare; e.g. global managers)
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

// Cross-shard EventLog replication (see AGENTS.md PRD row region-sharding-cross-shard-eventlog-replication).
//
// Policy (b) -- WHICH events cross shard boundaries: opt-in only, via meta.crossShard===true on the
// record() call. This is deliberately conservative (default false/inert, matching every other opt-in
// flag in this codebase's own doctrine, e.g. ColliderStreamer's _budgetOff) rather than forwarding
// every event globally, which would flood the IPC channel with per-shard-local noise (anticheat
// envelope clamps, entity spawn/destroy churn, per-app bus events) that has no cross-shard audience.
// A game/app that wants a specific event visible across the whole planet (e.g. a world-boss kill, a
// server-wide announcement, a global leaderboard update) sets meta.crossShard:true on that specific
// eventLog.record() call; everything else stays shard-local by default, zero behavior change for
// every existing caller.
//
// Mechanism (a) -- the actual forwarding path: EventLog.record() is monkey-patched (wrapped, not
// replaced -- the original always still runs so local recording/query/replay is unaffected) to notice
// crossShard-flagged events and forward them to the router as EVENT_REPLICATE. The router (see
// RegionRouter.js _handleEventReplicate) fans that out to every OTHER ready region worker as
// EVENT_REPLICATE_IN, which this worker applies via EventLog.ingestRemote() (idempotent, see
// EventLog.js -- point (c) of the row).
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

// Router forwarded a crossShard-flagged event recorded by a SIBLING shard -- apply it to this
// worker's own EventLog so `ctx.eventLog.query()`/replay tooling running against ANY shard sees the
// full cross-shard-visible event set, not just events recorded locally. Idempotent via
// EventLog.ingestRemote (dedupes on originRegion+originId), so a router resync/retry can't
// double-apply the same event twice on this shard.
function applyReplicatedEvent({ originRegion, event }) {
  if (!ctx || !ctx.eventLog || originRegion === regionId) return
  ctx.eventLog.ingestRemote(event, originRegion)
}

// Runs once per tick, after the region's own tick handler + flush -- walks every player CURRENTLY
// resident in this worker and checks whether their authoritative region (per RegionGrid's tight,
// non-ghost cell math) has changed. A change means the player physically crossed the shard boundary
// this tick; tell the router so it can retarget future input frames to the new owner and drive the
// handoff. The ghost margin means the OLD worker keeps simulating them for `ghostMargin` world units
// past the boundary (their entity/collider is not torn down here on crossing -- only on the router's
// explicit HANDOFF_COMPLETE, once the new worker has them live) so there's no frame where neither
// shard owns the player's physics body.
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

// Router tells this (new-owner) worker to accept a player that just crossed in from a neighbor.
// Mirrors ServerHandlers.js's onClientConnect/RECONNECT flow closely (same session-token contract,
// same HANDSHAKE_ACK/WORLD_DEF/SNAPSHOT bootstrap) but seeds player state from the handoff payload
// instead of a fresh spawn point or a stored session -- the player must land exactly where they left
// off in the losing region, with velocity preserved (a teleport-reset would be an obvious seam at
// every shard boundary).
function acceptHandoff({ playerId, fromRegion, state, sessionToken }) {
  const transport = new RegionIPCTransport(playerId, send)
  transports.set(playerId, transport)
  const playerConfig = ctx.currentWorldDef?.player || {}
  const newId = ctx.playerManager.addPlayer(transport, {
    position: state.position, rotation: state.rotation, velocity: state.velocity, health: state.health, name: state.name
  })
  // addPlayer always assigns a fresh sequential id local to this worker's PlayerManager (each shard
  // has its own id space) -- the ROUTER is the single source of truth mapping a stable client-facing
  // playerId to (currentRegion, localId-in-that-region), never the workers themselves; see
  // RegionRouter.js's `_routerIdToLocal`. Tell the router the local id this worker assigned.
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

// Router confirms the handoff is fully committed (new worker has flushed the player's bootstrap
// frames) -- now safe to actually tear the player down in the LOSING region (remove collider/body,
// stop counting them toward this shard's player-count/physics budget). Until this arrives the losing
// worker keeps simulating the player inside its ghost margin, so physics never has a frame with zero
// owners.
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
      // Fresh client whose spawn point the router computed as belonging to this region -- run the
      // exact same bootstrap ServerHandlers.js's onClientConnect runs, via a real IPC transport.
      const transport = new RegionIPCTransport(msg.playerId, send)
      transports.set(msg.playerId, transport)
      ctx.onClientConnect(transport)
      // onClientConnect assigns ITS OWN local playerId (ctx.playerManager.addPlayer) -- tell the
      // router what local id got assigned for this router-facing connection request.
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
    // Ops/debug direct position override -- sets a resident player's authoritative position without
    // going through movement input (admin teleport, debug tooling, or a router-level "send player to
    // region X" command). Deliberately routes through BOTH physicsIntegration (the real body) and the
    // player's own state object (what snapshots read) the same way RECONNECT/ACCEPT_HANDOFF do, so it
    // can't desync the two. checkHandoffs() naturally detects a resulting boundary crossing on the
    // very next tick via the same authoritative-region recompute every real movement tick uses.
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
    // Ops/debug direct EventLog record+query -- same class of tooling as __WITNESS_FORCE_POSITION
    // above (admin/debug/live-witness, real production-shaped IPC surface, not test-only wiring): lets
    // an operator or a live-witness harness record an event straight into a specific shard's own
    // eventLog (mirroring what any real app's ctx.eventLog.record(type,data,{crossShard:true,...})
    // call does) and query a shard's own eventLog by type without needing a full player/client
    // roundtrip through the router's WebSocket path.
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
