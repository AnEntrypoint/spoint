import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { createStaticHandler } from '../sdk/StaticHandler.js'
import { buildStaticDirs } from '../sdk/server.js'
import {
  parseRegionId, parseRegionCoords, regionIdFor, authoritativeRegionFor, DEFAULT_CELL_SIZE, DEFAULT_GHOST_MARGIN
} from './RegionGrid.js'
import { resolveAppsDirs } from '../sdk/ServerBoot.js'
import {
  dispatchMessage, messageTable, refusalText,
  ClientConnectRefusedError, RegionWorkerRefusedError, RegionSiblingRefusedError,
  WORKER_REFUSED, ROUTER_PLAYER_ID_MALFORMED, CLIENT_CONNECT_REFUSED, HANDOFF_REFUSED
} from './ShardingRefusal.js'

export { ROUTER_PLAYER_ID_MALFORMED }

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKER_ENTRY = join(SDK_ROOT, 'src/sharding/RegionWorkerEntry.js')

export const HANDOFF_IDLE = null
export const PLAYER_IDENTITY_UNMINTED = 'player-identity-unminted'
export const HANDOFF_UNMINTED = 'handoff-unminted'
export const HANDOFF_UNKNOWN_PLAYER = 'handoff-unknown-player'

export function playerIdentity(region, localPlayerId) {
  if (!parseRegionId(region).ok) return null
  if (!parseLocalPlayerId(localPlayerId).ok) return null
  return { region, localPlayerId }
}

export function handoffTo(toRegion, fromRegion, fromLocalId) {
  if (!parseRegionId(toRegion).ok || !parseRegionId(fromRegion).ok) return null
  if (!parseLocalPlayerId(fromLocalId).ok) return null
  return { toRegion, fromRegion, fromLocalId }
}

export const LOCAL_PLAYER_ID_MALFORMED = 'local-player-id-malformed'
export const SESSION_TOKEN_MALFORMED = 'session-token-malformed'

const SESSION_TOKEN_SHAPE = /^[0-9a-f]{32}$/

export function parseRouterPlayerId(value) {
  if (!Number.isInteger(value) || value < 1) return { ok: false, reason: ROUTER_PLAYER_ID_MALFORMED, value: value ?? null }
  return { ok: true, routerPlayerId: value }
}

export function parseLocalPlayerId(value) {
  if (!Number.isInteger(value) || value < 0) return { ok: false, reason: LOCAL_PLAYER_ID_MALFORMED, value: value ?? null }
  return { ok: true, localPlayerId: value }
}

export function parseSessionToken(value) {
  if (value === null || value === undefined) return { ok: true, sessionToken: null }
  if (typeof value === 'string' && SESSION_TOKEN_SHAPE.test(value)) return { ok: true, sessionToken: value }
  return { ok: false, reason: SESSION_TOKEN_MALFORMED, value: typeof value === 'string' ? value : null }
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
      [CLIENT_CONNECT_REFUSED, msg => this._handleClientConnectRefused(msg)],
      ['WORKER_FRAME', (msg, regionId) => this._forwardToClient(regionId, msg)],
      ['CLIENT_CLOSE_FROM_WORKER', (msg, regionId) => this._closeClient(regionId, msg)],
      ['BOUNDARY_CROSSING', (msg, regionId) => this._handleBoundaryCrossing(regionId, msg)],
      ['HANDOFF_ACCEPTED', msg => this._handleHandoffAccepted(msg)],
      [HANDOFF_REFUSED, msg => this._handleHandoffRefused(msg)],
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

  _playerEntryFor(regionId, localPlayerId) {
    const parsed = parseLocalPlayerId(localPlayerId)
    if (!parsed.ok) return null
    for (const [routerId, p] of this.players) {
      if (p.region === regionId && p.localPlayerId === parsed.localPlayerId) return { routerId, player: p }
    }
    return null
  }

  _forwardToClient(regionId, msg) {
    const parsed = parseRouterPlayerId(msg.routerPlayerId)
    if (!parsed.ok) {
      refuseWorkerMessage(regionId, parsed.reason, { type: msg.type, routerPlayerId: msg.routerPlayerId ?? null })
      return
    }
    const player = this.players.get(parsed.routerPlayerId)
    if (player?.region !== regionId) return
    if (player.socket && player.socket.readyState === 1) {
      player.socket.send(Buffer.from(msg.dataB64, 'base64'))
    }
  }

  _closeClient(regionId, msg) {
    const parsed = parseRouterPlayerId(msg.routerPlayerId)
    if (!parsed.ok) {
      refuseWorkerMessage(regionId, parsed.reason, { type: msg.type, routerPlayerId: msg.routerPlayerId ?? null })
      return
    }
    const player = this.players.get(parsed.routerPlayerId)
    if (player?.region !== regionId) return
    if (player.socket && player.socket.readyState === 1) player.socket.close()
  }

  _handleBoundaryCrossing(fromRegion, msg) {
    const toEntry = this.workers.get(msg.toRegion)
    if (!toEntry || !toEntry.ready) {
      console.warn(`[router] boundary crossing to unspawned region ${msg.toRegion} (from ${fromRegion}, player ${msg.localPlayerId}) -- no shard there, player stays in ${fromRegion}`)
      return
    }
    const localId = parseLocalPlayerId(msg.localPlayerId)
    if (!localId.ok) {
      refuseWorkerMessage(fromRegion, localId.reason, { toRegion: msg.toRegion ?? null, fromRegion, localPlayerId: msg.localPlayerId ?? null })
      return
    }
    const token = parseSessionToken(msg.sessionToken)
    if (!token.ok) {
      refuseWorkerMessage(fromRegion, token.reason, { toRegion: msg.toRegion ?? null, fromRegion, localPlayerId: localId.localPlayerId, sessionToken: token.value })
      return
    }
    const entry = this._playerEntryFor(fromRegion, localId.localPlayerId)
    if (!entry) return
    if (entry.player.handoff) {
      console.warn(`[router] boundary crossing to ${msg.toRegion} refused for player ${localId.localPlayerId} (from ${fromRegion}): a handoff to ${entry.player.handoff.toRegion} is still in flight`)
      return
    }
    const handoff = handoffTo(msg.toRegion, fromRegion, localId.localPlayerId)
    if (!handoff) {
      refuseWorkerMessage(fromRegion, HANDOFF_UNMINTED, { toRegion: msg.toRegion ?? null, fromRegion, localPlayerId: localId.localPlayerId })
      return
    }
    entry.player.handoff = handoff
    toEntry.proc.send({
      type: 'ACCEPT_HANDOFF', localPlayerId: localId.localPlayerId, routerPlayerId: entry.routerId, fromRegion, state: msg.state, sessionToken: token.sessionToken
    })
  }

  _handleHandoffAccepted(msg) {
    const entry = this._playerEntryFor(msg.fromRegion, msg.oldLocalPlayerId)
    const identity = entry ? playerIdentity(msg.region, msg.newLocalPlayerId) : null
    const token = parseSessionToken(msg.sessionToken)
    if (!identity || !token.ok) {
      refuseWorkerMessage(msg.region, token.ok ? (entry ? PLAYER_IDENTITY_UNMINTED : HANDOFF_UNKNOWN_PLAYER) : token.reason, {
        fromRegion: msg.fromRegion, oldLocalPlayerId: msg.oldLocalPlayerId ?? null, newLocalPlayerId: msg.newLocalPlayerId ?? null, sessionToken: token.ok ? null : token.value
      })
      this.workers.get(msg.region)?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', routerPlayerId: msg.routerPlayerId ?? entry?.routerId ?? null })
      return
    }
    entry.player.region = identity.region
    entry.player.localPlayerId = identity.localPlayerId
    entry.player.sessionToken = token.sessionToken
    entry.player.handoff = null
    this.workers.get(msg.fromRegion)?.proc.send({ type: 'COMPLETE_HANDOFF_OUT', routerPlayerId: entry.routerId })
  }

  _handleClientConnectRefused(msg) {
    const parsed = parseRouterPlayerId(msg.routerPlayerId)
    const code = typeof msg.code === 'string' ? msg.code : ROUTER_PLAYER_ID_MALFORMED
    if (!parsed.ok) {
      refuseWorkerMessage(msg.region ?? null, parsed.reason, { type: msg.type, routerPlayerId: msg.routerPlayerId ?? null })
      return
    }
    refuseWorkerMessage(msg.region ?? null, code, { requestId: msg.requestId ?? null, routerPlayerId: parsed.routerPlayerId, error: msg.error ?? null })
    this._refusePending(msg.requestId, new ClientConnectRefusedError(code, msg.error ?? null))
    const player = this.players.get(parsed.routerPlayerId)
    if (player?.socket) player.socket.close()
  }

  _handleHandoffRefused(msg) {
    const parsed = parseRouterPlayerId(msg.routerPlayerId)
    const player = parsed.ok ? this.players.get(parsed.routerPlayerId) : null
    if (player) player.handoff = null
    refuseWorkerMessage(msg.region ?? null, typeof msg.code === 'string' ? msg.code : ROUTER_PLAYER_ID_MALFORMED, {
      fromRegion: msg.fromRegion ?? null, localPlayerId: msg.localPlayerId ?? null,
      routerPlayerId: parsed.ok ? parsed.routerPlayerId : null, error: msg.error ?? null
    })
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
    const coords = parseRegionCoords(sp?.[0], sp?.[2], this.cellSize)
    if (!coords.ok) {
      console.error(`[router] refused connection: spawn point ${JSON.stringify(sp ?? null)} mints no region (${coords.reason})`)
      socket.close()
      return
    }
    const region = coords.regionId
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
      const targetEntry = this.workers.get(p.region)
      if (!targetEntry || !targetEntry.ready) return
      const buf = data instanceof Buffer ? data : Buffer.from(data)
      targetEntry.proc.send({ type: 'CLIENT_FRAME', routerPlayerId: routerId, dataB64: buf.toString('base64') })
    })
    socket.on('close', () => {
      const p = this.players.get(routerId)
      if (p) {
        const targetEntry = this.workers.get(p.region)
        targetEntry?.proc.send({ type: 'CLIENT_DISCONNECT', routerPlayerId: routerId })
        this._refusePending(p.connectRequestId, new Error('client socket closed before its region answered'))
      }
      this.players.delete(routerId)
    })
    socket.on('error', () => {})
    const readyMsg = await new Promise((resolve, reject) => {
      this._addPending(requestId, { resolve, reject, routerId }, 10000, 'CLIENT_CONNECT timed out')
      entry.proc.send({ type: 'CLIENT_CONNECT', routerPlayerId: routerId, requestId })
    }).catch(e => { console.error('[router] client connect failed:', e.message); socket.close(); return null })
    if (!readyMsg) { this.players.delete(routerId); return }
    const identity = playerIdentity(player.region, readyMsg.localPlayerId)
    if (!identity) {
      this.players.delete(routerId)
      this.workers.get(region)?.proc.send({ type: 'CLIENT_DISCONNECT', routerPlayerId: routerId })
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
