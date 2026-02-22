import { createServer as createHttpServer } from 'node:http'
import { WebSocketServer as WSServer } from 'ws'
import { MSG } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createStaticHandler } from './StaticHandler.js'
import { WebSocketTransport } from '../transport/WebSocketTransport.js'
import { WebTransportServer } from '../transport/WebTransportServer.js'

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
      if (worldDef.spawnPoint) ctx.worldSpawnPoint = [...worldDef.spawnPoint]
      await appLoader.loadAll()
      const stage = stageLoader.loadFromDefinition('main', worldDef)
      return { entities: new Map(), apps: new Map(), count: stage.entityCount }
    },

    async start() {
      await appLoader.loadAll()
      return new Promise((resolve, reject) => {
        if (staticDirs.length > 0) {
          ctx.httpServer = createHttpServer(createStaticHandler(staticDirs))
          ctx.wss = new WSServer({ server: ctx.httpServer, path: '/ws' })
          ctx.httpServer.on('error', reject)
          ctx.httpServer.listen(port, () => {
            attachWSHandlers(ctx)
            resolve({ port: ctx.port, tickRate: ctx.tickRate })
          })
        } else {
          ctx.wss = new WSServer({ port }, () => {
            attachWSHandlers(ctx)
            resolve({ port: ctx.port, tickRate: ctx.tickRate })
          })
          ctx.wss.on('error', reject)
        }
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
