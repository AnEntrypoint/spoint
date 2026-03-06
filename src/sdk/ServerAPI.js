import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createStaticHandler } from './StaticHandler.js'
import { WebSocketTransport } from '../transport/WebSocketTransport.js'
import { WebTransportServer } from '../transport/WebTransportServer.js'
import { createUploadHandler } from './UploadHandler.js'

export function createServerAPI(ctx) {
  const { config, port, tickRate, staticDirs, appLoader, appRuntime, physics, stageLoader } = ctx
  const { tickSystem, playerManager, networkState, lagCompensator, connections, sessions, inspector, emitter, reloadManager, eventBus, eventLog, storage } = ctx

  return {
    physics,
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
      if (worldDef.spawnPoints?.length) ctx.worldSpawnPoints = worldDef.spawnPoints
      else if (worldDef.spawnPoint) ctx.worldSpawnPoints = [worldDef.spawnPoint]
      ctx.worldSpawnPoint = ctx.worldSpawnPoints?.[0] || worldDef.spawnPoint || [0, 5, 0]
      await appLoader.loadAll()
      const stage = stageLoader.loadFromDefinition('main', worldDef)
      const placedFile = new URL('file://' + process.cwd().replace(/\\/g, '/') + '/data/placed-models.json')
      try {
        const { readFileSync, existsSync } = await import('node:fs')
        const fp = process.cwd() + '/data/placed-models.json'
        if (existsSync(fp)) {
          const placed = JSON.parse(readFileSync(fp, 'utf-8'))
          for (const p of placed) {
            appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: 'placed-model', config: p.config || {} })
          }
          console.log(`[placed-model] loaded ${placed.length} saved entities`)
        }
      } catch (e) { console.error('[placed-model] load error:', e.message) }
      return { entities: new Map(), apps: new Map(), count: stage.entityCount }
    },

    async start() {
      await appLoader.loadAll()
      return new Promise((resolve, reject) => {
        const uploadHandler = createUploadHandler(appRuntime, connections, playerManager)
        const staticHandler = staticDirs.length > 0 ? createStaticHandler(staticDirs) : null
        const httpHandler = (req, res) => {
          if (req.method === 'POST' && req.url === '/upload-model') {
            uploadHandler(req, res); return
          }
          if (staticHandler) staticHandler(req, res)
          else { res.writeHead(404); res.end('not found') }
        }
        ctx.httpServer = createHttpServer(httpHandler)
        ctx.wss = new WSServer({ server: ctx.httpServer, path: '/ws' })
        ctx.httpServer.on('error', reject)
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
      reloadManager.stopAllWatchers()
      connections.destroy()
      sessions.destroyAll()
      if (ctx.wtServer) ctx.wtServer.stop()
      if (ctx.wss) ctx.wss.close()
      if (ctx.httpServer) ctx.httpServer.close()
      physics.destroy()
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
  ctx.appLoader.watchAll()
  ctx.setupSDKWatchers()
}
