import { AppContext } from './AppContext.js'
import { HotReloadQueue } from './HotReloadQueue.js'
import { EventBus } from './EventBus.js'
import { mulQuat, rotVec } from '../math.js'
import { MSG } from '../protocol/MessageTypes.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export class AppRuntime {
  constructor(c = {}) {
    this.entities = new Map(); this.apps = new Map(); this.contexts = new Map(); this._updateList = []; this._staticVersion = 0; this._dynamicEntityIds = new Set()
    this.gravity = c.gravity || [0, -9.81, 0]
    this.currentTick = 0; this.deltaTime = 0; this.elapsed = 0
    this._playerManager = c.playerManager || null; this._physics = c.physics || null; this._physicsIntegration = c.physicsIntegration || null
    this._connections = c.connections || null; this._stageLoader = c.stageLoader || null
    this._nextEntityId = 1; this._appDefs = new Map(); this._timers = new Map(); this._interactCooldowns = new Map(); this._respawnTimer = new Map()
    this._activeDynamicIds = new Set()
    this._hotReload = new HotReloadQueue(this)
    this._eventBus = c.eventBus || new EventBus()
    this._eventLog = c.eventLog || null
    this._storage = c.storage || null
    this._sdkRoot = c.sdkRoot || null
    this._eventBus.on('*', (event) => {
      if (event.channel.startsWith('system.')) return
      this._log('bus_event', { channel: event.channel, data: event.data }, event.meta)
    })
    this._eventBus.on('system.handover', (event) => {
      const { targetEntityId, stateData } = event.data || {}
      if (targetEntityId) this.fireEvent(targetEntityId, 'onHandover', event.meta.sourceEntity, stateData)
    })
  }

  resolveAssetPath(p) {
    if (!p) return p
    const local = resolve(p)
    if (existsSync(local)) return local
    if (this._sdkRoot) {
      const sdk = resolve(this._sdkRoot, p)
      if (existsSync(sdk)) {
        console.debug(`[SDK-DEFAULT] using bundled asset: ${p}`)
        return sdk
      }
    }
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
    this._rebuildUpdateList()
  }

  async attachApp(entityId, appName) { await this._attachApp(entityId, appName) }
  async spawnWithApp(id, cfg = {}, app) { return await this.spawnEntity(id, { ...cfg, app }) }
  async attachAppToEntity(eid, app, cfg = {}) { const e = this.getEntity(eid); if (!e) return false; e._config = cfg; await this._attachApp(eid, app); return true }
  async reattachAppToEntity(eid, app) { this.detachApp(eid); await this._attachApp(eid, app) }
  getEntityWithApp(eid) { const e = this.entities.get(eid); return { entity: e, appName: e?._appName, hasApp: !!e?._appName } }

  detachApp(entityId) {
    const appDef = this.apps.get(entityId), ctx = this.contexts.get(entityId)
    if (appDef && ctx) this._safeCall(appDef.server || appDef, 'teardown', [ctx], 'teardown')
    this._eventBus.destroyScope(entityId)
    this.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
    this._rebuildUpdateList()
  }

  _rebuildUpdateList() {
    this._updateList = []
    for (const [entityId, appDef] of this.apps) {
      const ctx = this.contexts.get(entityId); if (!ctx) continue
      const server = appDef.server || appDef
      if (typeof server.update === 'function') this._updateList.push([entityId, server, ctx])
    }
  }

  destroyEntity(entityId) {
    const entity = this.entities.get(entityId); if (!entity) return
    this._staticVersion++
    this._dynamicEntityIds.delete(entityId)
    this._activeDynamicIds.delete(entityId)
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
    for (const [entityId, server, ctx] of this._updateList) {
      this._safeCall(server, 'update', [ctx, dt], `update(${entityId})`)
    }
    this._tickTimers(dt)
    const _ts0 = performance.now()
    this._syncDynamicBodies()
    this._lastSyncMs = performance.now() - _ts0
    const _ts1 = performance.now()
    this._tickRespawn()
    this._lastRespawnMs = performance.now() - _ts1
    const _ts2 = performance.now()
    this._spatialSync()
    this._lastSpatialMs = performance.now() - _ts2
    this._tickCollisions(); this._tickInteractables()
  }

  _syncDynamicBodies() {
    if (!this._physics) return
    const fullScan = this.currentTick % 128 === 0
    const ids = fullScan ? this._dynamicEntityIds : this._activeDynamicIds
    for (const id of ids) {
      const e = this.entities.get(id)
      if (!e || e._physicsBodyId === undefined) continue
      const active = this._physics.syncDynamicBody(e._physicsBodyId, e)
      if (active) { this._activeDynamicIds.add(id); e._dynSleeping = false }
      else { this._activeDynamicIds.delete(id); e._dynSleeping = true }
    }
  }

  _encodeEntity(id, e) {
    const r = Array.isArray(e.rotation) ? [...e.rotation] : [e.rotation.x || 0, e.rotation.y || 0, e.rotation.z || 0, e.rotation.w || 1]
    const v = e.velocity || [0, 0, 0]
    return { id, model: e.model, position: [...e.position], rotation: r, scale: [...e.scale], velocity: [...v], bodyType: e.bodyType, custom: e.custom || null, parent: e.parent || null }
  }

  getSnapshot() {
    const entities = []
    for (const [id, e] of this.entities) entities.push(this._encodeEntity(id, e))
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  getSnapshotForPlayer(playerPosition, radius, skipStatic = false) {
    const entities = []
    if (skipStatic) {
      const relevant = new Set(this.relevantEntities(playerPosition, radius))
      for (const id of this._dynamicEntityIds) {
        const e = this.entities.get(id)
        if (e && (relevant.has(id) || e._appName === 'environment')) entities.push(this._encodeEntity(id, e))
      }
    } else {
      const relevant = new Set(this.relevantEntities(playerPosition, radius))
      for (const [id, e] of this.entities) {
        if (relevant.has(id) || e._appName === 'environment') entities.push(this._encodeEntity(id, e))
      }
    }
    return { tick: this.currentTick, timestamp: Date.now(), entities }
  }

  getDynamicEntitiesRaw() {
    const out = []
    for (const id of this._dynamicEntityIds) {
      const e = this.entities.get(id)
      if (e) out.push({ id, model: e.model, position: e.position, rotation: e.rotation, velocity: e.velocity, bodyType: e.bodyType, custom: e.custom, _isEnv: e._appName === 'environment', _sleeping: e._dynSleeping || false })
    }
    return out
  }

  getRelevantDynamicIds(playerPosition, radius) {
    const relevant = new Set(this.relevantEntities(playerPosition, radius))
    return relevant
  }

  getNearbyPlayers(viewerPosition, radius, allPlayers) {
    if (!allPlayers || allPlayers.length === 0) return []
    const cx = viewerPosition[0], cy = viewerPosition[1], cz = viewerPosition[2]
    const r2 = radius * radius
    const nearby = []
    for (const p of allPlayers) {
      const dx = p.position[0] - cx, dy = p.position[1] - cy, dz = p.position[2] - cz
      if (dx * dx + dy * dy + dz * dz <= r2) nearby.push(p)
    }
    return nearby
  }

  queryEntities(f) { const r = []; for (const e of this.entities.values()) { if (!f || f(e)) r.push(e) } return r }
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
    const c = []
    for (const e of this.entities.values()) {
      const app = this.apps.get(e.id)
      const server = app?.server || app
      if (e.collider && server?.onCollision) { e._cachedColR = this._colR(e.collider); c.push(e) }
    }
    for (let i = 0; i < c.length; i++) {
      const a = c[i], ar = a._cachedColR, ax = a.position[0], ay = a.position[1], az = a.position[2]
      for (let j = i + 1; j < c.length; j++) {
        const b = c[j], dx = b.position[0]-ax, dy = b.position[1]-ay, dz = b.position[2]-az
        const rr = ar + b._cachedColR
        if (dx*dx+dy*dy+dz*dz < rr*rr) {
          this.fireEvent(a.id, 'onCollision', { id: b.id, position: b.position, velocity: b.velocity })
          this.fireEvent(b.id, 'onCollision', { id: a.id, position: a.position, velocity: a.velocity })
        }
      }
    }
  }

  _tickRespawn() {
    const now = Date.now()
    for (const id of this._activeDynamicIds) {
      const e = this.entities.get(id); if (!e) continue
      if (e.position[1] < -20) {
        if (!this._respawnTimer.has(id)) this._respawnTimer.set(id, { startTime: now, lastRespawn: 0 })
        const timer = this._respawnTimer.get(id)
        if ((now - timer.startTime) / 1000 >= 5 && now - timer.lastRespawn >= 1000) {
          const spawnPos = e._spawnPosition || [0, 20, 0]
          e.position[0] = spawnPos[0]; e.position[1] = spawnPos[1]; e.position[2] = spawnPos[2]
          e.velocity[0] = 0; e.velocity[1] = 0; e.velocity[2] = 0
          if (e._physicsBodyId !== undefined && this._physics) {
            this._physics.setBodyPosition(e._physicsBodyId, spawnPos)
            this._physics.setBodyVelocity(e._physicsBodyId, [0, 0, 0])
          }
          timer.startTime = now; timer.lastRespawn = now
        }
      } else {
        this._respawnTimer.delete(id)
      }
    }
  }

  _tickInteractables() {
    const now = Date.now()
    const players = this.getPlayers()
    for (const e of this.entities.values()) {
      if (!e._interactable) continue
      for (const p of players) {
        const pp = p.state?.position; if (!pp) continue
        const dx = pp[0]-e.position[0], dy = pp[1]-e.position[1], dz = pp[2]-e.position[2]
        if (dx*dx+dy*dy+dz*dz > e._interactRadius**2) continue
        const key = `${e.id}:${p.id}`
        const last = this._interactCooldowns.get(key) || 0
        const cooldown = e._interactCooldown ?? 500
        if (p.lastInput?.interact && now - last > cooldown) {
          this._interactCooldowns.set(key, now)
          this.fireEvent(e.id, 'onInteract', p)
          const bus = this._eventBus.scope ? this._eventBus : null
          if (bus) bus.emit(`interact.${e.id}`, { player: p, entity: e })
        }
      }
    }
  }

  _colR(c) {
    if (!c) return 0
    if (c.type === 'sphere') return c.radius || 1
    if (c.type === 'capsule') return Math.max(c.radius || 0.5, (c.height || 1) / 2)
    if (c.type === 'box') {
      const s = c.size; const h = c.halfExtents
      if (Array.isArray(s)) return Math.max(...s)
      if (typeof s === 'number') return s
      if (Array.isArray(h)) return Math.max(...h)
      return 1
    }
    return 1
  }
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
  _safeCall(o, m, a, l) {
    if (!o?.[m]) return Promise.resolve()
    try {
      const result = o[m](...a)
      if (result && typeof result.catch === 'function') {
        return result.catch(e => console.error(`[AppRuntime] ${l}: ${e.message}\n  ${e.stack?.split('\n').slice(1, 3).join('\n  ') || ''}`))
      }
      return Promise.resolve()
    } catch (e) {
      console.error(`[AppRuntime] ${l}: ${e.message}\n  ${e.stack?.split('\n').slice(1, 3).join('\n  ') || ''}`)
      return Promise.reject(e)
    }
  }
}
