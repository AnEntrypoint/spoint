import { CliDebugger } from '../debug/CliDebugger.js'
import { buildPhysicsAPI } from './AppPhysics.js'
import { vec3 as _vec3, vec4 as _vec4, vecOK } from '../shared/vecGuard.js'
import { waterlineLocalY } from '../terrain/PlanetFrame.js'
import { defineGameFSM } from '../../apps/_lib/game-fsm.js'
import { defineGameMode } from '../../apps/_lib/gamemode.js'
import { createBuffStack } from '../../apps/_lib/buffs.js'
import { defineShrinkingZone } from '../../apps/_lib/shrinking-zone.js'
import { defineHealth } from '../../apps/_lib/health.js'
import { defineSteering } from '../../apps/_lib/steering.js'
import { defineCheckpoint } from '../../apps/_lib/checkpoint.js'
import { definePickup } from '../../apps/_lib/pickup.js'
import { createDestructible } from '../../apps/_lib/destructible.js'
import { createSoftbodyCloth } from '../../apps/_lib/softbody.js'
import { createFluidBody } from '../../apps/_lib/fluid.js'
import { createFluid3DBody } from '../../apps/_lib/fluid3d.js'
import { defineBuoyancy } from '../../apps/_lib/buoyancy.js'
import { defineTeams } from '../../apps/_lib/teams.js'
import { defineWeapon } from '../../apps/_lib/weapon.js'
import { definePlayerInventory } from '../../apps/_lib/inventory.js'
import { definePath } from '../../apps/_lib/path.js'
import { NavmeshQuery } from '../pathfinding/NavmeshQuery.js'
import { isWorldName } from '../shared/worldName.js'

const ENGINE_KEY_PREFIX_CHAR_CODE = 95
const NAVMESH_FORMAT_VERSION = 1
const _navmeshesByRuntime = new WeakMap()

function _isNodeRuntime() { return typeof process !== 'undefined' && !!process.versions?.node }

async function _readNavmeshJSON(worldName, sdkRoot) {
  const file = `${worldName}.navmesh.json`
  if (_isNodeRuntime()) {
    const [{ readFile }, { resolve }] = await Promise.all([import('node:fs/promises'), import('node:path')])
    const candidates = [...new Set([process.cwd(), sdkRoot].filter(Boolean).map(root => resolve(root, 'apps', 'world', file)))]
    for (const fp of candidates) {
      let text
      try { text = await readFile(fp, 'utf-8') } catch (e) { if (e.code === 'ENOENT') continue; throw new Error(`navmesh ${fp}: ${e.message}`) }
      return { data: JSON.parse(text), source: fp }
    }
    throw new Error(`navmesh not baked for world "${worldName}": none of ${candidates.join(', ')} exist (npm run bake-navmesh -- --world=${worldName})`)
  }
  const url = new URL(`../../apps/world/${file}`, import.meta.url)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`navmesh not baked for world "${worldName}": GET ${url.pathname} -> HTTP ${r.status} (npm run bake-navmesh -- --world=${worldName})`)
  return { data: await r.json(), source: url.href }
}

async function _buildNavmesh(worldName, sdkRoot) {
  const { data, source } = await _readNavmeshJSON(worldName, sdkRoot)
  if (!data || data.version !== NAVMESH_FORMAT_VERSION || !Array.isArray(data.vertices) || !Array.isArray(data.polygons) || !data.polygons.length) {
    throw new Error(`navmesh ${source}: expected format version ${NAVMESH_FORMAT_VERSION} with non-empty vertices/polygons, got version=${data?.version} vertices=${data?.vertices?.length} polygons=${data?.polygons?.length}`)
  }
  return new NavmeshQuery(data)
}
const DEFAULT_LOS_TARGET_COLLIDER_TOLERANCE_M = 0.5

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
    const vec3 = _vec3, vec4 = _vec4
    return {
      get id() { return ent.id },
      get model() { return ent.model },
      get bodyType() { return ent.bodyType },
      get position() { return ent.position },
      set position(v) { ent.position = vec3(v, 'position') },
      get rotation() { return ent.rotation },
      set rotation(v) { ent.rotation = vec4(v, 'rotation') },
      get scale() { return ent.scale },
      set scale(v) { ent.scale = vec3(v, 'scale') },
      get velocity() { return ent.velocity },
      set velocity(v) { ent.velocity = vec3(v, 'velocity') },
      get custom() { return ent.custom },
      set custom(v) { if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw new TypeError('entity.custom must be null or a plain object'); ent.custom = v },
      get parent() { return ent.parent },
      get children() { return [...ent.children] },
      get worldTransform() { return runtime.getWorldTransform(ent.id) },
      destroy: () => runtime.destroyEntity(ent.id)
    }
  }

  get entity() { return this._entityProxy }

  get physics() { return this._physicsAPI || (this._physicsAPI = buildPhysicsAPI(this._entity, this._runtime)) }

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
      sendToEntity: (entityId, msg) => runtime.fireEvent?.(entityId, 'onMessage', msg),
      applyImpulse: (entityId, impulse, worldPoint) => runtime.applyImpulseToEntity(entityId, impulse, worldPoint),
      setVelocity: (entityId, velocity) => runtime.setEntityVelocity(entityId, velocity),
      setGravityFactor: (entityId, factor) => runtime.setEntityGravityFactor?.(entityId, factor),
      setBodyActive: (entityId, active) => runtime.setEntityBodyActive?.(entityId, active),
      setPosition: (entityId, position, rotation) => runtime.setEntityPosition?.(entityId, position, rotation),
      weld: (entityA, entityB, opts) => runtime.addEntityConstraint?.(entityA, entityB, { ...(opts || {}), type: 'fixed' }),
      joint: (entityA, entityB, opts) => runtime.addEntityConstraint?.(entityA, entityB, opts),
      removeConstraint: (constraintId) => runtime.removeConstraint?.(constraintId),
      setMotionType: (entityId, motionType) => runtime.setEntityMotionType?.(entityId, motionType) ?? false,
      isAtRest: (entityId, eps) => runtime.isEntityAtRest?.(entityId, eps) ?? true,
      get gravity() { return runtime.gravity }
    }
  }

  get players() {
    const runtime = this._runtime
    return {
      getAll: () => runtime.getPlayers(),
      getById: (id) => runtime.getPlayerById(id) || runtime.getPlayers().find(p => p.id === id) || null,
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
      setPosition: (pid, pos) => runtime.setPlayerPosition(pid, pos),
      setName: (pid, name) => runtime.setPlayerName?.(pid, name),
      setAppearance: (pid, appearance) => runtime.setPlayerAppearance?.(pid, appearance),
      setModel: (pid, url) => runtime.setPlayerModel?.(pid, url),
      setWeapon: (pid, name) => runtime.setPlayerWeapon?.(pid, name),
      setMovementOverride: (pid, overrides) => runtime.setPlayerMovementOverride(pid, overrides),
      setLifecycle: (pid, state, opts) => runtime.setPlayerLifecycle?.(pid, state, opts),
      playAnimation: (pid, clip, opts) => runtime.playPlayerAnimation?.(pid, clip, opts),
      attachEntity: (pid, entityId, offset) => runtime.attachEntityToPlayer?.(entityId, pid, offset),
      detachEntity: (entityId) => runtime.detachEntityFromPlayer?.(entityId),
      onPlayerContact: (radius, cb) => {
        if (typeof cb !== 'function') throw new TypeError('[AppContext] onPlayerContact: callback must be a function')
        return runtime.registerPlayerContactWatch(this._entity.id, radius, cb)
      },
      nearestOtherPlayer: (playerId, radius) => {
        const me = runtime.getPlayerById(playerId) || runtime.getPlayers().find(p => p.id === playerId)
        const pos = me?.state?.position; if (!pos) return null
        const r2 = radius * radius; let best = null, bestD = r2
        for (const p of runtime.getPlayers()) {
          if (p.id === playerId) continue
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0]-pos[0], dy = pp[1]-pos[1], dz = pp[2]-pos[2], d = dx*dx+dy*dy+dz*dz
          if (d < bestD) { bestD = d; best = p }
        }
        return best
      }
    }
  }

  get time() {
    const runtime = this._runtime
    const entityId = this._entity.id
    return {
      get tick() { return runtime.currentTick },
      get deltaTime() { return runtime.deltaTime },
      get elapsed() { return runtime.elapsed },
      get serverTime() { return Date.now() },
      after: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, false),
      every: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, true)
    }
  }

  get config() {
    const base = this._entity._config || {}
    const custom = this._entity.custom
    if (!custom || typeof custom !== 'object') return base
    const out = { ...base }
    for (const k in custom) { if (k.charCodeAt(0) !== ENGINE_KEY_PREFIX_CHAR_CODE) out[k] = custom[k] }
    return out
  }

  onConfigChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('[AppContext] onConfigChange: cb must be a function')
    const set = this._configListeners || (this._configListeners = new Set())
    set.add(cb)
    return () => set.delete(cb)
  }

  _fireConfigChange() {
    if (!this._configListeners) return
    const cfg = this.config
    for (const cb of this._configListeners) { try { cb(cfg) } catch (e) { this._debugger?.warn?.('onConfigChange handler threw: ' + e.message) } }
  }

  onShutdown(cb) {
    if (typeof cb !== 'function') throw new TypeError('[AppContext] onShutdown: cb must be a function')
    return this._runtime.registerShutdownHook(cb)
  }

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

  get eventLog() { return this._runtime._eventLog || null }

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
    if (config.radius != null && (typeof config.radius !== 'number' || !Number.isFinite(config.radius) || config.radius < 0)) throw new TypeError('interactable: radius must be a non-negative finite number')
    if (config.cooldown != null && (typeof config.cooldown !== 'number' || !Number.isFinite(config.cooldown) || config.cooldown < 0)) throw new TypeError('interactable: cooldown must be a non-negative finite number')
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

  onPlayerProximity(radius, callback) {
    if (typeof callback !== 'function') throw new TypeError('[AppContext] onPlayerProximity: callback must be a function')
    const self = this
    return this._runtime.registerProximityWatch(this._entity.id, radius, (playerId) => callback(self, playerId))
  }

  _registerDisposer(fn) {
    if (typeof fn !== 'function') return
    (this._disposers || (this._disposers = [])).push(fn)
  }

  _runDisposers() {
    const d = this._disposers
    if (!d || d.length === 0) return
    this._disposers = null
    for (const fn of d) { try { fn() } catch (e) { console.error('[AppContext] disposer error:', e?.message || e) } }
  }

  _teardownChildren() {
    const ids = this._state._childIds
    if (!ids) return
    for (const id of [...ids]) this._runtime.destroyEntity(id)
    ids.clear()
  }

  defineGameFSM(spec) { return defineGameFSM(spec, this) }

  defineGameMode(spec) { return defineGameMode(spec, this) }

  defineBuffStack(spec) { return createBuffStack(spec, this) }

  defineShrinkingZone(spec) { return defineShrinkingZone(spec, this) }

  defineHealth(spec) { return defineHealth(spec, this) }

  defineSteering(spec) { return defineSteering(spec, this) }

  defineCheckpoint(spec) { return defineCheckpoint(spec, this) }

  definePickup(spec) { return definePickup(spec, this) }

  defineDestructible(spec) { return createDestructible(spec, this) }

  defineSoftbody(spec) { return createSoftbodyCloth(spec, this) }

  defineFluid(spec) { return createFluidBody(spec, this) }

  defineFluid3D(spec) { return createFluid3DBody(spec, this) }

  defineBuoyancy(spec) { return defineBuoyancy(spec, this) }

  defineTeams(spec) { return defineTeams(spec, this) }

  defineWeapon(spec) { return defineWeapon(spec, this) }

  definePlayerInventory(spec) { return definePlayerInventory(spec, this) }

  definePath(points) { return definePath(points) }

  navmesh(worldName = this._runtime.worldName) {
    if (!isWorldName(worldName)) return Promise.reject(new TypeError(`[AppContext] navmesh: world name must be a world file stem, got ${JSON.stringify(worldName)} (runtime.worldName=${JSON.stringify(this._runtime.worldName)})`))
    let byWorld = _navmeshesByRuntime.get(this._runtime)
    if (!byWorld) _navmeshesByRuntime.set(this._runtime, byWorld = new Map())
    let pending = byWorld.get(worldName)
    if (!pending) {
      pending = _buildNavmesh(worldName, this._runtime._sdkRoot)
      pending.catch(() => { if (byWorld.get(worldName) === pending) byWorld.delete(worldName) })
      byWorld.set(worldName, pending)
    }
    return pending
  }

  raycast(origin, direction, maxDistance = 1000, excludeBodyId = null) {
    if (this._runtime._physics) {
      const r = this._runtime._physics.raycast(origin, direction, maxDistance, excludeBodyId)
      if (r && r.hit && r.bodyId != null && this._runtime._physicsBodyToEntityId) {
        r.entityId = this._runtime._physicsBodyToEntityId.get(r.bodyId) ?? null
      } else if (r) r.entityId = null
      return r
    }
    return { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null, entityId: null }
  }

  canSee(fromPos, toPos, opts = {}) {
    if (!vecOK(fromPos, 3) || !vecOK(toPos, 3)) return false
    const dx = toPos[0] - fromPos[0], dy = toPos[1] - fromPos[1], dz = toPos[2] - fromPos[2]
    const dist = Math.hypot(dx, dy, dz)
    if (dist < 1e-4) return true
    if (opts.maxDistance != null && dist > opts.maxDistance) return false
    const dir = [dx / dist, dy / dist, dz / dist]
    const r = this.raycast(fromPos, dir, dist, opts.excludeBodyId ?? null)
    if (!r || !r.hit) return true
    const tol = opts.tolerance != null ? opts.tolerance : DEFAULT_LOS_TARGET_COLLIDER_TOLERANCE_M
    if (opts.targetEntityId != null && r.entityId === opts.targetEntityId) return true
    return r.distance >= dist - tol
  }

  get terrainBodyId() { return this._runtime._physics?.getTerrainBodyId() ?? null }

  terrainHeightAt(x, z) {
    return this._runtime._physics?.terrainHeightAt(x, z) ?? null
  }

  terrainKindAt(x, z) {
    return this._runtime._physics?._terrainStreamer?.splineCarve?.kindAt(x, z) ?? null
  }

  navCostAt(x, z) {
    const kind = this.terrainKindAt(x, z)
    if (kind === 'road') return 0.5
    if (kind === 'river') return 3
    return 1
  }

  seaLevelAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null
    return waterlineLocalY(this._runtime._physics?._planetFrame, x, z)
  }

  get seaLevel() {
    const p = this._entity.position
    return vecOK(p, 3) ? this.seaLevelAt(p[0], p[2]) : null
  }

  get terrain() {
    const runtime = this._runtime
    return {
      startStreaming: async (tcfg) => {
        const physics = runtime._physics, playerManager = runtime._playerManager
        if (!physics || !playerManager) return null
        const { setupTerrainStreaming } = await import('../terrain/TerrainPhysics.js')
        return setupTerrainStreaming({ physics, playerManager, terrain: tcfg })
      }
    }
  }
}
