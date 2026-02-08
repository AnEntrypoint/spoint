import { AppContext } from './AppContext.js'
import { HotReloadQueue } from './HotReloadQueue.js'
import { EventBus } from './EventBus.js'
import { mulQuat, rotVec } from '../math.js'
import { MSG } from '../protocol/MessageTypes.js'

export class AppRuntime {
  constructor(c = {}) {
    this.entities = new Map(); this.apps = new Map(); this.contexts = new Map()
    this.gravity = c.gravity || [0, -9.81, 0]
    this.currentTick = 0; this.deltaTime = 0; this.elapsed = 0
    this._playerManager = c.playerManager || null; this._physics = c.physics || null; this._physicsIntegration = c.physicsIntegration || null
    this._connections = c.connections || null; this._stageLoader = c.stageLoader || null
    this._nextEntityId = 1; this._appDefs = new Map(); this._timers = new Map()
    this._hotReload = new HotReloadQueue(this)
    this._eventBus = c.eventBus || new EventBus()
    this._eventLog = c.eventLog || null
    this._storage = c.storage || null
    this._eventBus.on('*', (event) => {
      if (event.channel.startsWith('system.')) return
      this._log('bus_event', { channel: event.channel, data: event.data }, event.meta)
    })
    this._eventBus.on('system.handover', (event) => {
      const { targetEntityId, stateData } = event.data || {}
      if (targetEntityId) this.fireEvent(targetEntityId, 'onHandover', event.meta.sourceEntity, stateData)
    })
  }

  registerApp(name, appDef) { this._appDefs.set(name, appDef) }

  spawnEntity(id, config = {}) {
    const entityId = id || `entity_${this._nextEntityId++}`
    const entity = {
      id: entityId, model: config.model || null,
      position: config.position ? [...config.position] : [0, 0, 0],
      rotation: config.rotation || [0, 0, 0, 1],
      scale: config.scale ? [...config.scale] : [1, 1, 1],
      velocity: [0, 0, 0], mass: 1, bodyType: 'static', collider: null,
      parent: null, children: new Set(),
      _appState: null, _appName: config.app || null, _config: config.config || null, custom: null
    }
    this.entities.set(entityId, entity)
    this._log('entity_spawn', { id: entityId, config }, { sourceEntity: entityId })
    if (config.parent) {
      const p = this.entities.get(config.parent)
      if (p) { entity.parent = config.parent; p.children.add(entityId) }
    }
    if (config.autoTrimesh && entity.model && this._physics) {
      entity.collider = { type: 'trimesh', model: entity.model }
      entity._physicsBodyId = this._physics.addStaticTrimesh(entity.model, 0)
    }
    if (config.app) this._attachApp(entityId, config.app)
    this._spatialInsert(entity)
    return entity
  }

  _attachApp(entityId, appName) {
    const entity = this.entities.get(entityId), appDef = this._appDefs.get(appName)
    if (!entity || !appDef) return
    const ctx = new AppContext(entity, this)
    this.contexts.set(entityId, ctx); this.apps.set(entityId, appDef)
    this._safeCall(appDef.server || appDef, 'setup', [ctx], `setup(${appName})`)
  }

  attachApp(entityId, appName) { this._attachApp(entityId, appName) }
  spawnWithApp(id, cfg = {}, app) { return this.spawnEntity(id, { ...cfg, app }) }
  attachAppToEntity(eid, app, cfg = {}) { const e = this.getEntity(eid); if (!e) return false; e._config = cfg; this._attachApp(eid, app); return true }
  reattachAppToEntity(eid, app) { this.detachApp(eid); this._attachApp(eid, app) }
  getEntityWithApp(eid) { const e = this.entities.get(eid); return { entity: e, appName: e?._appName, hasApp: !!e?._appName } }

  detachApp(entityId) {
    const appDef = this.apps.get(entityId), ctx = this.contexts.get(entityId)
    if (appDef && ctx) this._safeCall(appDef.server || appDef, 'teardown', [ctx], 'teardown')
    this._eventBus.destroyScope(entityId)
    this.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
  }

  destroyEntity(entityId) {
    const entity = this.entities.get(entityId); if (!entity) return
    this._log('entity_destroy', { id: entityId }, { sourceEntity: entityId })
    for (const childId of [...entity.children]) this.destroyEntity(childId)
    if (entity.parent) { const p = this.entities.get(entity.parent); if (p) p.children.delete(entityId) }
    this._eventBus.destroyScope(entityId)
    this.detachApp(entityId); this._spatialRemove(entityId); this.entities.delete(entityId)
  }

  reparent(entityId, newParentId) {
    const e = this.entities.get(entityId); if (!e) return
    if (e.parent) { const old = this.entities.get(e.parent); if (old) old.children.delete(entityId) }
    e.parent = null
    if (newParentId) { const np = this.entities.get(newParentId); if (np) { e.parent = newParentId; np.children.add(entityId) } }
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

  tick(tickNum, dt) {
    this.currentTick = tickNum; this.deltaTime = dt; this.elapsed += dt
    for (const [entityId, appDef] of this.apps) {
      const ctx = this.contexts.get(entityId); if (!ctx) continue
      this._safeCall(appDef.server || appDef, 'update', [ctx, dt], `update(${entityId})`)
    }
    this._tickTimers(dt); this._spatialSync(); this._tickCollisions()
  }

  _encodeEntity(id, e) {
    const r = Array.isArray(e.rotation) ? [...e.rotation] : [e.rotation.x || 0, e.rotation.y || 0, e.rotation.z || 0, e.rotation.w || 1]
    return { id, model: e.model, position: [...e.position], rotation: r, scale: [...e.scale], bodyType: e.bodyType, custom: e.custom || null, parent: e.parent || null }
  }

  getSnapshot() {
    const entities = []
    for (const [id, e] of this.entities) entities.push(this._encodeEntity(id, e))
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  getSnapshotForPlayer(playerPosition, radius) {
    const relevant = new Set(this.relevantEntities(playerPosition, radius))
    const entities = []
    for (const [id, e] of this.entities) { if (relevant.has(id)) entities.push(this._encodeEntity(id, e)) }
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  queryEntities(f) { return f ? Array.from(this.entities.values()).filter(f) : Array.from(this.entities.values()) }
  getEntity(id) { return this.entities.get(id) || null }
  fireEvent(eid, en, ...a) { const ad = this.apps.get(eid), c = this.contexts.get(eid); if (!ad || !c) return; this._log('app_event', { entityId: eid, event: en, args: a }, { sourceEntity: eid }); const s = ad.server || ad; if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${eid})`) }
  fireInteract(eid, p) { this.fireEvent(eid, 'onInteract', p) }
  fireMessage(eid, m) { this.fireEvent(eid, 'onMessage', m) }
  addTimer(e, d, fn, r) { if (!this._timers.has(e)) this._timers.set(e, []); this._timers.get(e).push({ remaining: d, fn, repeat: r, interval: d }) }
  clearTimers(eid) { this._timers.delete(eid) }

  _tickTimers(dt) {
    for (const [eid, timers] of this._timers) {
      const keep = []
      for (const t of timers) {
        t.remaining -= dt
        if (t.remaining <= 0) { try { t.fn() } catch (e) { console.error(`[AppRuntime] timer(${eid}):`, e.message) }; if (t.repeat) { t.remaining = t.interval; keep.push(t) } }
        else keep.push(t)
      }
      if (keep.length) this._timers.set(eid, keep); else this._timers.delete(eid)
    }
  }

  _tickCollisions() {
    const c = Array.from(this.entities.values()).filter(e => e.collider && this.apps.has(e.id))
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      const a = c[i], b = c[j], d = Math.hypot(b.position[0]-a.position[0], b.position[1]-a.position[1], b.position[2]-a.position[2])
      if (d < this._colR(a.collider) + this._colR(b.collider)) {
        this.fireEvent(a.id, 'onCollision', { id: b.id, position: b.position, velocity: b.velocity })
        this.fireEvent(b.id, 'onCollision', { id: a.id, position: a.position, velocity: a.velocity })
      }
    }
  }

  _colR(c) { return !c ? 0 : c.type === 'sphere' ? (c.radius||1) : c.type === 'capsule' ? Math.max(c.radius||0.5,(c.height||1)/2) : c.type === 'box' ? Math.max(...(c.size||c.halfExtents||[1,1,1])) : 1 }
  setPlayerManager(pm) { this._playerManager = pm }
  setStageLoader(sl) { this._stageLoader = sl }
  getPlayers() { return this._playerManager ? this._playerManager.getConnectedPlayers() : [] }

  getNearestPlayer(pos, r) {
    let n = null, md = r * r
    for (const p of this.getPlayers()) { const pp = p.state?.position; if (!pp) continue; const d = (pp[0]-pos[0])**2+(pp[1]-pos[1])**2+(pp[2]-pos[2])**2; if (d < md) { md = d; n = p } }
    return n
  }

  broadcastToPlayers(m) { if (this._connections) this._connections.broadcast(MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.broadcast(m) }
  sendToPlayer(id, m) { if (this._connections) this._connections.send(id, MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.sendToPlayer(id, m) }
  setPlayerPosition(id, p) { this._physicsIntegration?.setPlayerPosition(id, p); if (this._playerManager) { const pl = this._playerManager.getPlayer(id); if (pl) pl.state.position = [...p] } }

  queueReload(n, d, cb) { this._hotReload.enqueue(n, d, cb) }
  _drainReloadQueue() { this._hotReload.drain() }
  hotReload(n, d) { this._hotReload._execute(n, d) }

  _spatialInsert(entity) {
    if (!this._stageLoader) return; const stage = this._stageLoader.getActiveStage()
    if (stage && !stage.hasEntity(entity.id)) { stage.entityIds.add(entity.id); stage.spatial.insert(entity.id, entity.position); if (entity.bodyType === 'static') stage._staticIds.add(entity.id) }
  }
  _spatialRemove(entityId) { if (!this._stageLoader) return; const stage = this._stageLoader.getActiveStage(); if (stage) { stage.spatial.remove(entityId); stage._staticIds.delete(entityId); stage.entityIds.delete(entityId) } }
  _spatialSync() { if (this._stageLoader) this._stageLoader.syncAllPositions() }
  nearbyEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getNearbyEntities(position, radius) }
  relevantEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getRelevantEntities(position, radius) }

  _log(type, data, meta = {}) { if (this._eventLog) this._eventLog.record(type, data, { ...meta, tick: this.currentTick }) }
  _safeCall(o, m, a, l) { if (!o?.[m]) return; try { o[m](...a) } catch (e) { console.error(`[AppRuntime] ${l}: ${e.message}\n  ${e.stack?.split('\n').slice(1, 3).join('\n  ') || ''}`) } }
}
