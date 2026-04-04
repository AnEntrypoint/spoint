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
import { IDBAdapter } from '../storage/IDBAdapter.js'
import { WorkerTransport } from '../transport/WorkerTransport.js'
import { createConnectionHandlers } from './ServerHandlers.js'

if (typeof setImmediate === 'undefined') globalThis.setImmediate = fn => setTimeout(fn, 0)

let _ctx = null, _pending = []

async function init({ worldDef, apps = [] }) {
  const gravity = worldDef.gravity || [0, -9.81, 0]
  const playerConfig = worldDef.player || {}
  const tickRate = worldDef.tickRate || 64

  const physics = new PhysicsWorld({ gravity, crouchHalfHeight: playerConfig.crouchHalfHeight })
  await physics.init()

  const emitter = new EventEmitter(), eventBus = new EventBus(), eventLog = new EventLog({ maxSize: 1000 })
  const storage = new IDBAdapter(), tickSystem = new TickSystem(tickRate)
  const playerManager = new PlayerManager(), networkState = new NetworkState(), lagCompensator = new LagCompensator()
  const physicsIntegration = new PhysicsIntegration({ gravity, physicsWorld: physics, capsuleRadius: playerConfig.capsuleRadius, capsuleHalfHeight: playerConfig.capsuleHalfHeight, crouchHalfHeight: playerConfig.crouchHalfHeight, playerMass: playerConfig.mass })
  const connections = new ConnectionManager({ heartbeatInterval: 1000, heartbeatTimeout: 10000 })
  const sessions = new SessionStore({ ttl: 60000 })
  const inspector = new Inspector()
  const appRuntime = new AppRuntime({ gravity, playerManager, physics, physicsIntegration, connections, eventBus, eventLog, storage, sdkRoot: '', physicsRadius: worldDef.physicsRadius || 0, entityTickRate: worldDef.entityTickRate, tickRate, lagCompensator })
  appRuntime.setPlayerManager(playerManager)
  const appLoader = new AppLoader(appRuntime, {})
  const stageLoader = new StageLoader(appRuntime)
  appRuntime.setStageLoader(stageLoader)
  appLoader._onReloadCallback = (name, code) => connections.broadcast(MSG.APP_MODULE, { app: name, code })

  for (const { name, source } of apps) await appLoader.loadFromString(name, source)

  const ctx = {
    config: {}, tickRate, gravity, movement: worldDef.movement || {},
    emitter, eventBus, eventLog, storage, tickSystem, playerManager, networkState,
    lagCompensator, physicsIntegration, connections, sessions, inspector,
    appRuntime, appLoader, stageLoader, sdkRoot: '',
    currentWorldDef: worldDef, worldSpawnPoint: worldDef.spawnPoint || [0, 5, 0],
    worldSpawnPoints: worldDef.spawnPoints || [worldDef.spawnPoint || [0, 5, 0]],
    snapshotSeq: 0, handlerState: { fn: null },
    onTick: (tick, dt) => { if (ctx.handlerState.fn) ctx.handlerState.fn(tick, dt) },
    setTickHandler: fn => { ctx.handlerState.fn = fn },
    placedModelStorage: { persist: runtime => _persistPlaced(runtime, storage) }
  }

  const placed = await storage.get('placed-models') || []
  for (const p of placed) appRuntime.spawnEntity(p.id, { model: p.model, position: p.position, rotation: p.rotation, scale: p.scale, app: 'placed-model', config: p.config || {} })

  ctx.setTickHandler(createTickHandler({ networkState, playerManager, physicsIntegration, lagCompensator, physics, appRuntime, connections, movement: ctx.movement, stageLoader, eventLog, tickRate, getRelevanceRadius: () => worldDef.relevanceRadius || 0 }))
  ctx.onClientConnect = createConnectionHandlers(ctx).onClientConnect

  stageLoader.loadFromDefinition('main', worldDef)

  tickSystem.onTick(ctx.onTick)
  tickSystem.start()

  _ctx = ctx
  return ctx
}

function _persistPlaced(runtime, storage) {
  const placed = []
  for (const [id, entity] of runtime.entities) {
    if (!id.startsWith('placed-')) continue
    placed.push({ id, model: entity.model, position: [...entity.position], rotation: [...entity.rotation], scale: [...entity.scale], config: { collider: entity.custom?._collider || 'none' } })
  }
  storage.set('placed-models', placed).catch(() => {})
}

let _transport = null

self.onmessage = async ({ data }) => {
  if (data.type === 'INIT') {
    const ctx = await init(data)
    _transport = new WorkerTransport(msg => self.postMessage(msg))
    ctx.onClientConnect(_transport)
    for (const msg of _pending) _dispatch(msg)
    _pending = []
    return
  }
  if (!_transport) { _pending.push(data); return }
  _dispatch(data)
}

function _dispatch(data) {
  if (data.type === 'CLIENT_MESSAGE') {
    _transport.emit('message', data.data)
  } else if (data.type === 'CLIENT_DISCONNECT') {
    _transport.close()
  }
}
