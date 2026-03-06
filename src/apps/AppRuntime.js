import { AppContext } from './AppContext.js'
import { HotReloadQueue } from './HotReloadQueue.js'
import { EventBus } from './EventBus.js'
import { mulQuat, rotVec } from '../math.js'
import { MSG } from '../protocol/MessageTypes.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SpatialIndex } from '../spatial/Octree.js'
import { mixinPhysics } from './AppRuntimePhysics.js'
import { mixinTick } from './AppRuntimeTick.js'

export class AppRuntime {
  constructor(c = {}) {
    this.entities = new Map(); this.apps = new Map(); this.contexts = new Map(); this._updateList = []; this._staticVersion = 0; this._dynamicEntityIds = new Set(); this._staticEntityIds = new Set()
    this.gravity = c.gravity || [0, -9.81, 0]
    this.currentTick = 0; this.deltaTime = 0; this.elapsed = 0
    this._playerManager = c.playerManager || null; this._physics = c.physics || null; this._physicsIntegration = c.physicsIntegration || null
    this._connections = c.connections || null; this._stageLoader = c.stageLoader || null
    this._nextEntityId = 1; this._appDefs = new Map(); this._timers = new Map(); this._interactCooldowns = new Map(); this._respawnTimer = new Map()
    this._activeDynamicIds = new Set(); this._sleepingDynamicIds = new Set(); this._physicsBodyToEntityId = new Map(); this._suspendedEntityIds = new Set()
    this._physicsLODRadius = c.physicsRadius || 0
    const serverTickRate = c.tickRate || 64, entityTickRate = c.entityTickRate || serverTickRate
    this._entityTickDivisor = Math.max(1, Math.round(serverTickRate / entityTickRate))
    this._physicsLODInterval = Math.max(1, Math.round(serverTickRate / 2))
    this._playerIndex = new SpatialIndex(); this._collisionEntities = []; this._interactableIds = new Set()
    this._playerIndexIds = new Set()
    this._lastSyncMs = 0; this._lastRespawnMs = 0; this._lastSpatialMs = 0; this._lastCollisionMs = 0; this._lastInteractMs = 0
    mixinPhysics(this); mixinTick(this)
    if (this._physics) this._registerPhysicsCallbacks()
    this._hotReload = new HotReloadQueue(this)
    this._eventBus = c.eventBus || new EventBus()
    this._eventLog = c.eventLog||null; this._storage = c.storage||null; this._sdkRoot = c.sdkRoot||null
    this._eventBus.on('*', ev => { if (!ev.channel.startsWith('system.')) this._log('bus_event', { channel:ev.channel, data:ev.data }, ev.meta) })
    this._eventBus.on('system.handover', ev => { const {targetEntityId,stateData}=ev.data||{}; if (targetEntityId) this.fireEvent(targetEntityId,'onHandover',ev.meta.sourceEntity,stateData) })
  }

  resolveAssetPath(p) {
    if (!p) return p
    const local = resolve(p); if (existsSync(local)) return local
    if (this._sdkRoot) { const sdk=resolve(this._sdkRoot,p); if (existsSync(sdk)) { console.debug(`[SDK-DEFAULT] using bundled asset: ${p}`); return sdk } }
    return local
  }

  registerApp(name, appDef) { this._appDefs.set(name, appDef) }

  spawnEntity(id, config = {}) {
    const entityId = id || `entity_${this._nextEntityId++}`
    const spawnPos = config.position ? [...config.position] : [0, 0, 0]
    const entity = {
      id: entityId, model: config.model || null,
      position: [...spawnPos],
      rotation: config.rotation || [0, 0, 0, 1],
      scale: config.scale ? [...config.scale] : [1, 1, 1],
      velocity: [0, 0, 0], mass: 1, bodyType: 'static', collider: null,
      parent: null, children: new Set(),
      _appState: null, _appName: config.app || null, _config: config.config || null, custom: null,
      _spawnPosition: spawnPos
    }
    this.entities.set(entityId, entity)
    this._staticVersion++
    if (entity.bodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    this._log('entity_spawn', { id: entityId, config }, { sourceEntity: entityId })
    if (config.parent) {
      const p = this.entities.get(config.parent)
      if (p) { entity.parent = config.parent; p.children.add(entityId) }
    }
    if (config.autoTrimesh && entity.model && this._physics) {
      entity.collider = { type: 'trimesh', model: entity.model }
      this._physics.addStaticTrimeshAsync(this.resolveAssetPath(entity.model), 0, entity.position || [0,0,0])
        .then(id => { entity._physicsBodyId = id })
        .catch(e => console.error(`[AppRuntime] Failed to create trimesh for ${entity.model}:`, e.message))
    }
    if (config.app) this._attachApp(entityId, config.app).catch(e => console.error(`[AppRuntime] Failed to attach app ${config.app}:`, e.message))
    this._spatialInsert(entity)
    return entity
  }

  async _attachApp(entityId, appName) {
    const entity = this.entities.get(entityId), appDef = this._appDefs.get(appName)
    if (!entity || !appDef) return
    const ctx = new AppContext(entity, this)
    this.contexts.set(entityId, ctx); this.apps.set(entityId, appDef)
    await this._safeCall(appDef.server || appDef, 'setup', [ctx], `setup(${appName})`)
    this._scheduleRebuild()
  }

  _scheduleRebuild() {
    if (this._rebuildScheduled) return
    this._rebuildScheduled = true
    setImmediate(() => { this._rebuildScheduled = false; this._rebuildUpdateList(); this._rebuildCollisionList() })
  }

  async attachApp(entityId, appName) { await this._attachApp(entityId, appName) }
  async spawnWithApp(id, cfg = {}, app) { return await this.spawnEntity(id, { ...cfg, app }) }
  async attachAppToEntity(eid, app, cfg = {}) { const e = this.getEntity(eid); if (!e) return false; e._config = cfg; await this._attachApp(eid, app); return true }
  async reattachAppToEntity(eid, app) { this.detachApp(eid); await this._attachApp(eid, app) }
  getEntityWithApp(eid) { const e = this.entities.get(eid); return { entity: e, appName: e?._appName, hasApp: !!e?._appName } }

  detachApp(entityId) {
    const appDef=this.apps.get(entityId), ctx=this.contexts.get(entityId)
    if (appDef && ctx) this._safeCall(appDef.server||appDef, 'teardown', [ctx], 'teardown')
    this._eventBus.destroyScope(entityId); this.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
    this._rebuildUpdateList(); this._rebuildCollisionList()
  }

  _rebuildUpdateList() {
    this._updateList = []
    for (const [id, ad] of this.apps) { const ctx=this.contexts.get(id); if (!ctx) continue; const s=ad.server||ad; if (typeof s.update==='function') this._updateList.push([id,s,ctx]) }
  }

  _rebuildCollisionList() {
    this._collisionEntities = []
    for (const [id, ad] of this.apps) { const e=this.entities.get(id); if (!e) continue; const s=ad.server||ad; if (e.collider && typeof s.onCollision==='function') this._collisionEntities.push(e) }
  }

  destroyEntity(entityId) {
    const entity = this.entities.get(entityId); if (!entity) return
    this._staticVersion++
    this._dynamicEntityIds.delete(entityId); this._staticEntityIds.delete(entityId)
    this._activeDynamicIds.delete(entityId); this._sleepingDynamicIds.delete(entityId); this._suspendedEntityIds.delete(entityId)
    this._interactableIds.delete(entityId)
    if (entity._physicsBodyId !== undefined) {
      this._physicsBodyToEntityId.delete(entity._physicsBodyId)
      if (this._physics) this._physics.removeBody(entity._physicsBodyId)
      entity._physicsBodyId = undefined
    }
    this._log('entity_destroy', { id: entityId }, { sourceEntity: entityId })
    for (const childId of [...entity.children]) this.destroyEntity(childId)
    if (entity.parent) { const p = this.entities.get(entity.parent); if (p) p.children.delete(entityId) }
    this._eventBus.destroyScope(entityId)
    this.detachApp(entityId); this._spatialRemove(entityId); this.entities.delete(entityId)
  }

  reparent(entityId, newParentId) {
    const e = this.entities.get(entityId); if (!e) return
    if (e.parent) { const old=this.entities.get(e.parent); if (old) old.children.delete(entityId) }
    e.parent = null; if (newParentId) { const np=this.entities.get(newParentId); if (np) { e.parent=newParentId; np.children.add(entityId) } }
  }

  getWorldTransform(entityId) {
    const e = this.entities.get(entityId); if (!e) return null
    const local = { position: [...e.position], rotation: [...e.rotation], scale: [...e.scale] }
    if (!e.parent) return local
    const pt = this.getWorldTransform(e.parent); if (!pt) return local
    const sp = [e.position[0]*pt.scale[0], e.position[1]*pt.scale[1], e.position[2]*pt.scale[2]]
    const rp = rotVec(sp, pt.rotation)
    return { position: [pt.position[0]+rp[0], pt.position[1]+rp[1], pt.position[2]+rp[2]], rotation: mulQuat(pt.rotation, e.rotation), scale: [pt.scale[0]*e.scale[0], pt.scale[1]*e.scale[1], pt.scale[2]*e.scale[2]] }
  }

  _encodeEntity(id, e) {
    const r = Array.isArray(e.rotation) ? [...e.rotation] : [e.rotation.x||0, e.rotation.y||0, e.rotation.z||0, e.rotation.w||1]
    return { id, model: e.model, position: [...e.position], rotation: r, scale: [...e.scale], velocity: [...(e.velocity||[0,0,0])], bodyType: e.bodyType, custom: e.custom||null, parent: e.parent||null }
  }

  getSnapshot() {
    const entities = []
    for (const [id, e] of this.entities) entities.push(this._encodeEntity(id, e))
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  getSnapshotForPlayer(playerPosition, radius, skipStatic = false) {
    const entities = [], relevant = new Set(this.relevantEntities(playerPosition, radius)), iter = skipStatic ? this._dynamicEntityIds : this.entities.keys()
    for (const id of iter) { const e = this.entities.get(id); if (e && (relevant.has(id) || e._appName === 'environment')) entities.push(this._encodeEntity(id, e)) }
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  getDynamicEntitiesRaw() {
    const out = []
    for (const id of this._activeDynamicIds) { const e = this.entities.get(id); if (e) out.push({ id, model: e.model, position: e.position, rotation: e.rotation, velocity: e.velocity, bodyType: e.bodyType, custom: e.custom, _isEnv: e._appName === 'environment', _sleeping: false }) }
    for (const id of this._sleepingDynamicIds) { out.push({ id, _sleeping: true }) }
    for (const id of this._suspendedEntityIds) { out.push({ id, _sleeping: true }) }
    return out
  }

  getRelevantDynamicIds(playerPosition, radius) { return this.relevantEntities(playerPosition, radius) }

  getSceneGraph() {
    const nodes = []
    for (const [id, e] of this.entities) { if (!e.parent) nodes.push(this._buildNode(id, e)) }
    return nodes
  }

  _buildNode(id, e) {
    return { id, appName: e._appName, label: e._config?.label || e._appName || id, children: [...e.children].map(cid => this._buildNode(cid, this.entities.get(cid))).filter(Boolean) }
  }

  queryEntities(f) { const r = []; for (const e of this.entities.values()) { if (!f || f(e)) r.push(e) } return r }
  getEntity(id) { return this.entities.get(id) || null }
  fireEvent(eid, en, ...a) { const ad = this.apps.get(eid), c = this.contexts.get(eid); if (!ad || !c) return; this._log('app_event', { entityId: eid, event: en, args: a }, { sourceEntity: eid }); const s = ad.server || ad; if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${eid})`) }
  fireInteract(eid, p) { this.fireEvent(eid, 'onInteract', p) }
  fireMessage(eid, m) { this.fireEvent(eid, 'onMessage', m) }
  addTimer(e, d, fn, r) { if (!this._timers.has(e)) this._timers.set(e, []); this._timers.get(e).push({ remaining: d, fn, repeat: r, interval: d }) }
  clearTimers(eid) { this._timers.delete(eid) }
  setPlayerManager(pm) { this._playerManager = pm }
  setStageLoader(sl) { this._stageLoader = sl }
  getPlayers() { return this._playerManager ? this._playerManager.getConnectedPlayers() : [] }
  getNearestPlayer(pos, r) { let n=null,md=r*r; for (const p of this.getPlayers()) { const pp=p.state?.position; if (!pp) continue; const d=(pp[0]-pos[0])**2+(pp[1]-pos[1])**2+(pp[2]-pos[2])**2; if (d<md) { md=d; n=p } } return n }
  broadcastToPlayers(m) { if (this._connections) this._connections.broadcast(MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.broadcast(m) }
  sendToPlayer(id, m) { if (this._connections) this._connections.send(id, MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.sendToPlayer(id, m) }
  setPlayerPosition(id, p) { this._physicsIntegration?.setPlayerPosition(id, p); if (this._playerManager) { const pl=this._playerManager.getPlayer(id); if (pl) pl.state.position=[...p] } }
  queueReload(n, d, cb) { this._hotReload.enqueue(n, d, cb) }
  _drainReloadQueue() { this._hotReload.drain() }
  hotReload(n, d) { this._hotReload._execute(n, d) }
  _spatialInsert(entity) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage && !stage.hasEntity(entity.id)) { stage.entityIds.add(entity.id); stage.spatial.insert(entity.id, entity.position); if (entity.bodyType==='static') stage._staticIds.add(entity.id) } }
  _spatialRemove(entityId) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage) { stage.spatial.remove(entityId); stage._staticIds.delete(entityId); stage.entityIds.delete(entityId) } }
  _spatialSync() { if (this._stageLoader) this._stageLoader.syncAllPositions() }
  nearbyEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getNearbyEntities(position, radius) }
  relevantEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getRelevantEntities(position, radius) }
  _log(type, data, meta = {}) { if (this._eventLog) this._eventLog.record(type, data, { ...meta, tick: this.currentTick }) }
  _safeCall(o, m, a, l) {
    if (!o?.[m]) return Promise.resolve()
    try { const r = o[m](...a); if (r?.catch) return r.catch(e => console.error(`[AppRuntime] ${l}: ${e.message}`)); return Promise.resolve() }
    catch (e) { console.error(`[AppRuntime] ${l}: ${e.message}`); return Promise.reject(e) }
  }
}
