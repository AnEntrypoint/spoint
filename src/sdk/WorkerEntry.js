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
import { saveWorldSnapshot, restoreWorldSnapshot, worldDefFingerprint } from './WorldPersistence.js'
import { isWorldName } from '../shared/worldName.js'
import { resolveTerrainConfig, minimapDescriptor } from '../shared/terrainConfig.js'

if (typeof setImmediate === 'undefined') globalThis.setImmediate = fn => setTimeout(fn, 0)

const DEFAULT_TICK_RATE_HZ = 60
const SINGLEPLAYER_DEFAULT_WORLD_ID = 'tps-game'
const TRANSFORM_RING_CAPACITY = 64

let _ctx = null, _pending = [], _terrainStreamer = null, _transformRing = null

export async function init({ worldDef, worldName: selectedWorldName = null, apps = [], migrationSnapshot = null, localPubkey = null, timeOfDaySeed = null }) {
  await ensurePacked
  if (selectedWorldName !== null && !isWorldName(selectedWorldName)) throw new TypeError(`[WorkerEntry] INIT worldName must be null or a world file stem, got ${JSON.stringify(selectedWorldName)}`)
  const knownWorldName = worldDef.name || selectedWorldName
  const worldName = knownWorldName || worldDefFingerprint(worldDef)
  if (timeOfDaySeed && worldDef?.terrain?.timeOfDay && worldDef.terrain.timeOfDay.serverAuthoritative === true) {
    worldDef.terrain.timeOfDay.seed = timeOfDaySeed
  }
  const gravity = worldDef.gravity || [0, -9.81, 0]
  const playerConfig = worldDef.player || {}
  const tickRate = worldDef.tickRate || DEFAULT_TICK_RATE_HZ

  const physics = new PhysicsWorld({ gravity, crouchHalfHeight: playerConfig.crouchHalfHeight })
  const physicsReady = physics.init()

  const _tcfg = resolveTerrainConfig(worldDef)
  if (_tcfg && _tcfg.enabled !== false) {
    loadPlanetSampler({ radius: _tcfg.radius, hpfTexRes: (_tcfg.physics || {}).hpfTexRes, seed: _tcfg.seed, reliefScale: _tcfg.reliefScale }).catch(() => {})
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
  appRuntime.worldName = knownWorldName || null
  const appLoader = new AppLoader(appRuntime, {})
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)
  appLoader._onReloadCallback = (name, code) => connections.broadcast(MSG.APP_MODULE, { app: name, code })

  const _appLoadResults = await Promise.all(apps.map(({ name, source, deps, module }) => {
    if (module) {
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
    physics,
    lagCompensator, physicsIntegration, connections, sessions, inspector,
    appRuntime, appLoader, stageLoader, sdkRoot: '',
    currentWorldDef: worldDef, worldName, worldSpawnPoint: worldDef.spawnPoint || [0, 5, 0],
    worldSpawnPoints: worldDef.spawnPoints || [worldDef.spawnPoint || [0, 5, 0]],
    snapshotSeq: 0, handlerState: { fn: null },
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt); connections.flushAll() },
    setTickHandler: fn => { ctx.handlerState.fn = fn; ctx.tickHandlerFn = fn; ctx.serverTimeOfDay = fn?.serverTimeOfDay || null; ctx.serverWeather = fn?.serverWeather || null },
    placedModelStorage: { persist: runtime => _persistPlaced(runtime, storage, worldDef) }
  }
  appRuntime.setPlacedModelStorage(ctx.placedModelStorage)

  const placedPromise = storage.get('placed-models').catch(e => { console.warn('[world-persistence] placed-models read failed:', e?.message || e); return null })
  await physicsReady
  const _minimap = minimapDescriptor(knownWorldName || SINGLEPLAYER_DEFAULT_WORLD_ID, _tcfg)
  if (_minimap) worldDef._minimap = _minimap
  if (_tcfg && _tcfg.enabled !== false) {
    setupTerrainStreaming({ physics, playerManager, terrain: _tcfg })
      .then(s => { _terrainStreamer = s; ctx._terrainStreamer = s })
      .catch(e => console.error('[terrain] heightfield install error:', e?.message || e))
  }
  const placed = await placedPromise || []
  const worldDefEntityIds = new Set((worldDef.entities || []).map(e => e.id).filter(Boolean))
  for (const p of placed) { if (worldDefEntityIds.has(p.id)) continue; appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: p.app || 'placed-model', custom: p.custom, config: p.appConfig || p.config || {} }) }

  _transformRing = allocateRingBuffer(TRANSFORM_RING_CAPACITY)
  const transformRingWriter = _transformRing ? new TransformRingWriter(_transformRing.sab, _transformRing.capacity) : null
  ctx.transformRingWriter = transformRingWriter
  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: ctx.movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => worldDef.relevanceRadius || 0, getWorldTimeOfDayConfig: () => worldDef.terrain?.timeOfDay || null, getWorldWeatherConfig: () => worldDef.terrain?.weather || null, transformRingWriter, onAutoSave: () => { saveWorldSnapshot(ctx).catch(e => console.error('[world-persistence] periodic save failed:', e.message)) } }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect

  stageLoader.loadFromDefinition('main', worldDef)
  try { await appRuntime.waitForPendingTrimeshBuilds?.() } catch (e) { console.error('[world-persistence] waitForPendingTrimeshBuilds error:', e.message) }
  try { await restoreWorldSnapshot(ctx) } catch (e) { console.error('[world-persistence] restore error:', e.message) }

  if (migrationSnapshot && typeof migrationSnapshot === 'object') {
    try {
      for (const e of migrationSnapshot.entities || []) {
        const ent = appRuntime.entities.get(e.id)
        if (!ent) continue
        let changed = false, positionChanged = false
        if (Array.isArray(e.position) && e.position.length === 3 && e.position.every(Number.isFinite)) { ent.position = [...e.position]; changed = true; positionChanged = true }
        if (Array.isArray(e.rotation) && e.rotation.length === 4 && e.rotation.every(Number.isFinite)) { ent.rotation = [...e.rotation]; changed = true }
        if (Array.isArray(e.velocity) && e.velocity.length === 3 && e.velocity.every(Number.isFinite)) { ent.velocity = [...e.velocity]; changed = true }
        if (ent._physicsBodyId != null && typeof physics._repositionBody === 'function') {
          try { physics._repositionBody(ent._physicsBodyId, ent.position, ent.rotation) } catch (_) {}
        }
        if (positionChanged) {
          const activeStage = stageLoader.getActiveStage && stageLoader.getActiveStage()
          if (activeStage && typeof activeStage.updateEntityPosition === 'function') activeStage.updateEntityPosition(e.id, ent.position)
        }
        if (changed) appRuntime._markDirty(e.id)
        if (changed && ent.bodyType === 'static') appRuntime._staticVersion++
      }
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
  const worldDefIds = new Set((worldDef?.entities || []).map(e => e.id).filter(Boolean))
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
  storage.set('placed-models', placed).catch(() => {})
}

let _transport = null, _peerTransports = new Map()

const hasWorkerPostMessage = typeof self !== 'undefined' && typeof self.postMessage === 'function'
if (hasWorkerPostMessage) {
  self.addEventListener('message', async ({ data }) => {
    if (data.type === 'INIT') {
      let ctx
      try { ctx = await init(data) } catch(e) { self.postMessage({ type: 'INIT_ERROR', error: e.message, stack: String(e.stack) }); return }
      _transport = new WorkerTransport((...args) => self.postMessage(...args))
      ctx.onClientConnect(_transport)
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

    if (data.type === 'SAVE_NOW') {
      if (!_ctx) return
      saveWorldSnapshot(_ctx).catch(e => console.error('[world-persistence] visibilitychange save failed:', e.message))
      return
    }

    if (data.type === 'DEBUG_COLLIDER_QUERY') {
      if (!_ctx || !_ctx.physics || typeof _ctx.physics.raycast !== 'function') { self.postMessage({ type: 'DEBUG_COLLIDER_RESULT', reqId: data.reqId, hit: false, error: 'physics not ready' }); return }
      const RAY_HALF_RANGE_M = 20000
      try {
        const r = _ctx.physics.raycast([data.x, RAY_HALF_RANGE_M, data.z], [0, -1, 0], RAY_HALF_RANGE_M * 2)
        self.postMessage({ type: 'DEBUG_COLLIDER_RESULT', reqId: data.reqId, hit: !!r.hit, y: r.hit ? r.position[1] : null, bodyId: r.hit ? r.bodyId ?? r.body ?? null : null, terrainHeightSource: _ctx.physics._terrainHeightSource || null })
      } catch (e) { self.postMessage({ type: 'DEBUG_COLLIDER_RESULT', reqId: data.reqId, hit: false, error: e?.message || String(e) }) }
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
