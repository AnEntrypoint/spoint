/**
 * PublicBenchmark.js -- Server-side benchmark collector and JSON endpoint.
 *
 * FIRST SLICE of ugc-platform-npc-training-federation-monorepo-docs-wasm-native-benchmark
 * (item: "public benchmark/brag page").
 *
 * Collects runtime performance data from a live server and exposes it as a
 * standardized JSON endpoint at GET /benchmark. This data can feed a public
 * benchmark page (static HTML dashboard) showing:
 *  - 10k trees at 60fps on mid phone
 *  - N players per browser host
 *  - cold-load seconds per map
 *  - tick duration histogram
 *  - entity counts
 *  - memory usage
 *
 * The benchmark data is deliberately STANDARDIZED -- a single JSON shape
 * that any consumer (static HTML page, CI dashboard, README badge) can read.
 * It is NOT a Prometheus endpoint (that is a separate item, server-scale-prometheus-metrics-endpoint-dashboard).
 *
 * Shape:
 *  GET /benchmark returns:
 *  {
 *    server: {
 *      uptimeMs: number,
 *      tickRate: number,
 *      tickAvgMs: number,
 *      tickP50Ms: number,
 *      tickP99Ms: number,
 *      dilationFactor: number,
 *      playerCount: number,
 *      entityCount: number,
 *      physicsBodyCount: number,
 *      memoryRssMB: number,
 *      memoryHeapMB: number,
 *    },
 *    world: {
 *      name: string,
 *      entityCount: number,
 *      appCount: number,
 *      terrainEnabled: boolean,
 *    },
 *    build: {
 *      sha: string,       // git commit SHA
 *      branch: string,    // "main"
 *      nodeVersion: string,
 *    },
 *    timestamp: number,   // Unix ms
 *  }
 */

import { execSync } from 'node:child_process'

let _sha = null
let _branch = null

function getGitInfo() {
  if (_sha === null) {
    try {
      _sha = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 2000 }).trim()
      _branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', timeout: 2000 }).trim()
    } catch {
      _sha = 'unknown'
      _branch = 'unknown'
    }
  }
  return { sha: _sha, branch: _branch }
}

/**
 * Collect benchmark data from a live server context.
 * Called from the server's HTTP handler for GET /benchmark.
 *
 * @param {object} ctx - server context
 * @param {import('./TickSystem.js').default} ctx.tickSystem
 * @param {import('../apps/AppRuntime.js').default} ctx.appRuntime
 * @param {object} ctx.players - PlayerManager
 * @param {object} ctx.physics - PhysicsWorld
 * @param {object} [ctx.worldDef] - world definition
 */
export function collectBenchmark(ctx) {
  const tickSystem = ctx.tickSystem
  const runtime = ctx.appRuntime
  const players = ctx.players
  const physics = ctx.physics

  const tickStats = tickSystem?.getStats?.() || {}
  const mem = process.memoryUsage()
  const git = getGitInfo()

  return {
    server: {
      uptimeMs: Math.floor(process.uptime() * 1000),
      tickRate: tickSystem?.getTickRate?.() || 0,
      tickAvgMs: tickStats.avgTickMs || 0,
      tickP50Ms: tickStats.p50TickMs || 0,
      tickP99Ms: tickStats.p99TickMs || 0,
      dilationFactor: tickSystem?.dilationFactor || 1,
      playerCount: players?.getPlayerCount?.() || 0,
      entityCount: runtime?.getEntityCount?.() || 0,
      physicsBodyCount: physics?.getBodyCount?.() || 0,
      memoryRssMB: Math.round(mem.rss / 1024 / 1024),
      memoryHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
    },
    world: {
      name: ctx.worldDef?.name || 'unknown',
      entityCount: runtime?.getEntityCount?.() || 0,
      appCount: runtime?.getAppCount?.() || 0,
      terrainEnabled: !!ctx.worldDef?.terrain,
    },
    build: {
      sha: git.sha,
      branch: git.branch,
      nodeVersion: process.version,
    },
    timestamp: Date.now(),
  }
}

/**
 * Register the GET /benchmark endpoint on a Node http.Server.
 * @param {import('node:http').Server} httpServer
 * @param {() => object} collectFn - function returning benchmark data
 */
export function registerBenchmarkEndpoint(httpServer, collectFn) {
  const existingListeners = httpServer.listeners('request').slice()
  httpServer.removeAllListeners('request')

  httpServer.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/benchmark') {
      try {
        const data = collectFn()
        const json = JSON.stringify(data)
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(json)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'benchmark collection failed', detail: err.message }))
      }
      return
    }
    // Pass through to existing handlers
    for (const listener of existingListeners) {
      listener.call(httpServer, req, res)
    }
  })
}