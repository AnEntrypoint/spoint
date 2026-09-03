// Pure HTTP helpers for RoomOrchestrator.js: JSON request-body reading (for the router's own
// listener) and JSON-over-HTTP(S) request/response (for talking to an EXTERNAL worker's command
// port). No reference to RoomOrchestrator's own instance state -- split out as the one genuinely
// stateless piece of that file.

import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Reads a JSON body from an IncomingMessage, returning the parsed object or null. */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (chunk) => { buf += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(buf)) } catch (_) { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

export function httpJsonRequest(url, method, body) {
  return new Promise((resolve, reject) => {
    const requestFn = url.startsWith('https') ? httpsRequest : httpRequest
    const data = body !== undefined ? JSON.stringify(body) : null
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    const req = requestFn(url, { method, headers }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

// server-scale-room-orchestrator-load-aware-placement's weight formula (see RoomOrchestrator.js's
// _pickWeightedWorker header for the full rationale) -- pure given a room-status row, no orchestrator
// instance state, so it is shared verbatim between _pickWeightedWorker (placement) and _elasticCheck
// (scale-up trigger) rather than kept as two independently-maintained copies of the same weights.
export const PLACEMENT_WEIGHTS = { PLAYER_WEIGHT: 1.0, ENTITY_WEIGHT: 0.02, TICKMS_WEIGHT: 0.5, DILATION_PENALTY: 50 }

export function scoreRoom(r) {
  const { PLAYER_WEIGHT, ENTITY_WEIGHT, TICKMS_WEIGHT, DILATION_PENALTY } = PLACEMENT_WEIGHTS
  return (r.players || 0) * PLAYER_WEIGHT
    + (r.entities || 0) * ENTITY_WEIGHT
    + (r.avgTickMs || 0) * TICKMS_WEIGHT
    + (1 - (r.dilationFactor ?? 1)) * DILATION_PENALTY
}

export function scoreWorkerRooms(rooms) {
  return rooms.reduce((sum, r) => sum + scoreRoom(r), 0)
}

// Starts the minimal HTTP router listener on `port` for a RoomOrchestrator instance `orch`: GET
// /route/:roomId -> {host,port,workerIndex,worldName} JSON (404 if unknown), GET /status -> full
// fleet status, POST /workers/register -> register an external worker, DELETE /workers/:index ->
// deregister, GET /workers -> list, GET /crash-stats -> crash/restart stats. Not a traffic proxy --
// see RoomOrchestrator.js's class doc comment. Only reaches `orch` through its public methods
// (registerWorker/deregisterWorker/getCrashStats/getStatus/route) plus a read of orch.workers, so
// this is safely split from the class despite touching orchestrator state.
export function startRoomOrchestratorRouter(orch, port) {
  orch.httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

      // POST /workers/register -- register an external worker (running on a different Machine)
      // Body: { host: "my-machine.fly.dev", portRange?: [19000, 19015] }
      if (req.method === 'POST' && url.pathname === '/workers/register') {
        const body = await readJsonBody(req)
        if (!body || !body.host) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'host field required' })); return }
        try {
          const result = await orch.registerWorker({ host: body.host, portRange: body.portRange })
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message || String(e) }))
        }
        return
      }

      // DELETE /workers/:index -- deregister an external worker
      if (req.method === 'DELETE') {
        const wm = url.pathname.match(/^\/workers\/(\d+)$/)
        if (wm) {
          const ok = await orch.deregisterWorker(parseInt(wm[1], 10))
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ deregistered: ok }))
          return
        }
      }

      // GET /workers -- list all workers with their hosts
      if (url.pathname === '/workers') {
        const list = []
        for (let i = 0; i < orch.workers.length; i++) {
          const w = orch.workers[i]
          if (w) list.push({ workerIndex: i, host: w.host, ready: w.ready, isExternal: w.isExternal, roomCount: w.roomIds.size })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(list))
        return
      }

      // GET /crash-stats -- crash/restart stats for monitoring
      if (url.pathname === '/crash-stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(orch.getCrashStats()))
        return
      }

      if (url.pathname === '/status') {
        const rooms = await orch.getStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ workerCount: orch.workers.length, rooms }))
        return
      }
      const m = url.pathname.match(/^\/route\/(.+)$/)
      if (m) {
        const loc = orch.route(decodeURIComponent(m[1]))
        if (!loc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'room not found' })); return }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(loc))
        return
      }
      res.writeHead(404); res.end('not found')
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e?.message || String(e) }))
    }
  })
  return new Promise((resolve, reject) => {
    orch.httpServer.once('error', reject)
    orch.httpServer.listen(port, () => resolve({ port: orch.httpServer.address().port }))
  })
}
