import { CliDebugger } from '../debug/CliDebugger.js'
import { extractMeshFromGLB, extractMeshFromGLBAsync } from '../physics/GLBLoader.js'

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
      setInteractable: (radius = 3) => { ent._interactable = true; ent._interactRadius = radius },
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
      addTrimeshCollider: async () => {
        ent.collider = { type: 'trimesh', model: ent.model }
        if (runtime._physics && ent.model) {
          const bodyId = await runtime._physics.addStaticTrimeshAsync(runtime.resolveAssetPath(ent.model), 0, ent.position)
          ent._physicsBodyId = bodyId
        }
      },
      addConvexCollider: (points) => {
        ent.collider = { type: 'convex', points }
        if (runtime._physics) {
          const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
          ent._physicsBodyId = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
        }
      },
      addConvexFromModel: (meshIndex = 0) => {
        if (!ent.model) return
        try {
          const mesh = extractMeshFromGLB(runtime.resolveAssetPath(ent.model), meshIndex)
          const points = Array.from(mesh.vertices)
          ent.collider = { type: 'convex', points }
          if (runtime._physics) {
            const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
            ent._physicsBodyId = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
          }
        } catch (err) {
          if (err.message.includes('Draco-compressed')) {
            runtime._debug?.warn(`[physics] Draco mesh detected - use addTrimeshCollider() for physics or box/sphere/capsule for trigger`)
            if (runtime._physics) {
              const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
              ent.collider = { type: 'box', size: [0.5, 0.5, 0.5] }
              ent._physicsBodyId = runtime._physics.addBody('box', [0.5, 0.5, 0.5], ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
            }
          } else {
            throw err
          }
        }
      },
      addConvexFromModelAsync: async (meshIndex = 0) => {
        if (!ent.model) return
        const mt = ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
        let mesh
        try {
          mesh = await extractMeshFromGLBAsync(runtime.resolveAssetPath(ent.model), meshIndex)
        } catch (err) {
          console.warn(`[physics] ${ent.model}: mesh extraction failed (${err.message}), using box fallback`)
          if (runtime._physics) {
            ent.collider = { type: 'box', size: [0.5, 0.5, 0.5] }
            ent._physicsBodyId = runtime._physics.addBody('box', [0.5, 0.5, 0.5], ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
          }
          return
        }
        const v = mesh.vertices
        let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity
        for (let i = 0; i < v.length; i += 3) {
          if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i]
          if (v[i+1] < minY) minY = v[i+1]; if (v[i+1] > maxY) maxY = v[i+1]
          if (v[i+2] < minZ) minZ = v[i+2]; if (v[i+2] > maxZ) maxZ = v[i+2]
        }
        const points = [
          minX,minY,minZ, maxX,minY,minZ, minX,maxY,minZ, maxX,maxY,minZ,
          minX,minY,maxZ, maxX,minY,maxZ, minX,maxY,maxZ, maxX,maxY,maxZ
        ]
        ent.collider = { type: 'convex', points }
        if (runtime._physics) {
          ent._physicsBodyId = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass })
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
  }

  raycast(origin, direction, maxDistance = 1000) {
    if (this._runtime._physics) {
      return this._runtime._physics.raycast(origin, direction, maxDistance)
    }
    return { hit: false, distance: maxDistance, body: null, position: null }
  }
}
