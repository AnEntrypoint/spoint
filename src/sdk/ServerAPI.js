import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createStaticHandler } from './StaticHandler.js'
import { WebSocketTransport } from '../transport/WebSocketTransport.js'
import { WebTransportServer } from '../transport/WebTransportServer.js'
import { createUploadHandler } from './UploadHandler.js'
import { setupTerrainStreaming } from '../terrain/TerrainPhysics.js'
import { restoreWorldSnapshot, saveWorldSnapshot } from './WorldPersistence.js'
import {
  handleUploadModel, handleDebugLog, handleClientError, handleDebugServer,
  handleMetrics, handleBenchmark, handleFreddieViz
} from './ServerAPIRoutes.js'
import { createAgentAuthoringHandler } from './AgentAuthoringAPI.js'

const DEFAULT_MINIMAP_RES = 256

export async function bakeMinimapIfMissing(worldName, tcfg, opts = {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const outDir = join(process.cwd(), 'apps', 'world')
  const base = `${worldName}.${tcfg.seed | 0}.minimap`
  const outPng = join(outDir, `${base}.png`)
  if (!opts.force && existsSync(outPng)) return
  const bakeModUrl = pathToFileURL(join(process.cwd(), 'scripts', 'bake-minimap.mjs')).href
  const { bakeMinimap } = await import(bakeModUrl)
  const t0 = Date.now()
  const { png, header } = await bakeMinimap({
    seed: tcfg.seed | 0, radius: tcfg.radius, reliefScale: tcfg.reliefScale, anchorDir: tcfg.anchorDir,
    extent: Number.isFinite(tcfg.minimapExtent) ? tcfg.minimapExtent : Math.min(tcfg.radius * 0.25, 16384),
    res: Number.isFinite(tcfg.minimapRes) ? tcfg.minimapRes : DEFAULT_MINIMAP_RES, center: tcfg.center || [0, 0],
  })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(outPng, png)
  writeFileSync(join(outDir, `${base}.json`), JSON.stringify(header))
  console.log(`[minimap] baked ${base}.png (${header.N}x${header.N}, ${(png.length / 1024).toFixed(1)}KB, height ${header.minHeight}..${header.maxHeight}m) in ${Date.now() - t0}ms`)
}

export function createServerAPI(ctx) {
  const { config, port, tickRate, staticDirs, appLoader, appRuntime, physics, physicsIntegration, stageLoader } = ctx
  const { tickSystem, playerManager, networkState, lagCompensator, connections, sessions, inspector, emitter, reloadManager, eventBus, eventLog, storage } = ctx

  return {
    physics,
    physicsIntegration,
    runtime: appRuntime,
    loader: appLoader,
    tickSystem,
    playerManager,
    networkState,
    lagCompensator,
    connections,
    sessions,
    inspector,
    emitter,
    reloadManager,
    eventBus,
    eventLog,
    storage,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),

    stageLoader,

    async loadWorld(worldDef) {
      ctx.currentWorldDef = worldDef
      appRuntime.worldName = worldDef.name || process.env.WORLD || 'tps-game'
      if (worldDef.spawnPoints?.length) ctx.worldSpawnPoints = worldDef.spawnPoints
      else if (worldDef.spawnPoint) ctx.worldSpawnPoints = [worldDef.spawnPoint]
      ctx.worldSpawnPoint = ctx.worldSpawnPoints?.[0] || worldDef.spawnPoint || [0, 5, 0]
      if (!ctx.config.playerConfig && worldDef.player) {
        const pc = worldDef.player
        if (Number.isFinite(pc.capsuleRadius)) physicsIntegration.config.capsuleRadius = pc.capsuleRadius
        if (Number.isFinite(pc.capsuleHalfHeight)) physicsIntegration.config.capsuleHalfHeight = pc.capsuleHalfHeight
        if (Number.isFinite(pc.crouchHalfHeight)) physicsIntegration.config.crouchHalfHeight = pc.crouchHalfHeight
        if (Number.isFinite(pc.mass)) physicsIntegration.config.playerMass = pc.mass
        console.log('[loadWorld] adopted worldDef.player capsule config into physicsIntegration (createServer() was called without config.playerConfig): ' +
          `radius=${physicsIntegration.config.capsuleRadius} halfHeight=${physicsIntegration.config.capsuleHalfHeight}`)
      }
      if (!ctx.config.gravity && worldDef.gravity) {
        ctx.gravity = [...worldDef.gravity]
        physicsIntegration.config.gravity = [...worldDef.gravity]
      }
      const { loaded: _loadedApps } = await appLoader.loadAll()
      const _loadedSet = new Set(_loadedApps)
      const _missingApps = new Set()
      for (const e of worldDef.entities || []) { if (e.app && !_loadedSet.has(e.app)) _missingApps.add(e.app) }
      if (_missingApps.size) console.error(`[loadWorld] world "${worldDef.name || '(unnamed)'}" references app(s) that failed to load: ${[..._missingApps].join(', ')} -- affected entities will have no server-side app logic`)
      try {
        const _terrainEnt = (worldDef.entities || []).find(e => e.app === 'terrain')
        const _tcfg = (_terrainEnt && _terrainEnt.config) || worldDef.terrain || null
        if (_tcfg && _tcfg.enabled !== false) ctx._terrainStreamer = await setupTerrainStreaming({ physics, playerManager, terrain: _tcfg })
        if (_tcfg && _tcfg.enabled !== false && Number.isFinite(_tcfg.seed)) {
          const _worldId = worldDef.name || process.env.WORLD || 'world'
          worldDef._minimap = { base: `/apps/world/${_worldId}.${_tcfg.seed | 0}.minimap`, center: _tcfg.center || [0, 0], extent: Number.isFinite(_tcfg.minimapExtent) ? _tcfg.minimapExtent : Math.min(_tcfg.radius * 0.25, 16384) }
          bakeMinimapIfMissing(_worldId, _tcfg).catch(e => console.error('[minimap] bake-if-missing failed:', e?.message || e))
        }
      } catch (e) { console.error('[terrain] setup error:', e?.message || e) }
      const stage = stageLoader.loadFromDefinition('main', worldDef)
      try {
        const { readFile, access } = await import('node:fs/promises')
        const fp = process.cwd() + '/data/placed-models.json'
        await access(fp).then(async () => {
          const text = await readFile(fp, 'utf-8')
          const placed = JSON.parse(text)
          const worldDefEntityIds = new Set((worldDef.entities || []).map(e => e.id).filter(Boolean))
          let _skipped = 0
          for (const p of placed) {
            if (worldDefEntityIds.has(p.id)) { _skipped++; continue }
            appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: p.app || 'placed-model', custom: p.custom, config: p.appConfig || p.config || {} })
          }
          console.log(`[placed-model] loaded ${placed.length - _skipped} saved entities${_skipped ? ` (skipped ${_skipped} stale world-def-duplicate records)` : ''}`)
        }).catch(() => {})
      } catch (e) { console.error('[placed-model] load error:', e.message) }
      try { await appRuntime.waitForPendingTrimeshBuilds?.() } catch (e) { console.error('[world-persistence] waitForPendingTrimeshBuilds error:', e.message) }
      try { await restoreWorldSnapshot(ctx) } catch (e) { console.error('[world-persistence] restore error:', e.message) }
      return { entities: new Map(), apps: new Map(), count: stage.entityCount }
    },

    async start() {
      if (ctx.httpServer?.listening) {
        return { port: ctx.port, tickRate: ctx.tickRate }
      }
      await appLoader.loadAll()
      return new Promise((resolve, reject) => {
        const uploadHandler = createUploadHandler(appRuntime, connections, playerManager)
        const getWorldInfo = () => ({
          worldName: ctx.currentWorldDef?.name || process.env.WORLD || 'tps-game',
          worldDef: ctx.currentWorldDef,
          project: process.cwd(),
          sdkRoot: ctx.sdkRoot,
        })
        const staticHandler = staticDirs.length > 0 ? createStaticHandler(staticDirs, { getWorldInfo }) : null
        const handleAgentRoute = createAgentAuthoringHandler()
        const httpHandler = (req, res) => {
          if (req.url.startsWith('/agent/')) { handleAgentRoute(req, res, appRuntime, ctx); return }
          if (req.method === 'POST' && req.url === '/upload-model') { handleUploadModel(req, res, uploadHandler); return }
          if (req.method === 'POST' && req.url === '/debug-log') { handleDebugLog(req, res); return }
          if (req.method === 'POST' && req.url === '/client-error') { handleClientError(req, res); return }
          if (req.method === 'GET' && req.url === '/debug/server') { handleDebugServer(req, res, ctx); return }
          if (req.method === 'GET' && req.url === '/metrics') { handleMetrics(req, res, ctx); return }
          if (req.method === 'GET' && req.url === '/benchmark') { handleBenchmark(req, res, ctx); return }
          if (req.method === 'POST' && req.url === '/freddie/viz') { handleFreddieViz(req, res, appRuntime); return }
          if (staticHandler) {
            Promise.resolve(staticHandler(req, res)).catch(e => {
              console.error('[static] handler error:', e?.message || e)
              if (!res.headersSent) { res.writeHead(500); res.end('internal error') }
            })
          } else { res.writeHead(404); res.end('not found') }
        }
        ctx.httpServer = createHttpServer(httpHandler)
        ctx.wss = new WSServer({ server: ctx.httpServer, path: '/ws', perMessageDeflate: false })
        ctx.httpServer.on('error', (err) => {
          if (err && err.code === 'EADDRINUSE') {
            console.error(
              `\n[server] Port ${port} is already in use.\n` +
              `[server] A spoint server for this project is very likely already running there.\n` +
              `[server] There is ONE server: open http://localhost:${port}/ for multiplayer, or\n` +
              `[server]   http://localhost:${port}/?singleplayer  for the in-browser (singleplayer) mode --\n` +
              `[server]   SAME origin, not a second port. Do NOT start a second instance on a different\n` +
              `[server]   PORT: it would serve a divergent node_modules/asset snapshot (the ':3001 vs\n` +
              `[server]   :8090 look different' drift). Kill the running instance to restart it, e.g.\n` +
              `[server]   (Windows) npx kill-port ${port}   or   (unix) lsof -ti tcp:${port} | xargs kill.\n`
            )
            const e = new Error(`Port ${port} already in use -- a spoint server is already running (see message above).`)
            e.code = 'EADDRINUSE'; e.spointSingleInstance = true
            reject(e); return
          }
          reject(err)
        })
        ctx.httpServer.listen(port, '0.0.0.0', 2048, () => {
          attachWSHandlers(ctx)
          resolve({ port: ctx.port, tickRate: ctx.tickRate })
        })
        ctx.wss.on('error', reject)
      })
    },

    stop() {
      tickSystem.stop()
      appLoader.stopWatching()
      reloadManager.destroy()
      connections.destroy()
      sessions.destroyAll()
      if (ctx._terrainStreamer?.stop) ctx._terrainStreamer.stop()
      if (ctx._terrainStreamer?._trunkStreamer?.stop) ctx._terrainStreamer._trunkStreamer.stop()
      if (ctx._terrainStreamer?._rockStreamer?.stop) ctx._terrainStreamer._rockStreamer.stop()
      if (ctx.wtServer) ctx.wtServer.stop()
      if (ctx.wss) ctx.wss.close()
      if (ctx.httpServer) ctx.httpServer.close()
      physics.destroy()
    },

    async flushAll() {
      const results = await Promise.allSettled([
        ctx.placedModelStorage.flush(),
        appRuntime.runShutdownHooks(),
        saveWorldSnapshot(ctx)
      ])
      results.forEach(r => { if (r.status === 'rejected') console.error('[shutdown] flush error:', r.reason?.message || r.reason) })
    },

    send(id, type, p) {
      return connections.send(id, type, p)
    },

    broadcast(type, p) {
      connections.broadcast(type, p)
    },

    getPlayerCount() {
      return playerManager.getPlayerCount()
    },

    getEntityCount() {
      return appRuntime.entities.size
    },

    getSnapshot() {
      return appRuntime.getSnapshot()
    },

    reloadTickHandler: async () => {
      ctx.setTickHandler(await ctx.reloadHandlers.reloadTickHandler())
    },

    getReloadStats() {
      return reloadManager.getStats()
    },

    getAllStats() {
      return {
        connections: connections.getAllStats(),
        inspector: inspector.getAllClients(connections),
        sessions: sessions.getActiveCount(),
        tick: tickSystem.currentTick,
        players: playerManager.getPlayerCount()
      }
    }
  }
}

function attachWSHandlers(ctx) {
  ctx.wss.on('connection', (socket) => {
    ctx.onClientConnect(new WebSocketTransport(socket))
  })
  if (ctx.config.webTransport) {
    const wtp = ctx.config.webTransport.port || 4433
    ctx.wtServer = new WebTransportServer({
      port: wtp,
      cert: ctx.config.webTransport.cert,
      key: ctx.config.webTransport.key
    })
    ctx.wtServer.on('session', ctx.onClientConnect)
    if (ctx.wtServer.start()) console.log()
  }
  ctx.tickSystem.onTick(ctx.onTick)
  ctx.tickSystem.start()
  if (!process.env.SPOINT_NO_WATCH) {
    ctx.appLoader.watchAll()
    ctx.setupSDKWatchers()
  }
}
