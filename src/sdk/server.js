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

function buildUniquePathList(paths) {
  const out = [], seen = new Set()
  for (const p of paths) { const rp = resolve(p); if (!seen.has(rp)) { seen.add(rp); out.push(rp) } }
  return out
}

export function buildStaticDirs(sdkRoot, project, appsDirs) {
  return [
    { prefix: '/src/', dir: join(sdkRoot, 'src') },
    ...appsDirs.map(dir => ({ prefix: '/apps/', dir })),
    { prefix: '/node_modules/', dir: join(sdkRoot, 'node_modules') },
    { prefix: '/data/', dir: resolve(project, 'data') },
    { prefix: '/', dir: join(sdkRoot, 'client') }
  ]
}

async function createServerDeps(config) {
  const { gravity = [0, -9.81, 0], playerConfig = {}, storageDir = './data', tickRate = 128, appsDirs = [], sdkRoot } = config
  const physics = new PhysicsWorld({ gravity, crouchHalfHeight: playerConfig.crouchHalfHeight })
  await physics.init()
  const emitter = new EventEmitter(), eventBus = new EventBus(), eventLog = new EventLog({ maxSize: 1000 })
  const storage = new FSAdapter(storageDir), tickSystem = new TickSystem(tickRate)
  const playerManager = new PlayerManager(), networkState = new NetworkState(), lagCompensator = new LagCompensator()
  const physicsIntegration = new PhysicsIntegration({ gravity, physicsWorld: physics, capsuleRadius: playerConfig.capsuleRadius, capsuleHalfHeight: playerConfig.capsuleHalfHeight, crouchHalfHeight: playerConfig.crouchHalfHeight, playerMass: playerConfig.mass })
  const connections = new ConnectionManager({ heartbeatInterval: config.heartbeatInterval || 1000, heartbeatTimeout: config.heartbeatTimeout || 10000 })
  const sessions = new SessionStore({ ttl: config.sessionTTL || 60000 })
  const inspector = new Inspector(), reloadManager = new ReloadManager()
  const resolvedSdkRoot = sdkRoot || join(dirname(fileURLToPath(import.meta.url)), '../..')
  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage, sdkRoot: resolvedSdkRoot, physicsRadius: config.physicsRadius || 0, entityTickRate: config.entityTickRate, tickRate, lagCompensator })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, { dirs: appsDirs })
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)
  appLoader._onReloadCallback = (name, code) => connections.broadcast(MSG.APP_MODULE, { app: name, code })
  return { physics, emitter, eventBus, eventLog, storage, tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, inspector, reloadManager, appRuntime, appLoader, stageLoader, sdkRoot: resolvedSdkRoot }
}

function wireServerHandlers(ctx) {
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, stageLoader, eventLog, reloadManager, sdkRoot } = ctx
  const worldConfigUrl = pathToFileURL(existsSync(resolve(process.cwd(), 'apps/world/index.js')) ? resolve(process.cwd(), 'apps/world/index.js') : join(sdkRoot, 'apps/world/index.js')).href
  const reloadHandlers = createReloadHandlers({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, worldConfigPath: worldConfigUrl })
  ctx.reloadHandlers = reloadHandlers
  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0 }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect
  ctx.setupSDKWatchers = () => {
    const reloadTick = async () => ctx.setTickHandler(await reloadHandlers.reloadTickHandler())
    const sdk = p => join(sdkRoot, p)
    for (const [id, path, reload] of [
      ['tick-handler', sdk('src/sdk/TickHandler.js'), reloadTick], ['movement', sdk('src/shared/movement.js'), reloadTick],
      ['world-config', sdk('apps/world/index.js'), reloadTick], ['physics-integration', sdk('src/netcode/PhysicsIntegration.js'), reloadHandlers.reloadPhysicsIntegration],
      ['lag-compensator', sdk('src/netcode/LagCompensator.js'), reloadHandlers.reloadLagCompensator], ['player-manager', sdk('src/netcode/PlayerManager.js'), reloadHandlers.reloadPlayerManager],
      ['network-state', sdk('src/netcode/NetworkState.js'), reloadHandlers.reloadNetworkState]
    ]) reloadManager.addWatcher(id, path, reload)
    const clientReload = () => connections.broadcast(MSG.HOT_RELOAD, { timestamp: Date.now() })
    for (const [id, path] of [
      ['client-app', sdk('client/app.js')], ['client-animation', sdk('client/animation.js')], ['client-camera', sdk('client/camera.js')],
      ['client-input', sdk('src/client/InputHandler.js')], ['client-network', sdk('src/client/PhysicsNetworkClient.js')],
      ['client-prediction', sdk('src/client/PredictionEngine.js')], ['client-reconciliation', sdk('src/client/ReconciliationEngine.js')],
      ['client-index', sdk('src/index.client.js')]
    ]) reloadManager.addWatcher(id, path, clientReload)
  }
}

export async function createServer(config = {}) {
  const port = config.port || 3000, tickRate = config.tickRate || 128
  const movement = config.movement || {}, staticDirs = config.staticDirs || []
  const deps = await createServerDeps(config)
  const ctx = {
    config, port, tickRate, appsDirs: config.appsDirs || [], gravity: config.gravity || [0, -9.81, 0],
    movement, staticDirs, ...deps, currentWorldDef: null, worldSpawnPoint: [0, 5, 0],
    snapshotSeq: 0, httpServer: null, wss: null, wtServer: null,
    handlerState: { fn: null },
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt) },
    setTickHandler: fn => { ctx.handlerState.fn = fn }
  }
  ctx.placedModelStorage = {
    persist(runtime) {
      const placed = []
      for (const [id, entity] of runtime.entities) {
        if (!id.startsWith('placed-')) continue
        placed.push({ id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale], config: { collider: entity.custom?._collider || 'none' } })
      }
      try { const dataDir = resolve(process.cwd(), 'data'); if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true }); writeFileSync(resolve(dataDir, 'placed-models.json'), JSON.stringify(placed, null, 2)) } catch (e) { console.error('[placed-model] persist error:', e.message) }
    }
  }
  wireServerHandlers(ctx)
  const api = createServerAPI(ctx)
  if (typeof globalThis.__DEBUG__ === 'undefined') globalThis.__DEBUG__ = {}
  globalThis.__DEBUG__.server = api
  return api
}

export async function boot(overrides = {}) {
  const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
  const PROJECT = process.cwd()
  const localWorld = resolve(PROJECT, 'apps/world/index.js')
  const worldPath = existsSync(localWorld) ? localWorld : resolve(SDK_ROOT, 'apps/world/index.js')
  if (!existsSync(localWorld)) console.log('[boot] no local apps found, using bundled SDK defaults')
  const worldDef = (await import(pathToFileURL(worldPath).href + `?t=${Date.now()}`)).default || {}
  const localApps = resolve(PROJECT, 'apps'), sdkApps = join(SDK_ROOT, 'apps')
  const appsDirs = buildUniquePathList(existsSync(localApps) ? [localApps, sdkApps] : [sdkApps])
  console.debug(`[boot] loading from: ${appsDirs.join(', ')}`)
  const config = {
    port: parseInt(process.env.PORT || String(worldDef.port || 3000), 10),
    tickRate: worldDef.tickRate || 128, appsDirs, sdkRoot: SDK_ROOT,
    gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
    physicsRadius: worldDef.physicsRadius || 0, entityTickRate: worldDef.entityTickRate,
    staticDirs: buildStaticDirs(SDK_ROOT, PROJECT, appsDirs),
    ...overrides
  }
  const server = await createServer(config)
  await server.loadWorld(worldDef)
  server.on('playerJoin', () => {}); server.on('playerLeave', () => {})
  prewarm(appsDirs).catch(e => console.error('[prewarm] error:', e))
  const info = await server.start()
  console.log(`[server] http://localhost:${info.port} @ ${info.tickRate} TPS`)
  return server
}
