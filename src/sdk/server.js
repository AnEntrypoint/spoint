import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
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
import { saveWorldSnapshot } from './WorldPersistence.js'
import { buildUniquePathList, collectWatchableFiles } from './ServerBoot.js'

const PLACED_MODELS_PERSIST_DEBOUNCE_MS = 500

export async function createServerDeps(config, tickRate) {
  const { gravity = [0, -9.81, 0], playerConfig = {}, storageDir = './data', appsDirs = [], sdkRoot } = config
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
  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage, sdkRoot: resolvedSdkRoot, physicsRadius: config.physicsRadius || 0, physicsBodyBudget: config.physicsBodyBudget || 0, entityTickRate: config.entityTickRate, tickRate, lagCompensator })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, { dirs: appsDirs })
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)
  const _ctxRef = { current: null }
  appLoader._onReloadCallback = (name, code) => {
    const trusted = !!_ctxRef.current?.currentWorldDef?.trustedApps?.includes(name) || undefined
    connections.broadcast(MSG.APP_MODULE, { app: name, code, trusted })
  }
  appLoader._onTreeChangeCallback = () => connections.broadcast(MSG.FS_TREE_CHANGED, {})
  return { physics, emitter, eventBus, eventLog, storage, tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, inspector, reloadManager, appRuntime, appLoader, stageLoader, sdkRoot: resolvedSdkRoot, _ctxRef }
}

export function wireServerHandlers(ctx) {
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, tickSystem, stageLoader, eventLog, reloadManager, sdkRoot } = ctx
  const worldConfigUrl = pathToFileURL(existsSync(resolve(process.cwd(), 'apps/world/index.js')) ? resolve(process.cwd(), 'apps/world/index.js') : join(sdkRoot, 'apps/world/index.js')).href
  const reloadHandlers = createReloadHandlers({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, tickSystem, worldConfigPath: worldConfigUrl, getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0, getWorldTimeOfDayConfig: () => ctx.currentWorldDef?.terrain?.timeOfDay || null, getWorldWeatherConfig: () => ctx.currentWorldDef?.terrain?.weather || null, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } })
  ctx.reloadHandlers = reloadHandlers
  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0, getWorldTimeOfDayConfig: () => ctx.currentWorldDef?.terrain?.timeOfDay || null, getWorldWeatherConfig: () => ctx.currentWorldDef?.terrain?.weather || null, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect
  ctx.setupSDKWatchers = () => {
    const reloadTick = async () => ctx.setTickHandler(await reloadHandlers.reloadTickHandler())
    const sdk = p => join(sdkRoot, p)
    const SPECIFIC_RELOAD = new Map([
      ['src/sdk/TickHandler.js', reloadTick],
      ['src/shared/movement.js', reloadTick],
      ['apps/world/index.js', reloadTick],
      ['src/netcode/PhysicsIntegration.js', reloadHandlers.reloadPhysicsIntegration],
      ['src/netcode/LagCompensator.js', reloadHandlers.reloadLagCompensator],
      ['src/netcode/PlayerManager.js', reloadHandlers.reloadPlayerManager],
      ['src/netcode/NetworkState.js', reloadHandlers.reloadNetworkState]
    ])
    const clientReload = (relPath) => connections.broadcast(MSG.HOT_RELOAD, { timestamp: Date.now(), path: relPath })
    const scanRoots = [sdk('client'), sdk('apps/_lib'), sdk('src/client'), sdk('src/netcode'), sdk('src/shared'), sdk('src/sdk')]
    const discovered = buildUniquePathList(scanRoots.flatMap(root => collectWatchableFiles(root)))
    discovered.push(sdk('apps/world/index.js'))
    for (const absPath of discovered) {
      const relPath = relative(sdkRoot, absPath).split('\\').join('/')
      const id = relPath.replace(/\//g, '-').replace(/\.m?js$/, '')
      const specific = SPECIFIC_RELOAD.get(relPath)
      reloadManager.addWatcher(id, absPath, specific || (() => clientReload(relPath)))
    }
  }
}

export async function createServer(config = {}) {
  const port = config.port || 3000, tickRate = config.tickRate || 60
  const movement = config.movement || {}, staticDirs = config.staticDirs || []
  const deps = await createServerDeps(config, tickRate)
  const ctx = {
    config, port, tickRate, appsDirs: config.appsDirs || [], gravity: config.gravity || [0, -9.81, 0],
    movement, staticDirs, ...deps, currentWorldDef: null, worldSpawnPoint: [0, 5, 0],
    snapshotSeq: 0, httpServer: null, wss: null, wtServer: null,
    handlerState: { fn: null },
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt); deps.connections.flushAll() },
    setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn; ctx.serverTimeOfDay = fn?.serverTimeOfDay || null; ctx.serverWeather = fn?.serverWeather || null }
  }
  let _placedPersistTimer = null, _placedPersistPending = null
  async function _writePlacedModels(placed) {
    const dataDir = resolve(process.cwd(), 'data')
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    const finalPath = resolve(dataDir, 'placed-models.json')
    const tmpPath = finalPath + `.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(tmpPath, JSON.stringify(placed, null, 2))
      await rename(tmpPath, finalPath)
    } catch (e) {
      console.error('[placed-model] persist error:', e.message)
      try { await unlink(tmpPath) } catch { }
    }
  }
  ctx.placedModelStorage = {
    persist(runtime) {
      const placed = []
      const worldDefIds = new Set((ctx.currentWorldDef?.entities || []).map(e => e.id).filter(Boolean))
      for (const [id, entity] of runtime.entities) {
        if (worldDefIds.has(id)) continue
        const isEditorAuthored = id.startsWith('placed-') || entity._appName || entity.custom
        if (!isEditorAuthored) continue
        placed.push({
          id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale],
          config: { collider: entity.custom?._collider || 'none' },
          app: entity._appName || undefined,
          custom: entity.custom || undefined,
          appConfig: entity._config || undefined
        })
      }
      _placedPersistPending = placed
      if (_placedPersistTimer) clearTimeout(_placedPersistTimer)
      _placedPersistTimer = setTimeout(() => {
        _placedPersistTimer = null
        const toWrite = _placedPersistPending
        _placedPersistPending = null
        _writePlacedModels(toWrite).catch(e => console.error('[placed-model] persist error:', e.message))
      }, PLACED_MODELS_PERSIST_DEBOUNCE_MS)
    },
    async flush() {
      if (_placedPersistTimer) { clearTimeout(_placedPersistTimer); _placedPersistTimer = null }
      if (_placedPersistPending) {
        const toWrite = _placedPersistPending
        _placedPersistPending = null
        await _writePlacedModels(toWrite)
      }
    }
  }
  ctx.appRuntime.setPlacedModelStorage(ctx.placedModelStorage)
  if (deps._ctxRef) deps._ctxRef.current = ctx
  wireServerHandlers(ctx)
  deps.tickSystem.onDilation(factor => {
    deps.connections.broadcast(MSG.TICK_DILATION, { factor })
    console.log(`[tick-dilation] factor=${factor}`)
  })
  const api = createServerAPI(ctx)
  if (typeof globalThis.__DEBUG__ === 'undefined') globalThis.__DEBUG__ = {}
  globalThis.__DEBUG__.server = api
  return api
}

export { buildStaticDirs, assertNodeModulesLinked, boot, installGracefulShutdown } from './ServerBoot.js'
