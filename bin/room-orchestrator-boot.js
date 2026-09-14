#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createHttpServer } from 'node:http'
import { RoomOrchestrator, readJsonBody } from '../src/sdk/RoomOrchestrator.js'
import { assertNodeModulesLinked } from '../src/sdk/server.js'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  assertNodeModulesLinked(SDK_ROOT)
  const PROJECT = process.cwd()
  const workerCount = parseInt(process.env.ROOM_WORKER_COUNT || '2', 10)
  const routerPort = parseInt(process.env.ROUTER_PORT || '3400', 10)
  const portRangeMin = parseInt(process.env.ROOM_PORT_MIN || '19000', 10)
  const portRangeMax = parseInt(process.env.ROOM_PORT_MAX || '19999', 10)
  const elasticScaling = process.env.ROOM_ELASTIC_SCALING === '1' || process.env.ROOM_ELASTIC_SCALING === 'true'
  const elasticScaleUpThreshold = parseFloat(process.env.ROOM_ELASTIC_SCALE_UP_THRESHOLD || '0.8')
  const elasticScaleDownCooldownMs = parseInt(process.env.ROOM_ELASTIC_SCALE_DOWN_COOLDOWN_MS || '120000', 10)
  const elasticScaleCheckIntervalMs = parseInt(process.env.ROOM_ELASTIC_SCALE_CHECK_INTERVAL_MS || '30000', 10)

  const workerHosts = {}
  const hostsEnv = process.env.ROOM_WORKER_HOSTS || ''
  if (hostsEnv) {
    hostsEnv.split(',').forEach((host, i) => { const h = host.trim(); if (h) workerHosts[i] = h })
  }

  const restartOnCrash = process.env.ROOM_RESTART_ON_CRASH !== '0' && process.env.ROOM_RESTART_ON_CRASH !== 'false'
  const maxRestarts = parseInt(process.env.ROOM_MAX_RESTARTS || '3', 10)
  const restartWindowMs = parseInt(process.env.ROOM_RESTART_WINDOW_MS || '60000', 10)

  const orchestrator = new RoomOrchestrator({
    sdkRoot: SDK_ROOT,
    projectRoot: existsSync(join(PROJECT, 'apps')) ? PROJECT : SDK_ROOT,
    workerCount,
    portRange: [portRangeMin, portRangeMax],
    workerHosts,
    restartOnCrash,
    maxRestarts,
    restartWindowMs,
    elasticScaling,
    elasticScaleUpThreshold,
    elasticScaleDownCooldownMs,
    elasticScaleCheckIntervalMs,
  })

  console.log(`[room-orchestrator] spawning ${workerCount} worker process(es)...`)
  const info = await orchestrator.start()
  console.log(`[room-orchestrator] ${info.workerCount} worker(s) ready (pids: ${info.pids.join(', ')})`)

  if (elasticScaling) {
    orchestrator.startElasticScaling()
    console.log(`[room-orchestrator] elastic scaling enabled (checkInterval=${elasticScaleCheckIntervalMs}ms, scaleUpThreshold=${elasticScaleUpThreshold}, scaleDownCooldown=${elasticScaleDownCooldownMs}ms)`)
  }

  orchestrator.startExternalWorkerHeartbeat()
  console.log(`[room-orchestrator] external-worker heartbeat enabled (interval=${orchestrator._externalWorkerHeartbeatIntervalMs}ms)`)

  if (restartOnCrash) {
    console.log(`[room-orchestrator] crash auto-restart enabled (maxRestarts=${maxRestarts}, restartWindowMs=${restartWindowMs}ms)`)
  } else {
    console.log(`[room-orchestrator] crash auto-restart DISABLED`)
  }

  const hostList = Object.entries(workerHosts).map(([i, h]) => `worker ${i}=${h}`).join(', ')
  if (hostList) console.log(`[room-orchestrator] worker host overrides: ${hostList}`)

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'POST' && url.pathname === '/rooms') {
        const roomId = url.searchParams.get('roomId')
        const world = url.searchParams.get('world') || 'tps-game'
        if (!roomId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'roomId query param required' })); return }
        try {
          const result = await orchestrator.createRoom(roomId, world)
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message || String(e) }))
        }
        return
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/rooms/')) {
        const roomId = decodeURIComponent(url.pathname.slice('/rooms/'.length))
        const stopped = await orchestrator.stopRoom(roomId)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ roomId, stopped }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/workers/register') {
        const body = await readJsonBody(req)
        if (!body || !body.host) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'host field required' })); return }
        try {
          const result = await orchestrator.registerWorker({ host: body.host, portRange: body.portRange, commandPort: body.commandPort })
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message || String(e) }))
        }
        return
      }
      if (req.method === 'DELETE' && url.pathname.match(/^\/workers\/(\d+)$/)) {
        const wm = url.pathname.match(/^\/workers\/(\d+)$/)
        const ok = await orchestrator.deregisterWorker(parseInt(wm[1], 10))
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ deregistered: ok }))
        return
      }
      if (url.pathname === '/workers') {
        const list = []
        for (let i = 0; i < orchestrator.workers.length; i++) {
          const w = orchestrator.workers[i]
          if (w) list.push({ workerIndex: i, host: w.host, ready: w.ready, isExternal: w.isExternal, roomCount: w.roomIds.size })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(list))
        return
      }
      if (url.pathname === '/crash-stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(orchestrator.getCrashStats()))
        return
      }
      if (url.pathname === '/elastic-stats') {
        const stats = orchestrator.getElasticStats()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(stats))
        return
      }
      if (url.pathname === '/status') {
        const rooms = await orchestrator.getStatus()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ workerCount: orchestrator.workers.length, rooms }))
        return
      }
      const m = url.pathname.match(/^\/route\/(.+)$/)
      if (m) {
        const loc = orchestrator.route(decodeURIComponent(m[1]))
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
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(routerPort, () => resolve())
  })
  console.log(`[room-orchestrator] router listening on http://localhost:${routerPort} (POST /rooms?roomId=X&world=Y, GET /route/:roomId, GET /status, DELETE /rooms/:roomId, POST /workers/register, GET /workers, GET /crash-stats)`)

  const shutdown = async (signal) => {
    console.log(`[room-orchestrator] received ${signal}, shutting down router + all worker processes + all rooms...`)
    await new Promise((resolve) => httpServer.close(() => resolve()))
    await orchestrator.stopAll()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[room-orchestrator] FATAL:', err)
  process.exit(1)
})
