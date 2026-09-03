// Region-shard router: the ONE process that owns real client transports (HTTP + WebSocket) and
// forwards each client's frames to whichever region-shard worker (RegionWorkerEntry.js, spawned as a
// real Node child_process) currently owns that player, based on world position. This is the piece
// that makes "N independent per-region Jolt-world/tick/encoder workers" look like a single seamless
// server to every connected client -- the client never knows it is being routed, and a shard-boundary
// crossing is invisible on the wire (same connection, same playerId, no reconnect round-trip visible
// to the browser).
//
// Topology:
//   client <--WebSocket--> RegionRouter (this file) <--child_process IPC--> RegionWorkerEntry (xN)
//
// Player identity: the ROUTER assigns the stable, client-facing playerId (a simple incrementing
// counter, `_nextRouterPlayerId`) and is the single source of truth for `routerPlayerId -> {region,
// localPlayerId}` -- each region worker has its OWN independent PlayerManager with its OWN local id
// space (a worker has no idea what the router-facing id is; from a worker's point of view, a router
// connection is just "a new local player"). This split is required because two DIFFERENT workers
// cannot be trusted to hand out non-colliding ids from independent `nextPlayerId` counters.
import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createStaticHandler } from '../sdk/StaticHandler.js'
import { buildStaticDirs } from '../sdk/server.js'
import {
  regionIdFor, authoritativeRegionFor, DEFAULT_CELL_SIZE, DEFAULT_GHOST_MARGIN
} from './RegionGrid.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_ENTRY = join(SDK_ROOT, 'src/sharding/RegionWorkerEntry.js')

export class RegionRouter {
  constructor(config = {}) {
    this.config = config
    this.port = config.port || 3500
    this.cellSize = config.cellSize || DEFAULT_CELL_SIZE
    this.ghostMargin = config.ghostMargin != null ? config.ghostMargin : DEFAULT_GHOST_MARGIN
    this.worldDef = config.worldDef || {}
    // regionId -> { proc, ready, pendingReady:[resolve...], region }
    this.workers = new Map()
    // routerPlayerId -> { socket, region, localPlayerId, pendingRegion (during handoff) }
    this.players = new Map()
    this._nextRouterPlayerId = 1
    this._nextRequestId = 1
    this._pendingRequests = new Map() // requestId -> {resolve, reject}
    this.httpServer = null
    this.wss = null
  }

  // Spawns one region worker for each given region id, waits for every one to report WORKER_READY,
  // and returns once the whole shard set is live. Regions are NOT auto-discovered from the world
  // def's entity spread -- the caller decides shard topology explicitly (a fixed NxN grid around
  // spawn is the common case; see spawnGridAroundOrigin below).
  async spawnRegions(regionIds) {
    await Promise.all(regionIds.map(r => this._spawnRegion(r)))
  }

  // Convenience: spawns a square NxN grid of region workers centered on region (0,0) -- the region
  // containing world-origin, which is where a fresh world's spawnPoint(s) almost always land.
  async spawnGridAroundOrigin(gridRadius = 1) {
    const ids = []
    for (let rx = -gridRadius; rx <= gridRadius; rx++) {
      for (let rz = -gridRadius; rz <= gridRadius; rz++) ids.push(`${rx},${rz}`)
    }
    await this.spawnRegions(ids)
  }

  _spawnRegion(regionId) {
    return new Promise((resolve, reject) => {
      const proc = fork(WORKER_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      const entry = { proc, ready: false, region: regionId }
      this.workers.set(regionId, entry)
      const onMessage = (msg) => this._handleWorkerMessage(regionId, msg)
      proc.on('message', onMessage)
      proc.on('exit', (code, signal) => {
        console.error(`[router] region worker ${regionId} exited (code=${code} signal=${signal})`)
        this.workers.delete(regionId)
      })
      proc.on('error', (e) => { console.error(`[router] region worker ${regionId} fork error:`, e.message); reject(e) })
      let settled = false
      const readyTimeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`region worker ${regionId} did not become ready in time`)) }
      }, 30000)
      entry._resolveReady = () => {
        if (settled) return
        settled = true
        clearTimeout(readyTimeout)
        entry.ready = true
        resolve(entry)
      }
      proc.send({ type: 'INIT', region: regionId, worldDef: this.worldDef, cellSize: this.cellSize, ghostMargin: this.ghostMargin })
    })
  }

  _handleWorkerMessage(regionId, msg) {
    const entry = this.workers.get(regionId)
    switch (msg.type) {
      case 'WORKER_BOOTING':
        return
      case 'WORKER_READY':
        entry?._resolveReady?.()
        return
      case 'CLIENT_CONNECTED': {
        const pending = this._pendingRequests.get(msg.requestId)
        if (pending) { this._pendingRequests.delete(msg.requestId); pending.resolve(msg) }
        return
      }
      case 'WORKER_FRAME': {
        // outbound: worker -> router -> client. Look up which router player currently maps to
        // (regionId, msg.playerId) -- a stale/handed-off local id (from the OLD region right after a
        // crossing) is silently dropped rather than mis-delivered to whatever router id now happens
        // to be at that local-id slot in a DIFFERENT worker.
        const routerId = this._localToRouterId(regionId, msg.playerId)
        const player = routerId != null ? this.players.get(routerId) : null
        if (player?.socket && player.socket.readyState === 1) {
          player.socket.send(Buffer.from(msg.dataB64, 'base64'))
        }
        return
      }
      case 'CLIENT_CLOSE_FROM_WORKER': {
        const routerId = this._localToRouterId(regionId, msg.playerId)
        const player = routerId != null ? this.players.get(routerId) : null
        if (player?.socket && player.socket.readyState === 1) player.socket.close()
        return
      }
      case 'BOUNDARY_CROSSING':
        this._handleBoundaryCrossing(regionId, msg)
        return
      case 'HANDOFF_ACCEPTED':
        this._handleHandoffAccepted(msg)
        return
      case 'EVENT_REPLICATE':
        this._handleEventReplicate(regionId, msg)
        return
      case 'STATS': {
        const pending = this._pendingRequests.get(msg.requestId)
        if (pending) { this._pendingRequests.delete(msg.requestId); pending.resolve(msg) }
        return
      }
      default:
        return
    }
  }

  _localToRouterId(regionId, localPlayerId) {
    for (const [routerId, p] of this.players) {
      if (p.region === regionId && p.localPlayerId === localPlayerId) return routerId
    }
    return null
  }

  // Ghost-margin cross-shard handoff, step 1: the LOSING (from) region reported a player's
  // authoritative region changed. Ask the WINNING (to) region worker to accept them, carrying live
  // position/velocity/health across so the player doesn't visibly reset. The losing worker keeps
  // ticking the player (per its own ghost-margin logic) until COMPLETE_HANDOFF_OUT arrives below --
  // there is no frame where the player has zero authoritative owner.
  _handleBoundaryCrossing(fromRegion, msg) {
    const toEntry = this.workers.get(msg.toRegion)
    if (!toEntry || !toEntry.ready) {
      // Target shard isn't spawned (e.g. player wandered off the pre-spawned grid) -- stay owned by
      // the losing region past the ghost margin rather than dropping the player; this is a real,
      // explicit degraded mode (documented, not silent): logged once per occurrence so an operator can
      // see under-provisioned grid radius, and the player keeps playing uninterrupted in their
      // current shard (worse locality, never worse correctness -- physics/tick continuity is
      // preserved because the losing worker's checkHandoffs only stops re-sending the crossing once
      // `cur` re-enters its own region or a real handoff completes).
      console.warn(`[router] boundary crossing to unspawned region ${msg.toRegion} (from ${fromRegion}, player ${msg.playerId}) -- no shard there, player stays in ${fromRegion}`)
      return
    }
    const routerId = this._localToRouterId(fromRegion, msg.playerId)
    const player = routerId != null ? this.players.get(routerId) : null
    if (!player) return
    player.pendingRegion = msg.toRegion
    player.pendingFromRegion = fromRegion
    player.pendingFromLocalId = msg.playerId
    toEntry.proc.send({
      type: 'ACCEPT_HANDOFF', playerId: msg.playerId, fromRegion, state: msg.state, sessionToken: msg.sessionToken
    })
  }

  // Handoff step 2: the winning region confirms it has the player live (bootstrapped, flushed).
  // Retarget the router's own mapping to the new (region, localId) so all FUTURE frames from this
  // client route there, then tell the losing region it can tear the player down for good.
  _handleHandoffAccepted(msg) {
    const routerId = this._localToRouterId(msg.fromRegion, msg.oldPlayerId)
    const player = routerId != null ? this.players.get(routerId) : null
    if (!player) {
      // Player disconnected mid-handoff -- tell the new region to clean up the just-accepted ghost.
      const toEntry = this.workers.get(msg.region)
      toEntry?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', playerId: msg.newLocalPlayerId })
      return
    }
    const oldEntry = this.workers.get(msg.fromRegion)
    player.region = msg.region
    player.localPlayerId = msg.newLocalPlayerId
    player.sessionToken = msg.sessionToken
    delete player.pendingRegion
    delete player.pendingFromRegion
    delete player.pendingFromLocalId
    oldEntry?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', playerId: msg.oldPlayerId })
  }

  // Cross-shard EventLog replication fan-out (see AGENTS.md PRD row
  // region-sharding-cross-shard-eventlog-replication + RegionWorkerEntry.js's forwarding hook). The
  // router is a pure relay here -- it holds no EventLog of its own, it just re-sends the
  // already-recorded event to every OTHER ready worker so each shard's own EventLog ends up with the
  // full crossShard-flagged event set. "Every other" (not a subscriber list) because this is a fan-out
  // broadcast, not a targeted message -- the origin worker is excluded both here (originRegion check)
  // and again idempotency-wise on the receiving end (EventLog.ingestRemote's own originRegion===regionId
  // guard in applyReplicatedEvent), so this stays correct even if a future topology grows router-side
  // subscription filtering.
  _handleEventReplicate(originRegion, msg) {
    for (const [regionId, entry] of this.workers) {
      if (regionId === originRegion || !entry.ready) continue
      entry.proc.send({ type: 'EVENT_REPLICATE_IN', originRegion, event: msg.event })
    }
  }

  // New client connection: pick the region for its spawn point (or a supplied position), request
  // that worker accept it, and wire up the client<->router socket forwarding.
  async _onSocketConnect(socket, initialPosition) {
    const routerId = this._nextRouterPlayerId++
    const spawnPoints = this.worldDef.spawnPoints?.length ? this.worldDef.spawnPoints : (this.worldDef.spawnPoint ? [this.worldDef.spawnPoint] : [[0, 5, 0]])
    const sp = initialPosition || spawnPoints[Math.floor(Math.random() * spawnPoints.length)]
    const region = authoritativeRegionFor(sp[0], sp[2], this.cellSize)
    const entry = this.workers.get(region)
    if (!entry || !entry.ready) {
      console.error(`[router] no live region worker for spawn region ${region} -- closing connection`)
      socket.close()
      return
    }
    const requestId = this._nextRequestId++
    const player = { socket, region, localPlayerId: null }
    this.players.set(routerId, player)
    socket.on('message', (data) => {
      const p = this.players.get(routerId)
      if (!p) return
      const targetEntry = this.workers.get(p.region)
      if (!targetEntry || !targetEntry.ready) return
      const buf = data instanceof Buffer ? data : Buffer.from(data)
      targetEntry.proc.send({ type: 'CLIENT_FRAME', playerId: p.localPlayerId, dataB64: buf.toString('base64') })
    })
    socket.on('close', () => {
      const p = this.players.get(routerId)
      if (p) {
        const targetEntry = this.workers.get(p.region)
        targetEntry?.proc.send({ type: 'CLIENT_DISCONNECT', playerId: p.localPlayerId })
      }
      this.players.delete(routerId)
    })
    socket.on('error', () => {})
    const readyMsg = await new Promise((resolve, reject) => {
      this._pendingRequests.set(requestId, { resolve, reject })
      entry.proc.send({ type: 'CLIENT_CONNECT', playerId: routerId, requestId })
      setTimeout(() => {
        if (this._pendingRequests.has(requestId)) { this._pendingRequests.delete(requestId); reject(new Error('CLIENT_CONNECT timed out')) }
      }, 10000)
    }).catch(e => { console.error('[router] client connect failed:', e.message); socket.close(); return null })
    if (!readyMsg) { this.players.delete(routerId); return }
    player.localPlayerId = readyMsg.localPlayerId
    return routerId
  }

  async start() {
    const staticDirs = this.config.staticDirs || buildStaticDirs(SDK_ROOT, process.cwd(), existsSync(join(process.cwd(), 'apps')) ? [join(process.cwd(), 'apps'), join(SDK_ROOT, 'apps')] : [join(SDK_ROOT, 'apps')])
    const staticHandler = staticDirs.length > 0 ? createStaticHandler(staticDirs) : null
    const httpHandler = (req, res) => {
      if (req.method === 'GET' && req.url === '/debug/router') {
        const stats = {
          regions: [...this.workers.entries()].map(([id, e]) => ({ id, ready: e.ready, pid: e.proc.pid })),
          players: this.players.size
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(stats)); return
      }
      if (staticHandler) {
        Promise.resolve(staticHandler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end('internal error') } })
      } else { res.writeHead(404); res.end('not found') }
    }
    this.httpServer = createHttpServer(httpHandler)
    this.wss = new WSServer({ server: this.httpServer, path: '/ws', perMessageDeflate: false })
    // Optional ?spawnX=&spawnZ= query hint lets a caller (a portal/teleporter linking worlds, an admin
    // reconnect-to-last-position flow, or this file's own live-witness harness) route a fresh
    // connection directly to the region owning a KNOWN position instead of a random worldDef spawn
    // point -- real production use, not test-only wiring (mirrors the same "position decides region"
    // rule _onSocketConnect already applies to every connection either way).
    this.wss.on('connection', (socket, req) => {
      let initialPosition = null
      try {
        const url = new URL(req.url, 'http://localhost')
        const sx = parseFloat(url.searchParams.get('spawnX'))
        const sz = parseFloat(url.searchParams.get('spawnZ'))
        if (Number.isFinite(sx) && Number.isFinite(sz)) initialPosition = [sx, 5, sz]
      } catch (_) { /* malformed URL -- fall through to worldDef default spawn selection */ }
      this._onSocketConnect(socket, initialPosition).catch(e => console.error('[router] connect error:', e.message))
    })
    await new Promise((resolve, reject) => {
      this.httpServer.on('error', reject)
      this.httpServer.listen(this.port, '0.0.0.0', resolve)
    })
    return { port: this.port }
  }

  async requestStats(regionId) {
    const entry = this.workers.get(regionId)
    if (!entry || !entry.ready) return null
    const requestId = this._nextRequestId++
    return new Promise((resolve, reject) => {
      this._pendingRequests.set(requestId, { resolve, reject })
      entry.proc.send({ type: 'STATS_REQUEST', requestId })
      setTimeout(() => { if (this._pendingRequests.has(requestId)) { this._pendingRequests.delete(requestId); reject(new Error('stats timeout')) } }, 5000)
    })
  }

  async stop() {
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
    for (const entry of this.workers.values()) entry.proc.kill()
    this.workers.clear()
  }
}
