import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { MSG } from '../protocol/MessageTypes.js'
import { ConnectionManager } from '../connection/ConnectionManager.js'
import { SessionStore } from '../connection/SessionStore.js'
import { Inspector } from '../debug/Inspector.js'
import { TickSystem } from '../netcode/TickSystem.js'
import { PlayerManager } from '../netcode/PlayerManager.js'
import { NetworkState } from '../netcode/NetworkState.js'
import { LagCompensator } from '../netcode/LagCompensator.js'
import { PhysicsIntegration } from '../netcode/PhysicsIntegration.js'
import { PhysicsWorld } from '../physics/World.js'
import { AppRuntime } from '../apps/AppRuntime.js'
import { AppLoader } from '../apps/AppLoader.js'
import { StageLoader } from '../stage/StageLoader.js'
import { createTickHandler } from './TickHandler.js'
import { EventEmitter } from '../protocol/EventEmitter.js'
import { EventBus } from '../apps/EventBus.js'
import { EventLog } from '../netcode/EventLog.js'
import { FSAdapter } from '../storage/FSAdapter.js'
import { ReloadManager } from './ReloadManager.js'
import { createReloadHandlers } from './ReloadHandlers.js'
import { createServerAPI } from './ServerAPI.js'
import { createConnectionHandlers } from './ServerHandlers.js'

export async function boot(overrides = {}) {
  const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const PROJECT = process.cwd()
  const localWorld = resolve(PROJECT, 'apps/world/index.js')
  const sdkWorld = resolve(SDK_ROOT, 'apps/world/index.js')
  const worldPath = existsSync(localWorld) ? localWorld : sdkWorld
  const worldUrl = pathToFileURL(worldPath).href + `?t=${Date.now()}`
  const worldMod = await import(worldUrl)
  const worldDef = worldMod.default || worldMod
  const localApps = resolve(PROJECT, 'apps')
  const appsDir = existsSync(localApps) ? localApps : join(SDK_ROOT, 'apps')
  const config = {
    port: parseInt(process.env.PORT || String(worldDef.port || 8080), 10),
    tickRate: worldDef.tickRate || 128,
    appsDir,
    gravity: worldDef.gravity,
    movement: worldDef.movement,
    staticDirs: [
      { prefix: '/src/', dir: join(SDK_ROOT, 'src') },
      { prefix: '/apps/', dir: appsDir },
      { prefix: '/node_modules/', dir: join(SDK_ROOT, 'node_modules') },
      { prefix: '/', dir: join(SDK_ROOT, 'client') }
    ],
    ...overrides
  }
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  server.on('playerJoin', ({ id }) => console.log())
  server.on('playerLeave', ({ id }) => console.log())
  const info = await server.start()
  console.log(`[server] http://localhost:${info.port} @ ${info.tickRate} TPS`)
  return server
}

export async function createServer(config = {}) {
  const port = config.port || 8080
  const tickRate = config.tickRate || 128
  const appsDir = config.appsDir || './apps'
  const gravity = config.gravity || [0, -9.81, 0]
  const movement = config.movement || {}
  const staticDirs = config.staticDirs || []

  const storageDir = config.storageDir || './data'
  const physics = new PhysicsWorld({ gravity })
  await physics.init()

  const emitter = new EventEmitter()
  const eventBus = new EventBus()
  const eventLog = new EventLog()
  const storage = new FSAdapter(storageDir)
  const tickSystem = new TickSystem(tickRate)
  const playerManager = new PlayerManager()
  const networkState = new NetworkState()
  const lagCompensator = new LagCompensator()
  const physicsIntegration = new PhysicsIntegration({ gravity, physicsWorld: physics })
  const connections = new ConnectionManager({
    heartbeatInterval: config.heartbeatInterval || 1000,
    heartbeatTimeout: config.heartbeatTimeout || 3000
  })
  const sessions = new SessionStore({ ttl: config.sessionTTL || 30000 })
  const inspector = new Inspector()
  const reloadManager = new ReloadManager()

  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, { dir: appsDir })
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)

  appLoader._onReloadCallback = (name, code) => {
    connections.broadcast(MSG.APP_MODULE, { app: name, code })
  }

  const ctx = {
    config,
    port,
    tickRate,
    appsDir,
    gravity,
    movement,
    staticDirs,
    physics,
    emitter,
    tickSystem,
    playerManager,
    networkState,
    lagCompensator,
    physicsIntegration,
    connections,
    sessions,
    inspector,
    reloadManager,
    eventBus,
    eventLog,
    storage,
    appRuntime,
    appLoader,
    stageLoader,
    currentWorldDef: null,
    worldSpawnPoint: [0, 5, 0],
    snapshotSeq: 0,
    httpServer: null,
    wss: null,
    wtServer: null,
    handlerState: { fn: null },
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt) },
    setTickHandler: (fn) => { ctx.handlerState.fn = fn }
  }

  const reloadHandlers = createReloadHandlers({
    networkState,
    playerManager,
    physicsIntegration,
    lagCompensator,
    physics,
    appRuntime,
    connections
  })
  ctx.reloadHandlers = reloadHandlers

  ctx.setTickHandler(createTickHandler({
    networkState,
    playerManager,
    physicsIntegration,
    lagCompensator,
    physics,
    appRuntime,
    connections,
    movement,
    stageLoader,
    eventLog
  }))

  const { onClientConnect } = createConnectionHandlers(ctx)
  ctx.onClientConnect = onClientConnect

  ctx.setupSDKWatchers = () => {
    const reloadTick = async () => { ctx.setTickHandler(await reloadHandlers.reloadTickHandler()) }
    const w = [
      ['tick-handler', './src/sdk/TickHandler.js', reloadTick],
      ['movement', './src/shared/movement.js', reloadTick],
      ['physics-integration', './src/netcode/PhysicsIntegration.js', reloadHandlers.reloadPhysicsIntegration],
      ['lag-compensator', './src/netcode/LagCompensator.js', reloadHandlers.reloadLagCompensator],
      ['player-manager', './src/netcode/PlayerManager.js', reloadHandlers.reloadPlayerManager],
      ['network-state', './src/netcode/NetworkState.js', reloadHandlers.reloadNetworkState]
    ]
    for (const [id, path, reload] of w) reloadManager.addWatcher(id, path, reload)
    const clientReload = () => { connections.broadcast(MSG.HOT_RELOAD, { timestamp: Date.now() }) }
    const clientFiles = [
      ['client-app', './client/app.js'],
      ['client-camera', './client/camera.js'],
      ['client-input', './src/client/InputHandler.js'],
      ['client-network', './src/client/PhysicsNetworkClient.js'],
      ['client-prediction', './src/client/PredictionEngine.js'],
      ['client-reconciliation', './src/client/ReconciliationEngine.js'],
      ['client-index', './src/index.client.js']
    ]
    for (const [id, path] of clientFiles) reloadManager.addWatcher(id, path, clientReload)
  }

  const api = createServerAPI(ctx)
  if (typeof globalThis.__DEBUG__ === 'undefined') globalThis.__DEBUG__ = {}
  globalThis.__DEBUG__.server = api
  return api
}
