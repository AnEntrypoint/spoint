import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

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

export function startRoomOrchestratorRouter(orch, port) {
  orch.httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')

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

      if (req.method === 'DELETE') {
        const wm = url.pathname.match(/^\/workers\/(\d+)$/)
        if (wm) {
          const ok = await orch.deregisterWorker(parseInt(wm[1], 10))
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ deregistered: ok }))
          return
        }
      }

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
