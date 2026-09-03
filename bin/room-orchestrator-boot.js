#!/usr/bin/env node
// Multi-PROCESS room orchestrator CLI boot entry (server-scale-multiprocess-room-orchestrator-deploy-
// recipe). Mirrors bin/router-boot.js's real-deployable-entry shape but for the DIFFERENT topology
// this row's title names: N independent Node worker PROCESSES, each hosting 1..many independent ROOMS
// (via src/sdk/RoomDirectory.js/RoomProcessWorker.js), least-loaded-bin-packed by src/sdk/
// RoomOrchestrator.js, with a thin HTTP router process exposing /route/:roomId (which host:port to
// connect a client to) and /status (fleet-wide room list) -- NOT a spatial world-shard router
// (that's RegionRouter.js/bin/router-boot.js, a different feature for splitting ONE big world).
//
// Usage:
//   ROOM_WORKER_COUNT=4 ROUTER_PORT=3400 node bin/room-orchestrator-boot.js
// Then create rooms against the running router, e.g.:
//   curl -X POST 'http://localhost:3400/rooms?roomId=lobby-1&world=tps-game'
//   curl 'http://localhost:3400/route/lobby-1'   -> {"host":"127.0.0.1","port":19000,...}
//   curl 'http://localhost:3400/status'          -> {"workerCount":4,"rooms":[...]}
//
// CROSS-MACHINE DEPLOYMENT (server-scale-room-orchestrator-cross-machine-routing):
// Set ROOM_WORKER_HOSTS to a comma-separated list of per-worker public hostnames:
//   ROOM_WORKER_HOSTS="machine-0.fly.dev,machine-1.fly.dev" node bin/room-orchestrator-boot.js
// Then /route/:roomId returns the worker's actual host (not 127.0.0.1), so a client
// connects directly to the correct Machine.  External workers (on separate Machines
// not forked by this process) register via POST /workers/register {"host":"..."}.
//
// CRASH AUTO-RESTART (same row):
// Set ROOM_MAX_RESTARTS (default 3) and ROOM_RESTART_WINDOW_MS (default 60000).
// Set ROOM_RESTART_ON_CRASH=0 to disable auto-restart entirely.
//   curl 'http://localhost:3400/crash-stats'  -> {"0":{"crashCount":0,"restartCount":0},...}
//
// A game client (or a thin CLIENT-facing gateway in front of this router -- see deploy/fly-rooms.toml
// for the fly.io recipe) resolves /route/:roomId FIRST, then connects its real WebSocket game
// transport DIRECTLY to the returned host:port -- this router never proxies game traffic, matching
// RoomOrchestrator.js's own doc comment on why (steady-state zero-overhead, router crash never drops
// a live game connection since players are already talking straight to their room's own port).
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

  // CROSS-MACHINE: per-worker host overrides (comma-separated "host1,host2,...").
  // Index N in the list is the host for worker N.  Locally-forked workers without an
  // override default to '127.0.0.1'.  For a multi-Machine deployment, set each worker's
  // host to its fly.io Machine hostname (or other public address) so /route/:roomId
  // returns a publicly-reachable host:port pair.
  const workerHosts = {}
  const hostsEnv = process.env.ROOM_WORKER_HOSTS || ''
  if (hostsEnv) {
    hostsEnv.split(',').forEach((host, i) => { const h = host.trim(); if (h) workerHosts[i] = h })
  }

  // CRASH AUTO-RESTART: whether to respawn a locally-forked worker that exits unexpectedly.
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

  // Wrap RoomOrchestrator's own startRouter() with a POST /rooms creation endpoint -- startRouter()
  // itself only serves the read-side (/route/:id, /status); room creation is intentionally a
  // separate, explicit, POST-verbed operator/matchmaker action layered on top here rather than
  // baked into the library class, so an embedding app (a real matchmaker service) can swap in its
  // own creation policy (auth, rate-limit, roomId generation) without forking RoomOrchestrator.js.
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
