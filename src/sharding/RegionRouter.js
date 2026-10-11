import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createStaticHandler } from '../sdk/StaticHandler.js'
import { buildStaticDirs } from '../sdk/server.js'
import {
  parseRegionId, regionIdFor, authoritativeRegionFor, DEFAULT_CELL_SIZE, DEFAULT_GHOST_MARGIN
} from './RegionGrid.js'
import { resolveAppsDirs } from '../sdk/ServerBoot.js'
import {
  dispatchMessage, messageTable, refusalText,
  RegionWorkerRefusedError, RegionSiblingRefusedError, WORKER_REFUSED
} from './ShardingRefusal.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_ENTRY = join(SDK_ROOT, 'src/sharding/RegionWorkerEntry.js')

export const HANDOFF_IDLE = null
export const PLAYER_IDENTITY_UNMINTED = 'player-identity-unminted'
export const HANDOFF_UNMINTED = 'handoff-unminted'

export function playerIdentity(region, localPlayerId) {
  if (!parseRegionId(region).ok) return null
  if (localPlayerId === null || localPlayerId === undefined) return null
  return { region, localPlayerId }
}

export function handoffTo(toRegion, fromRegion, fromLocalId) {
  if (!parseRegionId(toRegion).ok || !parseRegionId(fromRegion).ok) return null
  if (fromLocalId === null || fromLocalId === undefined) return null
  return { toRegion, fromRegion, fromLocalId }
}

function refuseWorkerMessage(regionId, code, detail) {
  console.error(`[router] refused worker message from region ${regionId}: ${code} ${JSON.stringify(detail ?? null)}`)
}

export class RegionRouter {
  constructor(config = {}) {
    this.config = config
    this.port = config.port || 3500
    this.cellSize = config.cellSize || DEFAULT_CELL_SIZE
    this.ghostMargin = config.ghostMargin != null ? config.ghostMargin : DEFAULT_GHOST_MARGIN
    this.worldDef = config.worldDef || {}
    this.workers = new Map()
    this.players = new Map()
    this._nextRouterPlayerId = 1
    this._nextRequestId = 1
    this._pendingRequests = new Map()
    this.httpServer = null
    this.wss = null
    this._workerHandlers = messageTable([
      ['WORKER_BOOTING', () => {}],
      ['WORKER_READY', (msg, regionId) => this.workers.get(regionId)?._resolveReady?.()],
      ['CLIENT_CONNECTED', msg => this._settlePending(msg.requestId, msg)],
      ['WORKER_FRAME', (msg, regionId) => this._forwardToClient(regionId, msg)],
      ['CLIENT_CLOSE_FROM_WORKER', (msg, regionId) => this._closeClient(regionId, msg)],
      ['BOUNDARY_CROSSING', (msg, regionId) => this._handleBoundaryCrossing(regionId, msg)],
      ['HANDOFF_ACCEPTED', msg => this._handleHandoffAccepted(msg)],
      ['EVENT_REPLICATE', (msg, regionId) => this._handleEventReplicate(regionId, msg)],
      ['STATS', msg => this._settlePending(msg.requestId, msg)],
      [WORKER_REFUSED, (msg, regionId) => this._handleWorkerRefused(regionId, msg)],
    ])
  }

  async spawnRegions(regionIds) {
    await Promise.all(regionIds.map(r => this._spawnRegion(r)))
  }

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
        this._abandonHandoffsTo(regionId)
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
      entry._rejectReady = (error) => {
        if (settled) return
        settled = true
        clearTimeout(readyTimeout)
        reject(error)
      }
      proc.send({ type: 'INIT', region: regionId, worldDef: this.worldDef, cellSize: this.cellSize, ghostMargin: this.ghostMargin })
    })
  }

  _handleWorkerMessage(regionId, msg) {
    const outcome = dispatchMessage(this._workerHandlers, msg, regionId)
    if (outcome.ok) return
    console.error(`[router] refused worker message from region ${regionId}: ${outcome.code} type=${JSON.stringify(outcome.detail?.type ?? null)}`)
  }

  _handleWorkerRefused(regionId, msg) {
    const refusal = { name: msg?.name ?? null, code: msg?.code ?? null, error: msg?.error ?? null }
    console.error(`[router] region worker ${regionId} refused to boot: ${refusalText(refusal)}`)
    this.workers.get(regionId)?._rejectReady?.(new RegionWorkerRefusedError(regionId, refusal))
    for (const [id, entry] of this.workers) {
      if (id === regionId) continue
      entry._rejectReady?.(new RegionSiblingRefusedError(id, regionId))
    }
    this._killAllWorkers()
  }

  _killAllWorkers() {
    for (const entry of this.workers.values()) {
      try { entry.proc.kill() } catch (_) { }
    }
    this.workers.clear()
  }

  _addPending(requestId, { resolve, reject, routerId = null }, timeoutMs, timeoutMessage) {
    const timer = setTimeout(() => this._refusePending(requestId, new Error(timeoutMessage)), timeoutMs)
    this._pendingRequests.set(requestId, { resolve, reject, routerId, timer })
  }

  _settlePending(requestId, msg) {
    const pending = this._pendingRequests.get(requestId)
    if (!pending) return
    this._pendingRequests.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(msg)
  }

  _refusePending(requestId, error) {
    const pending = this._pendingRequests.get(requestId)
    if (!pending) return
    this._pendingRequests.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  _abandonHandoffsTo(regionId) {
    for (const player of this.players.values()) {
      if (player.handoff?.toRegion !== regionId) continue
      player.handoff = null
      console.warn(`[router] handoff to ${regionId} abandoned: no accepting region left to answer it`)
    }
  }

  _playerFor(regionId, localPlayerId) {
    const routerId = this._localToRouterId(regionId, localPlayerId)
    return routerId != null ? this.players.get(routerId) ?? null : null
  }

  _forwardToClient(regionId, msg) {
    const player = this._playerFor(regionId, msg.playerId)
    if (player?.socket && player.socket.readyState === 1) {
      player.socket.send(Buffer.from(msg.dataB64, 'base64'))
    }
  }

  _closeClient(regionId, msg) {
    const player = this._playerFor(regionId, msg.playerId)
    if (player?.socket && player.socket.readyState === 1) player.socket.close()
  }

  _localToRouterId(regionId, localPlayerId) {
    if (localPlayerId === null || localPlayerId === undefined) return null
    for (const [routerId, p] of this.players) {
      if (p.region === regionId && p.localPlayerId === localPlayerId) return routerId
    }
    return null
  }

  _handleBoundaryCrossing(fromRegion, msg) {
    const toEntry = this.workers.get(msg.toRegion)
    if (!toEntry || !toEntry.ready) {
      console.warn(`[router] boundary crossing to unspawned region ${msg.toRegion} (from ${fromRegion}, player ${msg.playerId}) -- no shard there, player stays in ${fromRegion}`)
      return
    }
    const player = this._playerFor(fromRegion, msg.playerId)
    if (!player) return
    if (player.handoff) {
      console.warn(`[router] boundary crossing to ${msg.toRegion} refused for player ${msg.playerId} (from ${fromRegion}): a handoff to ${player.handoff.toRegion} is still in flight`)
      return
    }
    const handoff = handoffTo(msg.toRegion, fromRegion, msg.playerId)
    if (!handoff) {
      refuseWorkerMessage(fromRegion, HANDOFF_UNMINTED, { toRegion: msg.toRegion ?? null, fromRegion, fromLocalId: msg.playerId ?? null })
      return
    }
    player.handoff = handoff
    toEntry.proc.send({
      type: 'ACCEPT_HANDOFF', playerId: msg.playerId, fromRegion, state: msg.state, sessionToken: msg.sessionToken
    })
  }

  _handleHandoffAccepted(msg) {
    const player = this._playerFor(msg.fromRegion, msg.oldPlayerId)
    const identity = playerIdentity(msg.region, msg.newLocalPlayerId)
    if (!player) {
      const toEntry = this.workers.get(msg.region)
      toEntry?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', playerId: msg.newLocalPlayerId })
      return
    }
    if (!identity) {
      refuseWorkerMessage(msg.region, PLAYER_IDENTITY_UNMINTED, { fromRegion: msg.fromRegion, newLocalPlayerId: msg.newLocalPlayerId ?? null })
      this.workers.get(msg.region)?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', playerId: msg.newLocalPlayerId })
      return
    }
    const oldEntry = this.workers.get(msg.fromRegion)
    player.region = identity.region
    player.localPlayerId = identity.localPlayerId
    player.sessionToken = msg.sessionToken
    player.handoff = null
    oldEntry?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', playerId: msg.oldPlayerId })
  }

  _handleEventReplicate(originRegion, msg) {
    for (const [regionId, entry] of this.workers) {
      if (regionId === originRegion || !entry.ready) continue
      entry.proc.send({ type: 'EVENT_REPLICATE_IN', originRegion, event: msg.event })
    }
  }

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
    const player = { socket, region, localPlayerId: null, handoff: null, connectRequestId: requestId }
    this.players.set(routerId, player)
    socket.on('message', (data) => {
      const p = this.players.get(routerId)
      if (!p) return
      if (p.localPlayerId === null || p.localPlayerId === undefined) return
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
        this._refusePending(p.connectRequestId, new Error('client socket closed before its region answered'))
      }
      this.players.delete(routerId)
    })
    socket.on('error', () => {})
    const readyMsg = await new Promise((resolve, reject) => {
      this._addPending(requestId, { resolve, reject, routerId }, 10000, 'CLIENT_CONNECT timed out')
      entry.proc.send({ type: 'CLIENT_CONNECT', playerId: routerId, requestId })
    }).catch(e => { console.error('[router] client connect failed:', e.message); socket.close(); return null })
    if (!readyMsg) { this.players.delete(routerId); return }
    const identity = playerIdentity(player.region, readyMsg.localPlayerId)
    if (!identity) {
      this.players.delete(routerId)
      this.workers.get(region)?.proc.send({ type: 'CLIENT_DISCONNECT', playerId: routerId })
      refuseWorkerMessage(region, PLAYER_IDENTITY_UNMINTED, { requestId, localPlayerId: readyMsg.localPlayerId ?? null })
      socket.close()
      return null
    }
    player.localPlayerId = identity.localPlayerId
    return routerId
  }

  async start() {
    const staticDirs = this.config.staticDirs || buildStaticDirs(SDK_ROOT, process.cwd(), resolveAppsDirs(process.cwd(), SDK_ROOT))
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
    this.wss.on('connection', (socket, req) => {
      let initialPosition = null
      try {
        const url = new URL(req.url, 'http://localhost')
        const sx = parseFloat(url.searchParams.get('spawnX'))
        const sz = parseFloat(url.searchParams.get('spawnZ'))
        if (Number.isFinite(sx) && Number.isFinite(sz)) initialPosition = [sx, 5, sz]
      } catch (_) { }
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
      this._addPending(requestId, { resolve, reject }, 5000, 'stats timeout')
      entry.proc.send({ type: 'STATS_REQUEST', requestId })
    })
  }

  async stop() {
    for (const requestId of [...this._pendingRequests.keys()]) {
      this._refusePending(requestId, new Error('router stopped'))
    }
    if (this.wss) this.wss.close()
    if (this.httpServer) this.httpServer.close()
    this._killAllWorkers()
  }
}
