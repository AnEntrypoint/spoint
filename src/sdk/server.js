import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { prewarm } from '../static/GLBTransformer.js'
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
  const uniqPaths = (paths) => {
    const out = []
    const seen = new Set()
    for (const p of paths) {
      const rp = resolve(p)
      if (seen.has(rp)) continue
      seen.add(rp)
      out.push(rp)
    }
    return out
  }
  const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const PROJECT = process.cwd()
  const localWorld = resolve(PROJECT, 'apps/world/index.js')
  const sdkWorld = resolve(SDK_ROOT, 'apps/world/index.js')
  const worldPath = existsSync(localWorld) ? localWorld : sdkWorld
  if (!existsSync(localWorld)) {
    console.log('[boot] no local apps found, using bundled SDK defaults')
  }
  const worldUrl = pathToFileURL(worldPath).href + `?t=${Date.now()}`
  const worldMod = await import(worldUrl)
  const worldDef = worldMod.default || worldMod
  const localApps = resolve(PROJECT, 'apps')
  const sdkApps = join(SDK_ROOT, 'apps')
  const hasLocalApps = existsSync(localApps)
  const appsDirs = uniqPaths(hasLocalApps ? [localApps, sdkApps] : [sdkApps])
  const appsStaticDirs = appsDirs.map(dir => ({ prefix: '/apps/', dir }))
  console.debug(`[boot] loading from: ${appsDirs.join(', ')}`)
  const config = {
    port: parseInt(process.env.PORT || String(worldDef.port || 3000), 10),
    tickRate: worldDef.tickRate || 128,
    appsDirs,
    sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity,
    movement: worldDef.movement,
    playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0,
    entityTickRate: worldDef.entityTickRate,
    staticDirs: [
      { prefix: '/src/', dir: join(SDK_ROOT, 'src') },
      ...appsStaticDirs,
      { prefix: '/node_modules/', dir: join(SDK_ROOT, 'node_modules') },
      { prefix: '/data/', dir: resolve(PROJECT, 'data') },
      { prefix: '/', dir: join(SDK_ROOT, 'client') }
    ],
    ...overrides
  }
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  server.on('playerJoin', ({ id }) => {})
  server.on('playerLeave', ({ id }) => {})
  prewarm(appsDirs).catch(e => console.error('[prewarm] error:', e))
  const info = await server.start()
  console.log(`[server] http://localhost:${info.port} @ ${info.tickRate} TPS`)
  return server
}

export async function createServer(config = {}) {
  const port = config.port || 3000
  const tickRate = config.tickRate || 128
  const appsDirs = config.appsDirs || [config.appsDir || './apps']
  const gravity = config.gravity || [0, -9.81, 0]
  const movement = config.movement || {}
  const staticDirs = config.staticDirs || []

  const storageDir = config.storageDir || './data'
  const playerConfig = config.playerConfig || {}
  const physics = new PhysicsWorld({ gravity, crouchHalfHeight: playerConfig.crouchHalfHeight })
  await physics.init()

  const emitter = new EventEmitter()
  const eventBus = new EventBus()
  const eventLog = new EventLog({ maxSize: 1000 })
  const storage = new FSAdapter(storageDir)
  const tickSystem = new TickSystem(tickRate)
  const playerManager = new PlayerManager()
  const networkState = new NetworkState()
  const lagCompensator = new LagCompensator()
  const physicsIntegration = new PhysicsIntegration({ gravity, physicsWorld: physics, capsuleRadius: playerConfig.capsuleRadius, capsuleHalfHeight: playerConfig.capsuleHalfHeight, crouchHalfHeight: playerConfig.crouchHalfHeight, playerMass: playerConfig.mass })
  const connections = new ConnectionManager({
    heartbeatInterval: config.heartbeatInterval || 1000,
    heartbeatTimeout: config.heartbeatTimeout || 10000
  })
  const sessions = new SessionStore({ ttl: config.sessionTTL || 60000 })
  const inspector = new Inspector()
  const reloadManager = new ReloadManager()

  const sdkRoot = config.sdkRoot || join(dirname(fileURLToPath(import.meta.url)), '../..')
  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage, sdkRoot, physicsRadius: config.physicsRadius || 0, entityTickRate: config.entityTickRate, tickRate: config.tickRate || 128, lagCompensator })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, { dirs: appsDirs })
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)

  appLoader._onReloadCallback = (name, code) => {
    connections.broadcast(MSG.APP_MODULE, { app: name, code })
  }

  const ctx = {
    config,
    port,
    tickRate,
    appsDirs,
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

  ctx.placedModelStorage = {
    persist(runtime) {
      const placed = []
      for (const [id, entity] of runtime.entities) {
        if (!id.startsWith('placed-')) continue
        placed.push({ id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale], config: { collider: entity.custom?._collider || 'none' } })
      }
      try {
        const dataDir = resolve(process.cwd(), 'data')
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
        writeFileSync(resolve(dataDir, 'placed-models.json'), JSON.stringify(placed, null, 2))
      } catch (e) { console.error('[placed-model] persist error:', e.message) }
    }
  }

  const worldConfigUrl = pathToFileURL(existsSync(resolve(process.cwd(), 'apps/world/index.js')) ? resolve(process.cwd(), 'apps/world/index.js') : join(dirname(fileURLToPath(import.meta.url)), '../../apps/world/index.js')).href
  const reloadHandlers = createReloadHandlers({
    networkState,
    playerManager,
    physicsIntegration,
    lagCompensator,
    physics,
    appRuntime,
    connections,
    movement,
    tickRate,
    worldConfigPath: worldConfigUrl
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
    eventLog,
    tickRate,
    getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0
  }))

  const { onClientConnect } = createConnectionHandlers(ctx)
  ctx.onClientConnect = onClientConnect

  ctx.setupSDKWatchers = () => {
    const reloadTick = async () => { ctx.setTickHandler(await reloadHandlers.reloadTickHandler()) }
    const sdk = (p) => join(sdkRoot, p)
    const w = [
      ['tick-handler', sdk('src/sdk/TickHandler.js'), reloadTick],
      ['movement', sdk('src/shared/movement.js'), reloadTick],
      ['world-config', sdk('apps/world/index.js'), reloadTick],
      ['physics-integration', sdk('src/netcode/PhysicsIntegration.js'), reloadHandlers.reloadPhysicsIntegration],
      ['lag-compensator', sdk('src/netcode/LagCompensator.js'), reloadHandlers.reloadLagCompensator],
      ['player-manager', sdk('src/netcode/PlayerManager.js'), reloadHandlers.reloadPlayerManager],
      ['network-state', sdk('src/netcode/NetworkState.js'), reloadHandlers.reloadNetworkState]
    ]
    for (const [id, path, reload] of w) reloadManager.addWatcher(id, path, reload)
    const clientReload = () => { connections.broadcast(MSG.HOT_RELOAD, { timestamp: Date.now() }) }
    const clientFiles = [
      ['client-app', sdk('client/app.js')],
      ['client-camera', sdk('client/camera.js')],
      ['client-input', sdk('src/client/InputHandler.js')],
      ['client-network', sdk('src/client/PhysicsNetworkClient.js')],
      ['client-prediction', sdk('src/client/PredictionEngine.js')],
      ['client-reconciliation', sdk('src/client/ReconciliationEngine.js')],
      ['client-index', sdk('src/index.client.js')]
    ]
    for (const [id, path] of clientFiles) reloadManager.addWatcher(id, path, clientReload)
  }

  const api = createServerAPI(ctx)
  if (typeof globalThis.__DEBUG__ === 'undefined') globalThis.__DEBUG__ = {}
  globalThis.__DEBUG__.server = api
  return api
}
