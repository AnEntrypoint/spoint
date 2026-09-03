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

// tickRate: caller (createServer) already resolved config.tickRate||128 and passes it in explicitly --
// never re-derive the ||128 default here, or a future edit to only one of the two literals would silently
// desync ctx.tickRate (exposed to handshake/TickHandler) from the TickSystem/AppRuntime this function builds.
// Exported (alongside wireServerHandlers below) so a region-shard worker process
// (src/sharding/RegionWorkerEntry.js) can boot a real, independent Jolt-world + tick + connection
// stack using the EXACT SAME construction path as the single-process server -- no parallel
// reimplementation to drift out of sync. See src/sharding/RegionRouter.js for the process that
// spawns N of these.
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
  const { networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, stageLoader, eventLog, reloadManager, sdkRoot } = ctx
  const worldConfigUrl = pathToFileURL(existsSync(resolve(process.cwd(), 'apps/world/index.js')) ? resolve(process.cwd(), 'apps/world/index.js') : join(sdkRoot, 'apps/world/index.js')).href
  // getRelevanceRadius/getWorldTimeOfDayConfig threaded through so a hot-reloaded TickHandler (see
  // reloadTickHandler below, spreads THIS deps object) keeps both live-config accessors instead of
  // silently losing them on the very first server-code reload after boot.
  // onAutoSave threaded through here too (reloadTickHandler below spreads THIS deps object into the
  // rebuilt createTickHandler call) so a hot-reload of TickHandler.js/movement.js/apps/world/index.js
  // (see SPECIFIC_RELOAD below) never silently drops the periodic world-snapshot wiring -- same discipline
  // as getRelevanceRadius/getWorldTimeOfDayConfig/getWorldWeatherConfig immediately above.
  const reloadHandlers = createReloadHandlers({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, tickRate, worldConfigPath: worldConfigUrl, getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0, getWorldTimeOfDayConfig: () => ctx.currentWorldDef?.terrain?.timeOfDay || null, getWorldWeatherConfig: () => ctx.currentWorldDef?.terrain?.weather || null, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } })
  ctx.reloadHandlers = reloadHandlers
  // getWorldTimeOfDayConfig/getWorldWeatherConfig: read fresh (not captured) at createTickHandler call
  // time, same once-per-handler-build timing as getRelevanceRadius immediately below -- a world reload
  // rebuilds the whole TickHandler via reloadTick, which re-reads whatever worldDef.terrain.timeOfDay/
  // weather is live then. This is the real multiplayer WS server path, so both server-authoritative
  // time-of-day (see ServerTimeOfDay.js) and server-authoritative weather (see ServerWeather.js) are
  // available here (each opt-in per-world via their own .serverAuthoritative flag).
  // server-scale-persistent-world-snapshot-restart-survival: TickHandler.js's AUTO_SAVE_INTERVAL (300s)
  // gate already exists and is already tick-budgeted (a single `tick % N === 0` check, real cost paid only
  // once per interval) -- it was constructed years before this row but never wired to a real callback by
  // any caller. saveWorldSnapshot is itself async and does its own I/O off the tick's synchronous path
  // (see WorldPersistence.js's own header comment); errors are caught inside it and never thrown back into
  // onTick, so a save failure (disk full, permissions) degrades to "world stays live, next save retries in
  // 5 minutes" rather than crashing the tick loop -- matches this codebase's full->degraded->safe-fail
  // discipline. Fire-and-forget from onAutoSave's own try/catch wrapper (TickHandler.js line ~881) since
  // onAutoSave itself is called synchronously but is not awaited there.
  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => ctx.currentWorldDef?.relevanceRadius || 0, getWorldTimeOfDayConfig: () => ctx.currentWorldDef?.terrain?.timeOfDay || null, getWorldWeatherConfig: () => ctx.currentWorldDef?.terrain?.weather || null, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect
  ctx.setupSDKWatchers = () => {
    const reloadTick = async () => ctx.setTickHandler(await reloadHandlers.reloadTickHandler())
    const sdk = p => join(sdkRoot, p)
    // Server-side modules whose edits need a SPECIFIC reload function (tick handler rebuild,
    // physics/lag/player/network-state hot-swap) rather than the generic client broadcast.
    // Keyed by sdk-root-relative path (as produced by collectWatchableFiles) so the scan below
    // can look each discovered file up here and fall through to the generic client-reload
    // path for everything else it finds under the watched directories.
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
    // Derived, not hand-maintained: scan the directories that actually matter for hot-reload
    // (client/ for the browser bundle, apps/_lib/ for the shared app-authoring library apps
    // import, and the specific src/sdk + src/shared + src/netcode + src/client server modules
    // above) and register a watcher per discovered file. A file dropped into any of these
    // directories is picked up automatically on the next server boot -- no array edit needed.
    const scanRoots = [sdk('client'), sdk('apps/_lib'), sdk('src/client'), sdk('src/netcode'), sdk('src/shared'), sdk('src/sdk')]
    const discovered = buildUniquePathList(scanRoots.flatMap(root => collectWatchableFiles(root)))
    // apps/world/index.js is outside the scan roots above (apps/world/ holds per-world defs,
    // not shared library code) but is still a named specific-reload target, so add it explicitly.
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
  // 60Hz simulation floor (was 128): snapshot broadcast is already decoupled from tick rate via
  // TickHandler's SNAP_RATE_MIN_HZ/MAX_HZ (8-30Hz, player-count/RTT/cost-adaptive), so halving the raw
  // tick rate roughly halves per-tick CPU (physics step + movement + snapshot-interval bookkeeping) for
  // 1000-player feasibility without changing wire cadence. See AGENTS.md drop-server-tick-rate-to-60hz.
  const port = config.port || 3000, tickRate = config.tickRate || 60
  const movement = config.movement || {}, staticDirs = config.staticDirs || []
  const deps = await createServerDeps(config, tickRate)
  const ctx = {
    config, port, tickRate, appsDirs: config.appsDirs || [], gravity: config.gravity || [0, -9.81, 0],
    movement, staticDirs, ...deps, currentWorldDef: null, worldSpawnPoint: [0, 5, 0],
    snapshotSeq: 0, httpServer: null, wss: null, wtServer: null,
    handlerState: { fn: null },
    // flushAll() coalesces every send()/broadcast()/sendPacked() queued by this tick's handler (snapshot,
    // heartbeat-ack, app events, etc landing in the same tick for the same client) into a single
    // socket.send() per client, reliable and unreliable framed separately -- see ConnectionManager.flushAll.
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt); deps.connections.flushAll() },
    // ctx.serverTimeOfDay/ctx.serverWeather: mirror fn.serverTimeOfDay/fn.serverWeather (see
    // TickHandler.js's onTick.serverTimeOfDay/onTick.serverWeather attach) onto ctx itself so
    // ServerHandlers.js's onClientConnect (which only ever sees ctx, never the raw handler fn) can read
    // the CURRENT day-cycle fraction / weather state for a one-time join-time sync send. Re-set on every
    // call including a hot-reload rebuild (reloadTick above), so a reload never leaves ctx pointing at a
    // stale/torn-down instance.
    // ctx.tickHandlerFn mirrors ctx.handlerState.fn under a name ServerAPI.js's /metrics route (server-scale-
    // prometheus-metrics-endpoint-dashboard) can read directly -- handlerState.fn is reload-swappable
    // internal plumbing (see reloadTick below), so a stable ctx.* alias avoids the /metrics route reaching
    // into handlerState's own internals. Re-set on every call including hot-reload, same discipline as
    // ctx.serverTimeOfDay/ctx.serverWeather immediately below, so a reload never leaves it pointing stale.
    setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn; ctx.serverTimeOfDay = fn?.serverTimeOfDay || null; ctx.serverWeather = fn?.serverWeather || null }
  }
  // Debounced (500ms, trailing) + atomic (temp-file + rename): every editor edit (drag, scale nudge,
  // property tweak) calls persist() fire-and-forget, and an unbounced writeFileSync per keystroke both
  // blocked the tick thread and could interleave a torn/partial JSON file with a concurrent reader
  // (server.js's own boot-time load, or a mid-write process kill). A temp-file write + rename is atomic
  // on both POSIX and NTFS (rename replaces the destination in one filesystem op), so a reader always
  // either sees the old complete file or the new complete file, never a half-written one.
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
      try { await unlink(tmpPath) } catch { /* tmp file never created or already gone */ }
    }
  }
  ctx.placedModelStorage = {
    persist(runtime) {
      const placed = []
      // World-def-authored entity ids (terrain, tps-game, powerup_*, env-sillos, ...) are already owned
      // and re-spawned by stageLoader.loadFromDefinition() on every boot -- they must NEVER also flow
      // into placed-models.json, or the boot-time placed-model loader (ServerAPI.js loadWorld) would call
      // appRuntime.spawnEntity() a SECOND time with the same id, silently overwriting the Map entry
      // (losing the first spawn's physics body reference -- a leak) and potentially double-attaching the
      // app. Only an entity absent from the world def is genuinely editor-placed-at-runtime and belongs here.
      const worldDefIds = new Set((ctx.currentWorldDef?.entities || []).map(e => e.id).filter(Boolean))
      for (const [id, entity] of runtime.entities) {
        if (worldDefIds.has(id)) continue
        // Ground truth for "editor-authored, must survive a raw reload" mirrors serializeWorld's own
        // criterion (SAVE_WORLD) rather than the old id-prefix check: id.startsWith('placed-') only ever
        // matched PLACE_MODEL/GLB placements, silently excluding every PLACE_APP-spawned entity (id =
        // appName+'-'+random, e.g. trigger-volume-xxxxx) and primitive (box-static-xxxxx) from the
        // debounced auto-persist -- those edits (position, custom props, radius gizmo, etc.) all vanished
        // on a plain page reload unless the maker explicitly hit SAVE_WORLD. An entity is persist-worthy
        // here if it carries an app OR editor-authored custom state (same "has real content" bar as
        // serializeWorld's own filter); a bare model-less/app-less anchor is skipped.
        if (!id.startsWith('placed-') && !entity._appName && !entity.custom) continue
        placed.push({
          id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale],
          config: { collider: entity.custom?._collider || 'none' },
          app: entity._appName || undefined,
          custom: entity.custom || undefined,
          appConfig: entity._config || undefined
        })
      }
      // trailing-edge debounce: rapid-fire edits (gizmo drag emits many EDITOR_UPDATEs) collapse into
      // one write of the LATEST state, 500ms after the last edit in the burst -- always the newest
      // snapshot, never a stale mid-burst one.
      _placedPersistPending = placed
      if (_placedPersistTimer) clearTimeout(_placedPersistTimer)
      _placedPersistTimer = setTimeout(() => {
        _placedPersistTimer = null
        const toWrite = _placedPersistPending
        _placedPersistPending = null
        _writePlacedModels(toWrite).catch(e => console.error('[placed-model] persist error:', e.message))
      }, 500)
    },
    // Forces the pending debounced write (if any) to happen immediately -- used on graceful shutdown
    // so the last burst of edits before exit isn't lost waiting on a timer that never fires.
    async flush() {
      if (_placedPersistTimer) { clearTimeout(_placedPersistTimer); _placedPersistTimer = null }
      if (_placedPersistPending) {
        const toWrite = _placedPersistPending
        _placedPersistPending = null
        await _writePlacedModels(toWrite)
      }
    }
  }
  // hotreload-migrate-entity-custom-field: lets HotReloadQueue._execute's migrate() path trigger the same
  // debounced placed-models.json persist an editor edit already triggers, so a live custom-shape migration
  // reaches disk without waiting on an unrelated future editor edit to happen to fire one.
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

// Re-exported from ServerBoot.js for backward compatibility -- every existing caller imports
// boot/buildStaticDirs/assertNodeModulesLinked/installGracefulShutdown from this file's own path.
export { buildStaticDirs, assertNodeModulesLinked, boot, installGracefulShutdown } from './ServerBoot.js'
