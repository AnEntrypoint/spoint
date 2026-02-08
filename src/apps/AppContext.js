import { CliDebugger } from '../debug/CliDebugger.js'

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

  get physics() {
    const ent = this._entity
    const runtime = this._runtime
    return {
      setStatic: (v) => { ent.bodyType = v ? 'static' : ent.bodyType },
      setDynamic: (v) => { ent.bodyType = v ? 'dynamic' : ent.bodyType },
      setKinematic: (v) => { ent.bodyType = v ? 'kinematic' : ent.bodyType },
      setMass: (v) => { ent.mass = v },
      addBoxCollider: (s) => {
        ent.collider = { type: 'box', size: s }
        if (runtime._physics) {
          const he = Array.isArray(s) ? s : [s, s, s]
          const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
          ent._physicsBodyId = runtime._physics.addBody('box', he, ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
        }
      },
      addSphereCollider: (r) => {
        ent.collider = { type: 'sphere', radius: r }
        if (runtime._physics) {
          const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
          ent._physicsBodyId = runtime._physics.addBody('sphere', r, ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
        }
      },
      addCapsuleCollider: (r, h) => {
        ent.collider = { type: 'capsule', radius: r, height: h }
        if (runtime._physics) {
          const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
          ent._physicsBodyId = runtime._physics.addBody('capsule', [r, h / 2], ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
        }
      },
      addMeshCollider: (m) => { ent.collider = { type: 'mesh', mesh: m } },
      addTrimeshCollider: () => {
        ent.collider = { type: 'trimesh', model: ent.model }
        if (runtime._physics && ent.model) {
          const bodyId = runtime._physics.addStaticTrimesh(ent.model, 0)
          ent._physicsBodyId = bodyId
        }
      },
      addForce: (f) => {
        const mass = ent.mass || 1
        ent.velocity[0] += f[0] / mass
        ent.velocity[1] += f[1] / mass
        ent.velocity[2] += f[2] / mass
      },
      setVelocity: (v) => { ent.velocity = [...v] }
    }
  }

  get world() {
    const runtime = this._runtime
    return {
      spawn: (id, cfg) => runtime.spawnEntity(id, cfg),
      destroy: (id) => runtime.destroyEntity(id),
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
      getNearest: (pos, r) => runtime.getNearestPlayer(pos, r),
      send: (pid, msg) => runtime.sendToPlayer(pid, msg),
      broadcast: (msg) => runtime.broadcastToPlayers(msg),
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

  get collider() {
    const ent = this._entity
    return {
      box: (hx, hy, hz) => { ent.collider = { type: 'box', halfExtents: [hx, hy, hz] } },
      capsule: (r, h) => { ent.collider = { type: 'capsule', radius: r, halfHeight: h } },
      sphere: (r) => { ent.collider = { type: 'sphere', radius: r } }
    }
  }

  raycast(origin, direction, maxDistance = 1000) {
    if (this._runtime._physics) {
      return this._runtime._physics.raycast(origin, direction, maxDistance)
    }
    return { hit: false, distance: maxDistance, body: null, position: null }
  }
}
