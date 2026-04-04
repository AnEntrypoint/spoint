import { CliDebugger } from '../debug/CliDebugger.js'
import { buildPhysicsAPI } from './AppPhysics.js'
import { createAppMachine } from '../../apps/_lib/lifecycle.js'

export class AppContext {
  constructor(entity, runtime) {
    this._entity = entity
    this._runtime = runtime
    this._state = entity._appState || {}
    entity._appState = this._state
    this._entityProxy = this._buildEntityProxy()
    this._debugger = new CliDebugger(`[${entity.id}]`)
    this._busScope = runtime._eventBus ? runtime._eventBus.scope(entity.id) : null
  }

  _buildEntityProxy() {
    const ent = this._entity
    const runtime = this._runtime
    return {
      get id() { return ent.id },
      get model() { return ent.model },
      get position() { return ent.position },
      set position(v) { ent.position = v },
      get rotation() { return ent.rotation },
      set rotation(v) { ent.rotation = v },
      get scale() { return ent.scale },
      set scale(v) { ent.scale = v },
      get velocity() { return ent.velocity },
      set velocity(v) { ent.velocity = v },
      get custom() { return ent.custom },
      set custom(v) { ent.custom = v },
      get parent() { return ent.parent },
      get children() { return [...ent.children] },
      get worldTransform() { return runtime.getWorldTransform(ent.id) },
      destroy: () => runtime.destroyEntity(ent.id)
    }
  }

  get entity() { return this._entityProxy }

  get physics() { return buildPhysicsAPI(this._entity, this._runtime) }

  get world() {
    const runtime = this._runtime
    const parentId = this._entity.id
    const _childIds = this._state._childIds || (this._state._childIds = new Set())
    return {
      spawn: (id, cfg) => runtime.spawnEntity(id, cfg),
      spawnChild: (id, cfg) => {
        const e = runtime.spawnEntity(id, { ...cfg, parent: cfg?.parent ?? parentId })
        _childIds.add(id); return e
      },
      destroy: (id) => { _childIds.delete(id); runtime.destroyEntity(id) },
      attach: (eid, app) => runtime.attachApp(eid, app),
      detach: (eid) => runtime.detachApp(eid),
      reparent: (eid, parentId) => runtime.reparent(eid, parentId),
      query: (filter) => runtime.queryEntities(filter),
      getEntity: (id) => runtime.getEntity(id),
      nearby: (pos, radius) => runtime.nearbyEntities(pos, radius),
      get gravity() { return runtime.gravity }
    }
  }

  get players() {
    const runtime = this._runtime
    return {
      getAll: () => runtime.getPlayers(),
      getById: (id) => runtime.getPlayers().find(p => p.id === id) || null,
      getNearest: (pos, r) => runtime.getNearestPlayer(pos, r),
      send: (pid, msg) => runtime.sendToPlayer(pid, msg),
      broadcast: (msg) => runtime.broadcastToPlayers(msg),
      broadcastNearby: (pos, radius, msg) => {
        const r2 = radius * radius
        for (const p of runtime.getPlayers()) {
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0]-pos[0], dy = pp[1]-pos[1], dz = pp[2]-pos[2]
          if (dx*dx + dy*dy + dz*dz <= r2) runtime.sendToPlayer(p.id, msg)
        }
      },
      setPosition: (pid, pos) => runtime.setPlayerPosition(pid, pos)
    }
  }

  get time() {
    const runtime = this._runtime
    const entityId = this._entity.id
    return {
      get tick() { return runtime.currentTick },
      get deltaTime() { return runtime.deltaTime },
      get elapsed() { return runtime.elapsed },
      after: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, false),
      every: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, true)
    }
  }

  get config() { return this._entity._config || {} }

  get state() { return this._state }
  set state(v) { Object.assign(this._state, v) }

  get network() {
    const runtime = this._runtime
    return {
      broadcast: (msg) => runtime.broadcastToPlayers(msg),
      sendTo: (id, msg) => runtime.sendToPlayer(id, msg)
    }
  }

  get lagCompensator() { return this._runtime._lagCompensator || null }

  get bus() { return this._busScope }

  get storage() {
    const runtime = this._runtime
    const entity = this._entity
    const ns = entity._appName || entity.id
    if (!runtime._storage) return null
    const adapter = runtime._storage
    return {
      get: (key) => adapter.get(`${ns}/${key}`),
      set: (key, value) => adapter.set(`${ns}/${key}`, value),
      delete: (key) => adapter.delete(`${ns}/${key}`),
      list: (prefix = '') => adapter.list(`${ns}/${prefix}`),
      has: (key) => adapter.has(`${ns}/${key}`)
    }
  }

  get debug() { return this._debugger }

  interactable(config = {}) {
    const ent = this._entity
    const radius = config.radius ?? 3
    const prompt = config.prompt ?? 'Press E'
    const cooldown = config.cooldown ?? 500
    ent._interactable = true
    ent._interactRadius = radius
    ent._interactCooldown = cooldown
    if (!ent.custom) ent.custom = {}
    ent.custom._interactable = { prompt, radius }
    this._runtime._interactableIds.add(ent.id)
  }

  _teardownChildren() {
    const ids = this._state._childIds
    if (!ids) return
    for (const id of [...ids]) this._runtime.destroyEntity(id)
    ids.clear()
  }

  createMachine() { return createAppMachine(this) }

  raycast(origin, direction, maxDistance = 1000) {
    if (this._runtime._physics) {
      return this._runtime._physics.raycast(origin, direction, maxDistance)
    }
    return { hit: false, distance: maxDistance, body: null, position: null }
  }
}
