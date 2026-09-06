import { MSG } from '../protocol/MessageTypes.js'
import { ensurePacked } from '../protocol/msgpack.js'
import { ConnectionManager } from '../connection/ConnectionManager.js'
import { SessionStore } from '../connection/SessionStore.js'
import { Inspector } from '../debug/Inspector.js'
import { TickSystem } from '../netcode/TickSystem.js'
import { PlayerManager } from '../netcode/PlayerManager.js'
import { NetworkState } from '../netcode/NetworkState.js'
import { LagCompensator } from '../netcode/LagCompensator.js'
import { PhysicsIntegration } from '../netcode/PhysicsIntegration.js'
import { PhysicsWorld, getJolt } from '../physics/World.js'
// warm Jolt WASM compile before INIT arrives; getJolt memoizes so physics.init() reuses it, no double compile
const _joltWarm = getJolt().catch(() => {})
import { AppRuntime } from '../apps/AppRuntime.js'
import { AppLoader } from '../apps/AppLoader.js'
import { StageLoader } from '../stage/StageLoader.js'
import { createTickHandler } from './TickHandler.js'
import { EventEmitter } from '../protocol/EventEmitter.js'
import { EventBus } from '../apps/EventBus.js'
import { EventLog } from '../netcode/EventLog.js'
import { IDBAdapter } from '../storage/IDBAdapter.js'
import { WorkerTransport, PeerTransport } from '../transport/WorkerTransport.js'
import { createConnectionHandlers } from './ServerHandlers.js'
import { setupTerrainStreaming, loadPlanetSampler } from '../terrain/TerrainPhysics.js'
import { allocateRingBuffer, TransformRingWriter } from '../transport/TransformRing.js'
// server-scale-worldpersistence-singleplayer-workerentry: this file already builds `storage` as a real
// IDBAdapter (line ~58 below) satisfying the exact StorageAdapter get/set/delete/list/has interface
// WorldPersistence.js hard-requires -- so, contrary to this row's own initial framing ("has no
// ctx.storage/fs today"), the storage half was ALREADY present; the real gap (confirmed by re-reading
// this file end-to-end this session) is narrower: `physics` was never attached to `ctx` itself (only
// passed as a bare local into createTickHandler/AppRuntime), so WorldPersistence.js's ctx.physics reads
// were undefined, and createTickHandler was never given an onAutoSave callback, so TickHandler.js's
// already-generic AUTO_SAVE_INTERVAL tick%N gate (src/sdk/TickHandler.js:887, deps.onAutoSave?.()) never
// fired here. Zero new persistence mechanism needed -- this is a straight extension of the ALREADY-SHIPPED
// server.js wiring pattern (ctx.physics + onAutoSave + a restore-after-spawn call), reusing WorldPersistence.js
// completely unchanged.
import { saveWorldSnapshot, restoreWorldSnapshot } from './WorldPersistence.js'

if (typeof setImmediate === 'undefined') globalThis.setImmediate = fn => setTimeout(fn, 0)

let _ctx = null, _pending = [], _terrainStreamer = null, _transformRing = null

// Exported (edge-cf-durable-object-transport-adapter-real-websocketpair) so a Cloudflare Durable
// Object can call this exact boot sequence directly against its own real WebSocketPair-backed
// transport, instead of the browser-Worker postMessage glue below (which a DO has no use for --
// see the typeof self.postMessage guard on that glue, added the same session: real workerd defines
// `self` but NOT `self.postMessage`, so the unconditional top-level call this file always made
// would otherwise throw during module evaluation the instant a DO imports this file, before init()
// is ever reachable -- live-reproduced via a real `wrangler dev` workerd instance). Every existing
// browser-Worker caller (client/BrowserServer.js's real Worker boot) is byte-unchanged: self exists
// and self.postMessage is a real function there, so the guard is always true and this glue runs
// exactly as before.
export async function init({ worldDef, apps = [], migrationSnapshot = null, localPubkey = null, timeOfDaySeed = null }) {
  await ensurePacked
  // timeOfDaySeed ({t, dayLengthSec, atMs}): the last TIME_OF_DAY_SYNC the PREVIOUS in-page server
  // delivered (see BrowserServer.js's tap), threaded here so a rebuilt worker's ServerTimeOfDay
  // reconstructs elapsed day-cycle time instead of resetting to startFraction -- the stall-recovery
  // refocus path used to throw the clock back to noon on every rebuild (live-witnessed as the
  // day/night snap behind the flat-lighting user reports). Inert unless this world opted into
  // serverAuthoritative time-of-day; ServerTimeOfDay._resolve() re-checks the dayLength match.
  if (timeOfDaySeed && worldDef?.terrain?.timeOfDay && worldDef.terrain.timeOfDay.serverAuthoritative === true) {
    worldDef.terrain.timeOfDay.seed = timeOfDaySeed
  }
  const gravity = worldDef.gravity || [0, -9.81, 0]
  const playerConfig = worldDef.player || {}
  // 60Hz simulation floor (was 128) -- mirrors the server-side default in src/sdk/server.js; keep the two
  // in sync (singleplayer boots this in-Worker path instead of the real HTTP server).
  const tickRate = worldDef.tickRate || 60

  // physics.init() awaited later (just before tick start) so WASM compile overlaps app loadFromString below
  const physics = new PhysicsWorld({ gravity, crouchHalfHeight: playerConfig.crouchHalfHeight })
  const physicsReady = physics.init()

  if (worldDef.terrain && worldDef.terrain.enabled !== false) {
    loadPlanetSampler({ radius: worldDef.terrain.radius, hpfTexRes: (worldDef.terrain.physics || {}).hpfTexRes, seed: worldDef.terrain.seed, reliefScale: worldDef.terrain.reliefScale }).catch(() => {})
  }

  const emitter = new EventEmitter(), eventBus = new EventBus(), eventLog = new EventLog({ maxSize: 1000 })
  const storage = new IDBAdapter(), tickSystem = new TickSystem(tickRate)
  const playerManager = new PlayerManager(), networkState = new NetworkState(), lagCompensator = new LagCompensator()
  const physicsIntegration = new PhysicsIntegration({ gravity, physicsWorld: physics, capsuleRadius: playerConfig.capsuleRadius, capsuleHalfHeight: playerConfig.capsuleHalfHeight, crouchHalfHeight: playerConfig.crouchHalfHeight, playerMass: playerConfig.mass })
  const connections = new ConnectionManager({ heartbeatInterval: 1000, heartbeatTimeout: 10000 })
  const sessions = new SessionStore({ ttl: 60000 })
  const inspector = new Inspector()
  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage, sdkRoot: '', physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0, entityTickRate: worldDef.entityTickRate, tickRate, lagCompensator })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, {})
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)
  appLoader._onReloadCallback = (name, code) => connections.broadcast(MSG.APP_MODULE, { app: name, code })

  const _appLoadResults = await Promise.all(apps.map(({ name, source, deps, module }) => {
    if (module) {
      // Edge target: already-statically-imported module object, no runtime eval needed
      const ok = appLoader.loadFromModule(name, module)
      return Promise.resolve({ name, ok: !!ok })
    }
    return appLoader.loadFromString(name, source, deps).then(ok => ({ name, ok: !!ok }))
  }))
  const _failedApps = _appLoadResults.filter(r => !r.ok).map(r => r.name)
  if (_failedApps.length) console.error(`[WorkerEntry] app(s) failed to load: ${_failedApps.join(', ')} -- referencing entities will have no server-side app logic`)

  const ctx = {
    config: {}, tickRate, gravity, movement: worldDef.movement || {},
    emitter, eventBus, eventLog, storage, tickSystem, playerManager, networkState,
    // physics: mirrors server.js's ctx.physics (spread in from createServerDeps there) -- WorldPersistence.js's
    // buildWorldSnapshot/restoreWorldSnapshot both read ctx.physics directly (getBodyPosition/Rotation/
    // Velocity/AngularVelocity + restoreBodies); without this the calls below would silently no-op every
    // dynamic-body field (appRuntime.snapshotGameState/restoreGameState still round-trip fine on their own,
    // just missing physics-simulated position/velocity refinement).
    physics,
    lagCompensator, physicsIntegration, connections, sessions, inspector,
    appRuntime, appLoader, stageLoader, sdkRoot: '',
    currentWorldDef: worldDef, worldSpawnPoint: worldDef.spawnPoint || [0, 5, 0],
    worldSpawnPoints: worldDef.spawnPoints || [worldDef.spawnPoint || [0, 5, 0]],
    snapshotSeq: 0, handlerState: { fn: null },
    // must flush the per-tick coalescing outbox (ConnectionManager.send/broadcast/sendPacked now enqueue
    // rather than send immediately) -- mirrors src/sdk/server.js's createServer ctx.onTick.
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt); connections.flushAll() },
    // ctx.serverTimeOfDay/ctx.serverWeather: mirror fn.serverTimeOfDay/fn.serverWeather (see
    // TickHandler.js's onTick.serverTimeOfDay/onTick.serverWeather attach) onto ctx so
    // ServerHandlers.js's onClientConnect can read the current day-cycle fraction / weather state for a
    // one-time join-time sync send. Singleplayer (this file) passes BOTH getWorldTimeOfDayConfig and
    // getWorldWeatherConfig at the createTickHandler call below for symmetry with the real server.js path
    // (see that call's own comment) -- a singleplayer world opting into either .serverAuthoritative flag
    // would still be honored (harmless since a singleplayer session has no OTHER client to sync to), but
    // every shipped world today leaves both unset/false, so this is a no-op in practice, not a behavior change.
    // ctx.tickHandlerFn: same stable-alias convention as server.js's setTickHandler (server-scale-
    // prometheus-metrics-endpoint-dashboard's /metrics route reads it) -- singleplayer's Worker path never
    // opens an httpServer so /metrics is unreachable here in practice, but keeping the alias means
    // ServerAPI.js's route code needs no isNode/isWorker fork to stay correct if that ever changes.
    setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn; ctx.serverTimeOfDay = fn?.serverTimeOfDay || null; ctx.serverWeather = fn?.serverWeather || null },
    placedModelStorage: { persist: runtime => _persistPlaced(runtime, storage, worldDef) }
  }
  // hotreload-migrate-entity-custom-field: same wiring as server.js -- see AppRuntime.setPlacedModelStorage's comment.
  appRuntime.setPlacedModelStorage(ctx.placedModelStorage)

  // Kick the placed-models IndexedDB read now so it overlaps the Jolt WASM init await below instead
  // of serializing behind it (it is consumed only after physicsReady, see `placed` below; IDBAdapter
  // opens its DB lazily on construction so this is safe to start this early).
  const placedPromise = storage.get('placed-models').catch(e => { console.warn('[world-persistence] placed-models read failed:', e?.message || e); return null })
  await physicsReady
  // terrain heightfield build stays backgrounded (not awaited) so init/worldDef/snapshot reach the client without delay
  // must run before stage load: tps-game's spawn-finder raycasts and excludes the terrain body, and races it if streaming starts from the app's own setup instead (witnessed 77->4 spawn points)
  const _terrainEnt = (worldDef.entities || []).find(e => e.app === 'terrain')
  const _tcfg = (_terrainEnt && _terrainEnt.config) || worldDef.terrain || null
  // Singleplayer runs entirely in-Worker (no fs, no bake-if-missing hook -- see
  // src/sdk/ServerAPI.js's bakeMinimapIfMissing, which is Node-fs-only and never called from here).
  // Still publish the SAME _minimap metadata shape a real server boot would (minimap-hud-editor-ui-
  // integration): a prior real `node server.js` run for this same world/seed may already have baked
  // apps/world/<id>.<seed>.minimap.png on disk, and the client's static fetch degrades to "no minimap"
  // on a 404 either way -- no worse than a real server that hasn't baked yet. worldDef.name is unset
  // for every shipped world (tps-game.js has none); 'tps-game' matches both server.js's own
  // process.env.WORLD default AND client/app.js's _worldParam-less singleplayer default, so this
  // produces the identical filename a real boot for the same world would.
  if (_tcfg && _tcfg.enabled !== false && Number.isFinite(_tcfg.seed)) {
    const _worldId = worldDef.name || 'tps-game'
    worldDef._minimap = { base: `/apps/world/${_worldId}.${_tcfg.seed | 0}.minimap`, center: _tcfg.center || [0, 0], extent: Number.isFinite(_tcfg.minimapExtent) ? _tcfg.minimapExtent : Math.min(_tcfg.radius * 0.25, 16384) }
  }
  if (_tcfg && _tcfg.enabled !== false) {
    setupTerrainStreaming({ physics, playerManager, terrain: _tcfg })
      // must assign to ctx._terrainStreamer (not just the module-local _terrainStreamer var above) --
      // src/sdk/EditorHandlers.js's TERRAIN_SCULPT handler (shared by raise+lower, wired into this same
      // ctx via ServerHandlers.js's createEditorHandlers(ctx)) reads ctx._terrainStreamer specifically;
      // leaving it unset here silently no-ops every sculpt request in singleplayer (mirrors the pattern
      // src/sdk/ServerAPI.js already uses for the real multiplayer server, which is unaffected).
      .then(s => { _terrainStreamer = s; ctx._terrainStreamer = s })
      .catch(e => console.error('[terrain] heightfield install error:', e?.message || e))
  }
  const placed = await placedPromise || []
  // p.app carries the real app name for a PLACE_APP-spawned entity (trigger-volume, button, spawn-point,
  // etc. -- see _persistPlaced below); a legacy record with no app field predates that change and is
  // always a plain PLACE_MODEL/GLB placement, so it still falls back to 'placed-model' for backward-compat
  // with existing IndexedDB 'placed-models' records written before this fix. p.custom restores
  // editor-authored custom.* (radius, color, _collider, etc.); p.appConfig restores the app's seeded
  // _config (editorProp defaults). Mirrors src/sdk/ServerAPI.js's loadWorld placed-models.json restore.
  // worldDefEntityIds guards against a stale IndexedDB 'placed-models' record written before
  // _persistPlaced's own worldDefIds exclusion existed (see that function's comment): such a record
  // would carry a world-def-authored entity (e.g. env-sillos) as ALSO a persisted placement, and
  // restoring it here would call appRuntime.spawnEntity() a second time for an id
  // stageLoader.loadFromDefinition below is about to (re-)spawn from worldDef itself -- a real
  // double-spawn (duplicate mesh instance, duplicate shadow-casting geometry at the same world
  // position) that this filter now prevents at restore time regardless of when the stale record
  // was written.
  const worldDefEntityIds = new Set((worldDef.entities || []).map(e => e.id).filter(Boolean))
  for (const p of placed) { if (worldDefEntityIds.has(p.id)) continue; appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: p.app || 'placed-model', custom: p.custom, config: p.appConfig || p.config || {} }) }

  // getWorldTimeOfDayConfig/getWorldWeatherConfig wired through for symmetry with the real server.js path
  // (see its own comment) -- a singleplayer world's terrain.timeOfDay/weather.serverAuthoritative would
  // still be honored if ever set (harmless since a singleplayer session has no OTHER client to sync to),
  // but every shipped world today leaves both unset/false, so this is a no-op in practice, not a
  // behavior change.
  // SharedArrayBuffer transform-ring hot path (physics-dedicated-worker-transform-offload): only
  // allocated when globalThis.crossOriginIsolated is real (see TransformRing.js's isRingAvailable) --
  // allocateRingBuffer returns null otherwise, and _transformRing stays null, so every downstream use
  // is a plain null-check no-op. Capacity 64 covers this in-Worker singleplayer/host path generously
  // (one local player plus any wireweave-peer/host-migration reconnects sharing the same worker) without
  // meaningfully sizing the SharedArrayBuffer (64*12*8 bytes = 6144 bytes total).
  _transformRing = allocateRingBuffer(64)
  const transformRingWriter = _transformRing ? new TransformRingWriter(_transformRing.sab, _transformRing.capacity) : null
  // Threaded onto ctx (same pattern as ctx.physicsIntegration/ctx.networkState) so ServerHandlers.js's
  // onDisconnect/RECONNECT cleanup can release a departed player's ring slot -- null-safe throughout
  // (see TransformRing.js's isRingAvailable degrade-cleanly contract), never assumed present.
  ctx.transformRingWriter = transformRingWriter
  // onAutoSave: same wiring as server.js's createTickHandler call -- TickHandler.js's own
  // AUTO_SAVE_INTERVAL=300s tick%N gate (already generic, no isNode/isWorker fork needed there) fires this
  // fire-and-forget saveWorldSnapshot(ctx) exactly like the real WS server path. A singleplayer session's
  // IDBAdapter.set is itself async (real indexedDB transaction, falls back to an in-memory Map if indexedDB
  // is unavailable -- see IDBAdapter.js) so this never blocks the tick that triggered it, matching
  // WorldPersistence.js's own never-throw-into-onTick discipline.
  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: ctx.movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => worldDef.relevanceRadius || 0, getWorldTimeOfDayConfig: () => worldDef.terrain?.timeOfDay || null, getWorldWeatherConfig: () => worldDef.terrain?.weather || null, transformRingWriter, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect

  stageLoader.loadFromDefinition('main', worldDef)
  // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: wait (bounded) for
  // every autoTrimesh/addTrimeshCollider build the spawn loops above just kicked off (including
  // custom._interior placed-models like env-sillos's trimesh floor, apps/placed-model/index.js) to
  // settle before anything else can run against these entities. src/sdk/ServerAPI.js's loadWorld()
  // already does this for the real multiplayer server; singleplayer's in-Worker path had NO equivalent
  // wait, and unlike a human joining a remote server (real network latency covers the gap), a local
  // client can connect fast enough to spawn its player capsule before env-sillos's floor trimesh body
  // exists -- live-witnessed: player fell straight through, position Y drifting from spawn (2.27) to
  // -100 and still falling (onGround:false) by tick 38, X/Z correctly at the declared spawn point.
  try { await appRuntime.waitForPendingTrimeshBuilds?.() } catch (e) { console.error('[world-persistence] waitForPendingTrimeshBuilds error:', e.message) }
  // Restore-on-boot: must run after BOTH the world-def spawn (stageLoader.loadFromDefinition, immediately
  // above) AND the placed-model replay loop (the `for (const p of placed)` block above, already run before
  // this point in this file) have finished creating every entity -- see WorldPersistence.js's own header
  // comment for the full ordering rationale. The async-autoTrimesh-body race this comment used to accept
  // as an open gap here is now closed above (waitForPendingTrimeshBuilds), matching ServerAPI.js's own
  // ordering exactly. A missing/version-mismatched/world-mismatched snapshot (including a genuinely fresh
  // IndexedDB with nothing saved yet -- every first-ever singleplayer session) is a clean no-op, matching
  // server.js's ServerAPI.js loadWorld() call site exactly: this never throws into init(), a broken/absent
  // snapshot degrades to "world boots exactly as it always did today", never a boot failure.
  try { await restoreWorldSnapshot(ctx) } catch (e) { console.error('[world-persistence] restore error:', e.message) }

  // Host migration (client/HostMigration.js): the newly-elected host boots this SAME WorkerEntry.init()
  // path (a full BrowserServer, worldDef re-simulated from scratch same as any singleplayer/host boot)
  // but with a migrationSnapshot -- the departed host's last-broadcast SNAPSHOT if the handoff was
  // graceful (MSG.HOST_MIGRATE), or otherwise the electing peer's OWN last-received client-side
  // SnapshotProcessor state (see BaseClient.getAllStates/getAllEntities), which is always at most one
  // snapshot-interval stale. Applied AFTER stageLoader's default spawn so it overwrites, not races,
  // the fresh entities stageLoader just created. Dynamic entity positions/rotations/velocities are
  // patched onto whatever entity of the same id stageLoader already spawned (never re-spawns a new
  // entity -- ids and their app-level logic must stay exactly what worldDef defines); reconnecting
  // players' last-known transform is stashed on ctx.pendingRejoinState so onClientConnect (below, via
  // ServerHandlers.js) seeds their spawn position from it instead of picking a fresh random spawn point,
  // which is what "state survives the handoff without resetting" requires for the local player itself.
  if (migrationSnapshot && typeof migrationSnapshot === 'object') {
    try {
      for (const e of migrationSnapshot.entities || []) {
        const ent = appRuntime.entities.get(e.id)
        if (!ent) continue // only patches entities the fresh worldDef already spawned; never fabricates new ones from untrusted snapshot data
        let changed = false, positionChanged = false
        if (Array.isArray(e.position) && e.position.length === 3 && e.position.every(Number.isFinite)) { ent.position = [...e.position]; changed = true; positionChanged = true }
        if (Array.isArray(e.rotation) && e.rotation.length === 4 && e.rotation.every(Number.isFinite)) { ent.rotation = [...e.rotation]; changed = true }
        if (Array.isArray(e.velocity) && e.velocity.length === 3 && e.velocity.every(Number.isFinite)) { ent.velocity = [...e.velocity]; changed = true }
        if (ent._physicsBodyId != null && typeof physics._repositionBody === 'function') {
          try { physics._repositionBody(ent._physicsBodyId, ent.position, ent.rotation) } catch (_) {}
        }
        // SECOND real bug caught by live witness (not a hypothetical): Stage.js's spatial octree
        // (this._stageLoader.getActiveStage().spatial, an SpatialIndex built at spawn time) indexes each
        // entity by the position it was spawned at -- direct field mutation on `ent` above never touches
        // it, so relevantEntities()/getSnapshotForPlayer() (relevanceRadius>0 path, TickHandler.js) keep
        // querying the octree by the STALE pre-migration position. A migrated entity moved far enough
        // from its worldDef-authored spawn point (or that a viewing player is far enough from the STALE
        // indexed position) silently drops out of every viewer's relevance set and never reaches the
        // wire at all -- live-witnessed: real WorkerEntry.js boot + real SnapshotProcessor decode showed
        // ZERO entities in the snapshot until this fix, not merely the wrong position.
        if (positionChanged) {
          const activeStage = stageLoader.getActiveStage && stageLoader.getActiveStage()
          if (activeStage && typeof activeStage.updateEntityPosition === 'function') activeStage.updateEntityPosition(e.id, ent.position)
        }
        // Real bug caught by live witness (not a hypothetical): AppRuntime.getSnapshot() caches its
        // encoded output keyed on _snapshotVersion (see AppRuntime.js:314-316), bumped ONLY via the
        // internal _markDirty(id) every other position/state mutation in this codebase already calls.
        // A direct field mutation on the entity object (as above) is otherwise invisible forever -- the
        // FIRST getSnapshot() call (already run once by stageLoader's own spawn, before this patch)
        // permanently freezes the cache at the pre-migration position for the rest of the process
        // lifetime, silently defeating the whole point of this patch. Live-witnessed: a real
        // WorkerEntry.js init() + real SnapshotProcessor decode of the real wire bytes showed the
        // migrated-to position NEVER reaching a connecting client until this fix was added.
        if (changed) appRuntime._markDirty(e.id)
        // THIRD real bug caught by live witness (a relevanceRadius>0 world -- Stage.js's own default is
        // 200, so this is the COMMON case, not an edge case): a STATIC entity (ent.bodyType==='static',
        // the worldDef default when no bodyType is declared) never goes through the dynamic-entity path
        // above at all -- TickHandler.js's buildAndSendSnapshots (the relevanceRadius>0 branch) only
        // rebuilds its per-tick `activeStaticEntries` when `appRuntime._staticVersion` differs from the
        // handler's own last-seen value (state.lastStaticVersion), and _staticVersion is bumped ONLY on
        // entity spawn/destroy/bodyType-change (AppRuntime.js:69/164/219/276) -- never on a plain
        // position edit of an already-static entity, since ordinary in-game position changes to static
        // geometry essentially don't happen outside this exact migration scenario. Without this bump,
        // TickHandler.js keeps serving the STALE captured-at-spawn-time static entity list forever,
        // meaning a migrated static entity's new position never reaches ANY client, not even a
        // newly-connecting one -- live-witnessed: real end-to-end decode showed ZERO entities on the
        // wire (not merely the wrong position) until this fix, on top of the two fixes above it.
        if (changed && ent.bodyType === 'static') appRuntime._staticVersion++
      }
      // Keyed by wireweave PUBKEY, not the old server playerId -- the old host's sequential playerId space
      // is meaningless to the new host (its own PlayerManager mints fresh ids from 1), but every peer's
      // pubkey is stable for the room's whole lifetime and is exactly what a PeerTransport already carries
      // as _peerId at PEER_CONNECT time (see onClientConnect below, in ServerHandlers.js). The host's OWN
      // rejoin entry (pubkey === the electing peer's own auth.pubkey, see client/HostMigration.js) is
      // consumed directly by init()'s caller before the local player's own connect, not through this path.
      ctx.pendingRejoinState = new Map()
      for (const p of migrationSnapshot.players || []) {
        if (!p || !p.pubkey) continue
        const pos = Array.isArray(p.position) && p.position.length === 3 && p.position.every(Number.isFinite) ? [...p.position] : null
        if (!pos) continue
        ctx.pendingRejoinState.set(p.pubkey, {
          position: pos,
          rotation: Array.isArray(p.rotation) && p.rotation.length === 4 && p.rotation.every(Number.isFinite) ? [...p.rotation] : undefined,
          health: Number.isFinite(p.health) ? p.health : undefined
        })
      }
    } catch (e) { console.error('[WorkerEntry] migrationSnapshot apply failed (continuing with fresh worldDef spawn):', e?.message || e) }
    // The electing peer's OWN rejoin entry (its own local player becoming the new host) is consumed here
    // and pulled out of pendingRejoinState -- onClientConnect's transport.type==='worker' branch reads
    // ctx.localRejoinState directly since the local WorkerTransport carries no _peerId to key by.
    if (localPubkey && ctx.pendingRejoinState?.has(localPubkey)) {
      ctx.localRejoinState = ctx.pendingRejoinState.get(localPubkey)
      ctx.pendingRejoinState.delete(localPubkey)
    }
  }

  tickSystem.onTick(ctx.onTick)
  tickSystem.start()

  _ctx = ctx
  return ctx
}

function _persistPlaced(runtime, storage, worldDef) {
  const placed = []
  // Mirrors src/sdk/server.js's ctx.placedModelStorage.persist: world-def-authored entity ids (terrain,
  // tps-game, powerup_*, env-sillos, ...) are already owned and re-spawned by stageLoader.loadFromDefinition
  // on every boot -- they must never also flow into the persisted 'placed-models' record, or the boot-time
  // restore loop above would call appRuntime.spawnEntity() a SECOND time with the same id.
  const worldDefIds = new Set((worldDef?.entities || []).map(e => e.id).filter(Boolean))
  for (const [id, entity] of runtime.entities) {
    if (worldDefIds.has(id)) continue
    // Ground truth for "editor-authored, must survive a raw reload" mirrors serializeWorld's own criterion
    // rather than the old id-prefix check: id.startsWith('placed-') only ever matched PLACE_MODEL/GLB
    // placements, silently excluding every PLACE_APP-spawned entity (id = appName+'-'+random, e.g.
    // trigger-volume-xxxxx) and primitive (box-static-xxxxx) from the debounced auto-persist in
    // singleplayer -- those edits vanished on a plain page reload same as the multiplayer-server bug.
    if (!id.startsWith('placed-') && !entity._appName && !entity.custom) continue
    placed.push({
      id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale],
      config: { collider: entity.custom?._collider || 'none' },
      app: entity._appName || undefined,
      custom: entity.custom || undefined,
      appConfig: entity._config || undefined
    })
  }
  storage.set('placed-models', placed).catch(() => {})
}

let _transport = null, _peerTransports = new Map()

// Browser-Worker postMessage glue: real `self.postMessage` only exists in an actual Worker global
// scope (client/BrowserServer.js's boot target). A real Cloudflare Durable Object (workerd) defines
// `self` as a globalThis alias but never defines `self.postMessage` -- confirmed live via a real
// `wrangler dev` instance (self.postMessage threw "is not a function") -- so this whole block must
// stay inert there rather than crash module evaluation before a DO ever reaches the exported init()
// above. Zero behavior change for every existing real-Worker caller: the guard is always true there.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.addEventListener('message', async ({ data }) => {
    if (data.type === 'INIT') {
      let ctx
      try { ctx = await init(data) } catch(e) { self.postMessage({ type: 'INIT_ERROR', error: e.message, stack: String(e.stack) }); return }
      _transport = new WorkerTransport((...args) => self.postMessage(...args))
      ctx.onClientConnect(_transport)
      // Hand the SharedArrayBuffer (if allocated -- see init()'s _transformRing) to the main thread by
      // reference, not transfer: a SharedArrayBuffer is already shared memory, postMessage-ing it just
      // shares the same backing store with the receiver, unlike a transferable ArrayBuffer which moves
      // ownership. Sent once, right after INIT succeeds -- the main thread's own reader construction
      // (client/BrowserServer.js) is gated on receiving this message, same discipline as WORKER_READY.
      if (_transformRing) self.postMessage({ type: 'TRANSFORM_RING', sab: _transformRing.sab, capacity: _transformRing.capacity })
      for (const msg of _pending) _dispatch(msg)
      _pending = []
      return
    }

    if (data.type === 'PEER_CONNECT') {
      if (!_ctx) return
      const t = new PeerTransport(data.peerId, (...args) => self.postMessage(...args))
      _peerTransports.set(data.peerId, t)
      _ctx.onClientConnect(t)
      return
    }

    // server-scale-worldpersistence-workerentry-graceful-shutdown-save: client/BrowserServer.js posts this
    // on a visibilitychange (tab-hide/close/switch -- fires reliably before beforeunload/pagehide in every
    // major engine, and unlike those two the page/Worker are still fully alive when it fires, so an
    // in-flight indexedDB write is never racing an actual teardown). Reuses saveWorldSnapshot(ctx)
    // completely unchanged (same fire-and-forget, never-throw-into-caller discipline as the periodic
    // onAutoSave path above) -- this is purely an extra trigger for the SAME already-shipped save, not a
    // new persistence mechanism. Silently a no-op before INIT has completed (_ctx still null): nothing to
    // save yet, and there is no world state to lose.
    if (data.type === 'SAVE_NOW') {
      if (!_ctx) return
      saveWorldSnapshot(_ctx).catch(e => console.error('[world-persistence] visibilitychange save failed:', e.message))
      return
    }

    if (!_transport) { _pending.push(data); return }
    _dispatch(data)
  })

  self.postMessage({ type: 'WORKER_READY' })
}

function _dispatch(data) {
  if (data.type === 'CLIENT_MESSAGE') {
    _transport.emit('message', data.data)
  } else if (data.type === 'CLIENT_DISCONNECT') {
    _transport.close()
  } else if (data.type === 'PEER_MESSAGE') {
    _peerTransports.get(data.peerId)?.emit('message', data.data)
  } else if (data.type === 'PEER_DISCONNECT') {
    const t = _peerTransports.get(data.peerId)
    if (t) { t.close(); _peerTransports.delete(data.peerId) }
  }
}
