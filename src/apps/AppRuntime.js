import { AppContext } from './AppContext.js'
import { HotReloadQueue } from './HotReloadQueue.js'
import { EventBus } from './EventBus.js'
import { createEcsEntityMap } from './EcsEntityMap.js'
import { mulQuat, rotVec } from '../math.js'
import { MSG } from '../protocol/MessageTypes.js'
import { SpatialIndex } from '../spatial/Octree.js'
import { vecOK } from '../shared/vecGuard.js'
import { weaponNameToCode } from '../shared/WeaponCodes.js'
import { mixinPhysics } from './AppRuntimePhysics.js'
import { mixinTick } from './AppRuntimeTick.js'
import { installCustomVersion } from './CustomVersion.js'
import { resolveCCD } from './AppPhysics.js'

import { containedAssetPath, tagAppState, untagAppState, _existsSync, _resolve } from './AppRuntimeState.js'

class HookedSet extends Set {
  constructor(onChange) { super(); this._onChange = onChange }
  add(v) { if (!super.has(v)) { super.add(v); this._onChange(v, true) } return this }
  delete(v) { const r = super.delete(v); if (r) this._onChange(v, false); return r }
  clear() { if (this.size > 0) { const ids = [...this]; super.clear(); for (const v of ids) this._onChange(v, false) } }
}

export class AppRuntime {
  constructor(c = {}) {
    this._unmanagedIds = []; this._unmanagedDirty = true
    const markUnmanagedDirty = () => { this._unmanagedDirty = true }
    this._staticCustomSum = 0
    const onStaticChange = (id, added) => {
      this._unmanagedDirty = true
      const e = this.entities.get(id); const v = e && typeof e._customV === 'number' ? e._customV : 0
      this._staticCustomSum += added ? v : -v
    }
    this._pbidDesc = {
      enumerable: true, configurable: true,
      get() { return this._pbidRaw },
      set(v) { this._pbidRaw = v; markUnmanagedDirty() }
    }
    this.entities = createEcsEntityMap(); this.apps = new Map(); this.contexts = new Map(); this._updateList = []; this._staticVersion = 0; this._dynamicEntityIds = new HookedSet(markUnmanagedDirty); this._staticEntityIds = new HookedSet(onStaticChange)
    this.gravity = c.gravity || [0, -9.81, 0]
    this.currentTick = 0; this.deltaTime = 0; this.elapsed = 0
    this._playerManager = c.playerManager || null; this._physics = c.physics || null; this._physicsIntegration = c.physicsIntegration || null
    this._connections = c.connections || null; this._stageLoader = c.stageLoader || null
    this._nextEntityId = 1; this._appDefs = new Map(); this._timers = new Map(); this._interactCooldowns = new Map(); this._respawnTimer = new Map()
    this._activeDynamicIds = new HookedSet(markUnmanagedDirty); this._sleepingDynamicIds = new HookedSet(markUnmanagedDirty); this._physicsBodyToEntityId = new Map(); this._suspendedEntityIds = new HookedSet(markUnmanagedDirty); this._pendingTrimeshEntities = new Map()
    this._physicsLODRadius = c.physicsRadius || 0; this._lagCompensator = c.lagCompensator || null
    this._physicsBodyBudget = c.physicsBodyBudget || 0
    const serverTickRate = c.tickRate || 64, entityTickRate = c.entityTickRate || serverTickRate
    this._entityTickDivisor = Math.max(1, Math.round(serverTickRate / entityTickRate)); this._physicsLODInterval = Math.max(1, Math.round(serverTickRate / 2))
    this._playerIndex = new SpatialIndex(); this._collisionEntities = []; this._interactableIds = new Set(); this._playerIndexIds = new Set()
    this._proximityWatches = new Map()
    this._playerContactWatches = new Map()
    this._attachments = new Map()
    this._shutdownHooks = new Set()
    this._pendingSetupIds = new Set()
    this._pendingSetupQueues = new Map()
    this._lastSyncMs = 0; this._lastRespawnMs = 0; this._lastSpatialMs = 0; this._lastCollisionMs = 0; this._lastInteractMs = 0; this._lastProximityMs = 0
    this._deferredPopulationOps = []; this._resimSuppressed = false
    this._deferredCommitmentOps = []
    this._pendingTrimeshBuilds = new Set()
    mixinPhysics(this); mixinTick(this); if (this._physics) this._registerPhysicsCallbacks()
    this._hotReload = new HotReloadQueue(this); this._eventBus = c.eventBus || new EventBus()
    this._appVersions = new Map()
    this._eventLog = c.eventLog||null; this._storage = c.storage||null; this._sdkRoot = c.sdkRoot||null
    this._snapshotCache = null; this._snapshotVersion = 0; this._entityVersions = new Map()
    this._eventBus.on('*', ev => { if (!ev.channel.startsWith('system.')) this._log('bus_event', { channel:ev.channel, data:ev.data }, ev.meta) })
    this._eventBus.on('system.handover', ev => { const {targetEntityId,stateData}=ev.data||{}; if (targetEntityId) this.fireEvent(targetEntityId,'onHandover',ev.meta.sourceEntity,stateData) })
  }

  resolveAssetPath(p) {
    if (!p) return p
    if (!_resolve) { const rel = p.startsWith('./') ? p.slice(1) : p; return rel.startsWith('/') ? rel : '/' + rel }
    const cwdRoot = _resolve(process.cwd())
    const local = _resolve(p)
    if (_existsSync(local)) {
      const contained = containedAssetPath(local, cwdRoot)
      if (!contained) { console.warn(`[AppRuntime] resolveAssetPath rejected '${p}' -- resolves outside the server root`); return null }
      return contained
    }
    if (this._sdkRoot) {
      const sdk = _resolve(this._sdkRoot, p)
      if (_existsSync(sdk)) {
        const contained = containedAssetPath(sdk, _resolve(this._sdkRoot))
        if (!contained) { console.warn(`[AppRuntime] resolveAssetPath rejected '${p}' -- resolves outside the SDK root`); return null }
        console.debug(`[SDK-DEFAULT] using bundled asset: ${p}`)
        return contained
      }
    }
    return local
  }

  registerApp(name, appDef) { this._appDefs.set(name, appDef) }

  registerShutdownHook(cb) {
    this._shutdownHooks.add(cb)
    return () => this._shutdownHooks.delete(cb)
  }

  async runShutdownHooks() {
    if (this._shutdownHooks.size === 0) return
    const hooks = [...this._shutdownHooks]
    const results = await Promise.allSettled(hooks.map(fn => fn()))
    results.forEach((r, i) => { if (r.status === 'rejected') console.error('[shutdown] hook error:', r.reason?.message || r.reason) })
  }

  _deferPopulationOp(kind, args) {
    this._deferredPopulationOps.push({ kind, args })
  }

  _flushDeferredPopulationOps() {
    if (!this._deferredPopulationOps.length) return 0
    const ops = this._deferredPopulationOps
    this._deferredPopulationOps = []
    for (const { kind, args } of ops) {
      if (kind === 'spawn') this.spawnEntity(...args)
      else if (kind === 'destroy') this.destroyEntity(...args)
    }
    return ops.length
  }

  _discardDeferredPopulationOps() {
    const n = this._deferredPopulationOps.length
    this._deferredPopulationOps = []
    return n
  }

  _deferOrRun(fn) {
    if (this._resimSuppressed) { this._deferredCommitmentOps.push(fn); return }
    fn()
  }

  _flushDeferredCommitmentOps() {
    if (!this._deferredCommitmentOps.length) return 0
    const ops = this._deferredCommitmentOps
    this._deferredCommitmentOps = []
    for (const fn of ops) fn()
    return ops.length
  }

  trackTrimeshBuild(promise) {
    this._pendingTrimeshBuilds.add(promise)
    const done = () => this._pendingTrimeshBuilds.delete(promise)
    promise.then(done, done)
    return promise
  }

  async waitForPendingTrimeshBuilds(timeoutMs = 5000) {
    const pending = [...this._pendingTrimeshBuilds]
    if (!pending.length) return { waited: 0, timedOut: false }
    let timedOut = false
    const timeout = new Promise(resolve => setTimeout(() => { timedOut = true; resolve() }, timeoutMs))
    await Promise.race([Promise.allSettled(pending), timeout])
    if (timedOut) console.warn(`[AppRuntime] waitForPendingTrimeshBuilds timed out after ${timeoutMs}ms with ${this._pendingTrimeshBuilds.size}/${pending.length} still pending`)
    return { waited: pending.length, timedOut }
  }

  spawnEntity(id, config = {}) {
    if (this._resimSuppressed) { this._deferPopulationOp('spawn', [id, config]); return null }
    const entityId = id || `entity_${this._nextEntityId++}`
    const spawnPos = config.position ? [...config.position] : [0, 0, 0]
    const entity = {
      id: entityId, model: config.model || null,
      position: [...spawnPos],
      rotation: config.rotation || [0, 0, 0, 1],
      scale: config.scale ? [...config.scale] : [1, 1, 1],
      velocity: [0, 0, 0], mass: 1, bodyType: config.bodyType || 'static', collider: null,
      parent: null, children: new Set(),
      _appState: null, _appName: config.app || null, _config: config.config || null, custom: config.custom || null,
      _spawnPosition: spawnPos,
      _ccdPolicy: (config.ccd === 'always' || config.ccd === 'off') ? config.ccd : 'auto'
    }
    installCustomVersion(entity)
    this._installRuntimeHooks(entity)
    this.entities.set(entityId, entity)
    this._staticVersion++
    this._snapshotVersion++
    this._entityVersions.set(entityId, 1)
    if (entity.bodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    this._log('entity_spawn', { id: entityId, config }, { sourceEntity: entityId })
    if (config.parent) {
      let cycle = config.parent === entityId
      if (!cycle) { let cur = config.parent; while (cur) { if (cur === entityId) { cycle = true; break } cur = this.entities.get(cur)?.parent } }
      const p = cycle ? null : this.entities.get(config.parent)
      if (p) { entity.parent = config.parent; p.children.add(entityId) }
    }
    this._hydrateInteractable(entityId, entity)
    if (config.autoTrimesh && entity.model && this._physics) {
      entity.collider = { type: 'trimesh', model: entity.model }
      const settled = this._physics.addStaticTrimeshAsync(this.resolveAssetPath(entity.model), 0, entity.position || [0,0,0], entity.scale || [1,1,1], entity.rotation || [0,0,0,1])
        .then(id => { this._deferOrRun(() => { if (this.entities.has(entityId)) { entity._physicsBodyId = id; this._physicsBodyToEntityId?.set(id, entityId) } }) })
        .catch(e => {
          console.error(`[AppRuntime] trimesh failed for ${entity.model}, falling back to box:`, e.message)
          this._log('app_error', { label: `trimesh(${entity.model})`, message: e.message }, { sourceEntity: entityId })
          this._deferOrRun(() => {
            if (!this.entities.has(entityId)) return
            entity.collider = { type: 'box', size: [0.5, 0.5, 0.5] }
            const bid = this._physics.addBody('box', [0.5, 0.5, 0.5], entity.position, 'static', { rotation: entity.rotation })
            entity._physicsBodyId = bid
            this._physicsBodyToEntityId?.set(bid, entityId)
            this._connections?.broadcast?.(MSG.EDITOR_ERROR, { message: `PLACE_MODEL: trimesh build failed for ${entity.model}, using box collider fallback`, entityId, detail: e.message })
          })
        })
      this.trackTrimeshBuild(settled)
    }
    if (config.app) this._attachApp(entityId, config.app).catch(e => this._logAppError(`attachApp(${config.app})`, e))
    this._spatialInsert(entity)
    return entity
  }

  async _attachApp(entityId, appName) {
    const entity = this.entities.get(entityId), appDef = this._appDefs.get(appName)
    if (!entity) return
    if (!appDef) {
      const msg = `entity ${entityId} references app "${appName}" but it never loaded -- entity will have no server-side app logic (add it to worldDef.placeableApps if it is only ever spawned dynamically)`
      console.error(`[AppRuntime] ${msg}`)
      this._log('app_load_missing', { entityId, appName, message: msg }, { sourceEntity: entityId })
      return
    }
    if (this.apps.has(entityId)) this.detachApp(entityId)
    const ctx = new AppContext(entity, this)
    this.contexts.set(entityId, ctx); this.apps.set(entityId, appDef)
    entity._appName = appName
    this._pendingSetupIds.add(entityId)
    try {
      await this._safeCall(appDef.server || appDef, 'setup', [ctx], `setup(${appName})`)
    } finally {
      this._deferOrRun(() => {
        this._pendingSetupIds.delete(entityId)
        if (this.entities.has(entityId)) this._flushPendingEvents(entityId)
        else this._pendingSetupQueues.delete(entityId)
      })
    }
    this._deferOrRun(() => { if (this.entities.has(entityId)) this._scheduleRebuild() })
  }

  _flushPendingEvents(entityId) {
    const q = this._pendingSetupQueues.get(entityId)
    if (!q || !q.length) { this._pendingSetupQueues.delete(entityId); return }
    this._pendingSetupQueues.delete(entityId)
    const ad = this.apps.get(entityId), c = this.contexts.get(entityId)
    if (!ad || !c) return
    const s = ad.server || ad
    for (const { en, a } of q) { if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${entityId})`) }
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
  hasApp(eid) { return this.apps.has(eid) }
  getEntityWithApp(eid) { const e = this.entities.get(eid); return { entity: e, appName: e?._appName, hasApp: this.apps.has(eid) } }

  detachApp(entityId) {
    const appDef=this.apps.get(entityId), ctx=this.contexts.get(entityId)
    if (ctx?._teardownChildren) ctx._teardownChildren()
    if (appDef && ctx) this._safeCall(appDef.server||appDef, 'teardown', [ctx], 'teardown')
    if (ctx?._runDisposers) ctx._runDisposers()
    this._eventBus.destroyScope(entityId); this.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
    this._pendingSetupQueues.delete(entityId)
    this._proximityWatches.delete(entityId)
    const entity = this.entities.get(entityId); if (entity) entity._appName = null
    this._rebuildUpdateList(); this._rebuildCollisionList()
  }

  _rebuildUpdateList() {
    this._updateList = []
    for (const [id, ad] of this.apps) { if (this._pendingSetupIds.has(id)) continue; const ctx=this.contexts.get(id); if (!ctx) continue; const s=ad.server||ad; if (typeof s.update==='function') this._updateList.push({id,update:s.update.bind(s),ctx}) }
  }

  _rebuildCollisionList() {
    this._collisionEntities = []
    for (const [id, ad] of this.apps) { if (this._pendingSetupIds.has(id)) continue; const e=this.entities.get(id); if (!e) continue; const s=ad.server||ad; if (e.collider && typeof s.onCollision==='function') this._collisionEntities.push(e) }
  }

  destroyEntity(entityId) {
    if (this._resimSuppressed) { this._deferPopulationOp('destroy', [entityId]); return }
    const entity = this.entities.get(entityId); if (!entity) return
    this._staticVersion++
    this._dynamicEntityIds.delete(entityId); this._staticEntityIds.delete(entityId)
    this._activeDynamicIds.delete(entityId); this._sleepingDynamicIds.delete(entityId); this._suspendedEntityIds.delete(entityId)
    this._interactableIds.delete(entityId)
    this._proximityWatches.delete(entityId)
    if (entity._vehicleId != null && this._physics) { this._physics.removeVehicle(entity._vehicleId); entity._vehicleId = null }
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

  changeBodyType(entityId, newBodyType) {
    const entity = this.entities.get(entityId)
    if (!entity || !newBodyType || newBodyType === entity.bodyType) return false
    const old = entity.bodyType
    entity.bodyType = newBodyType
    if (old !== 'static') this._dynamicEntityIds.delete(entityId)
    else this._staticEntityIds.delete(entityId)
    if (newBodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    if (entity._physicsBodyId !== undefined) {
      this._physicsBodyToEntityId?.delete(entity._physicsBodyId)
      if (this._physics) this._physics.removeBody(entity._physicsBodyId)
      entity._physicsBodyId = undefined
      entity._bodyActive = false
    }
    const mt = newBodyType === 'dynamic' ? 'dynamic' : newBodyType === 'kinematic' ? 'kinematic' : 'static'
    this._activeDynamicIds?.delete(entityId)
    this._sleepingDynamicIds?.delete(entityId)
    this._suspendedEntityIds?.delete(entityId)
    if (mt !== 'static') {
      if (entity._bodyDef) {
        entity._bodyDef.motionType = mt
        if (entity._bodyDef.opts) entity._bodyDef.opts.linearCast = resolveCCD(entity, mt)
      } else if (entity.model) {
        const sc = entity.scale || [1, 1, 1]
        const heFallback = [Math.abs(sc[0] || 1) * 0.5, Math.abs(sc[1] || 1) * 0.5, Math.abs(sc[2] || 1) * 0.5]
        entity.collider = entity.collider || { type: 'box', size: heFallback }
        entity._bodyDef = { shapeType: 'box', params: heFallback, motionType: mt, opts: { mass: entity.mass, linearCast: resolveCCD(entity, mt) } }
        const modelPath = this.resolveAssetPath(entity.model)
        if (modelPath) {
          import('../physics/GLBLoader.js').then(({ extractAllVerticesFromGLBAsync }) => extractAllVerticesFromGLBAsync(modelPath)).then(mesh => {
            if (!this.entities.has(entityId) || entity.bodyType !== newBodyType) return
            const raw = mesh.vertices
            const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
            const bodyMt = entity._bodyDef?.motionType || mt
            entity.collider = { type: 'convex', points }
            entity._bodyDef = { shapeType: 'convex', params: points, motionType: bodyMt, opts: { mass: entity.mass, shapeKey: entity.model, linearCast: resolveCCD(entity, bodyMt) } }
            entity._bodyActive = false
          }).catch(e => { console.warn(`[physics] ${entity.model}: convex-hull collider resize failed (${e.message}), keeping scale-based box fallback`) })
        }
      } else {
        const sc = entity.scale || [1, 1, 1]
        const he = [Math.abs(sc[0] || 1) * 0.5, Math.abs(sc[1] || 1) * 0.5, Math.abs(sc[2] || 1) * 0.5]
        entity.collider = entity.collider || { type: 'box', size: he }
        entity._bodyDef = { shapeType: 'box', params: he, motionType: mt, opts: { mass: entity.mass, linearCast: resolveCCD(entity, mt) } }
      }
      entity._bodyActive = false
    }
    this._lodIds = null
    this._lodIdArr = null
    this._staticVersion++
    return true
  }

  _hydrateInteractable(entityId, entity) {
    const e = entity || this.entities.get(entityId); if (!e) return
    const flag = e.custom && e.custom._interactable
    if (flag) {
      const cfg = (typeof flag === 'object') ? flag : {}
      e._interactable = true
      e._interactRadius = (typeof cfg.radius === 'number' && cfg.radius >= 0) ? cfg.radius : (e._interactRadius ?? 3)
      e._interactCooldown = (typeof cfg.cooldown === 'number' && cfg.cooldown >= 0) ? cfg.cooldown : (e._interactCooldown ?? 500)
      this._interactableIds.add(entityId)
    } else {
      e._interactable = false
      this._interactableIds.delete(entityId)
    }
  }

  reparent(entityId, newParentId) {
    const e = this.entities.get(entityId); if (!e) return false
    if (newParentId) {
      if (newParentId === entityId) return false
      if (!this.entities.has(newParentId)) return false
      let cur = newParentId
      while (cur) { if (cur === entityId) return false; cur = this.entities.get(cur)?.parent }
    }
    const childWorld = this.getWorldTransform(entityId)
    if (e.parent) { const old=this.entities.get(e.parent); if (old) old.children.delete(entityId) }
    e.parent = null
    if (newParentId) {
      const np=this.entities.get(newParentId)
      if (np) {
        e.parent=newParentId; np.children.add(entityId)
        const pw = this.getWorldTransform(newParentId)
        if (pw && childWorld) {
          const sx = pw.scale[0] || 1, sy = pw.scale[1] || 1, sz = pw.scale[2] || 1
          const invRot = [-pw.rotation[0], -pw.rotation[1], -pw.rotation[2], pw.rotation[3]]
          const d = [childWorld.position[0]-pw.position[0], childWorld.position[1]-pw.position[1], childWorld.position[2]-pw.position[2]]
          const dr = rotVec(d, invRot)
          e.position = [dr[0]/sx, dr[1]/sy, dr[2]/sz]
          e.rotation = mulQuat(invRot, childWorld.rotation)
          e.scale = [childWorld.scale[0]/sx, childWorld.scale[1]/sy, childWorld.scale[2]/sz]
        }
      }
    } else if (childWorld) {
      e.position = [...childWorld.position]; e.rotation = [...childWorld.rotation]; e.scale = [...childWorld.scale]
    }
    this._staticVersion++
    this._markDirty(entityId)
    return true
  }

  duplicateEntity(entityId, offset = [0.5, 0, 0.5], intoId = null) {
    const e = this.entities.get(entityId); if (!e) return null
    const pos = [(e.position?.[0] || 0) + offset[0], (e.position?.[1] || 0) + offset[1], (e.position?.[2] || 0) + offset[2]]
    const copy = this.spawnEntity(intoId, {
      model: e.model || undefined,
      app: e._appName || undefined,
      position: pos,
      rotation: Array.isArray(e.rotation) ? [...e.rotation] : undefined,
      scale: e.scale ? [...e.scale] : undefined,
      config: e._config ? { ...e._config } : undefined,
      parent: e.parent || undefined
    })
    if (copy && e.custom) copy.custom = JSON.parse(JSON.stringify(e.custom))
    return copy
  }

  setLabel(entityId, label) {
    const e = this.entities.get(entityId); if (!e) return false
    e._config = { ...(e._config || {}), label: String(label) }
    return true
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

  _encodeEntity(id, e) { const r=Array.isArray(e.rotation)?[...e.rotation]:[e.rotation.x||0,e.rotation.y||0,e.rotation.z||0,e.rotation.w||1]; return { id, model:e.model, position:[...e.position], rotation:r, scale:[...e.scale], velocity:[...(e.velocity||[0,0,0])], bodyType:e.bodyType, custom:e.custom||null, parent:e.parent||null } }
  _markDirty(id) { this._snapshotVersion++; const v = this._entityVersions.get(id) || 0; this._entityVersions.set(id, v + 1) }
  _snap(entities) { return { tick: this.currentTick, timestamp: Date.now(), entities } }
  getSnapshot() { if (this._snapshotCache && this._snapshotCache._version === this._snapshotVersion) return this._snapshotCache; const e=[]; for (const [id,en] of this.entities) e.push(this._encodeEntity(id,en)); this._snapshotCache = Object.assign(this._snap(e), { _version: this._snapshotVersion }); return this._snapshotCache }
  getStaticSnapshot() { const e=[]; for (const id of this._staticEntityIds) { const en=this.entities.get(id); if (en) e.push(this._encodeEntity(id,en)) } return this._snap(e) }
  getStaticCustomVersionSum() { return this._staticCustomSum }

  _installRuntimeHooks(entity) {
    let v = typeof entity._customV === 'number' ? entity._customV : 0
    const rt = this
    Object.defineProperty(entity, '_customV', {
      enumerable: true, configurable: true,
      get() { return v },
      set(nv) { if (rt._staticEntityIds.has(entity.id)) rt._staticCustomSum += nv - v; v = nv }
    })
    Object.defineProperty(entity, '_pbidRaw', { value: undefined, writable: true, enumerable: false, configurable: true })
    Object.defineProperty(entity, '_physicsBodyId', this._pbidDesc)
  }
  getSnapshotForPlayer(pos, r, skipStatic=false) { const e=[], rel=new Set(this.relevantEntities(pos,r)); for (const id of (skipStatic?this._dynamicEntityIds:this.entities.keys())) { const en=this.entities.get(id); if (en&&(rel.has(id)||en.custom?._interior)) e.push(this._encodeEntity(id,en)) } return this._snap(e) }
  getDynamicEntitiesRaw() { const o=[]; for (const id of this._activeDynamicIds) { const e=this.entities.get(id); if (e) o.push({ id, model:e.model, position:e.position, rotation:e.rotation, velocity:e.velocity, bodyType:e.bodyType, custom:e.custom, _isEnv:!!e.custom?._interior, _sleeping:false }) } for (const id of this.getUnmanagedDynamicIds()) { const e=this.entities.get(id); if (e) o.push({ id, model:e.model, position:e.position, rotation:e.rotation, velocity:e.velocity, bodyType:e.bodyType, custom:e.custom, _isEnv:!!e.custom?._interior, _sleeping:false }) } for (const id of this._sleepingDynamicIds) o.push({ id, _sleeping:true }); for (const id of this._suspendedEntityIds) o.push({ id, _sleeping:true }); return o }
  getRelevantDynamicIds(pos, r) { return this.relevantEntities(pos, r) }
  getRelevantDynamicIdsWithStarvation(pos, r, viewerKey, maxTicksStarved = 300) {
    const ids = this.relevantEntities(pos, r)
    const spatial = this._stageLoader?._activeStage?.spatial
    if (!spatial || !viewerKey) return ids
    for (const id of ids) spatial.markSeen(id, viewerKey)
    const starved = spatial.collectStarved(viewerKey, maxTicksStarved)
    if (!starved.length) return ids
    const out = ids instanceof Set ? ids : new Set(ids)
    for (const id of starved) out.add(id)
    return out
  }
  getActiveDynamicIds() { return this._activeDynamicIds }
  getSleepingDynamicIds() { return this._sleepingDynamicIds }
  getSuspendedEntityIds() { return this._suspendedEntityIds }
  getUnmanagedDynamicIds() {
    if (!this._unmanagedDirty) return this._unmanagedIds
    const o = this._unmanagedIds; o.length = 0
    for (const id of this._dynamicEntityIds) { if (this._activeDynamicIds.has(id) || this._sleepingDynamicIds.has(id) || this._suspendedEntityIds.has(id)) continue; const e=this.entities.get(id); if (e && e._physicsBodyId===undefined) o.push(id) }
    this._unmanagedDirty = false
    return o
  }
  nearbyPlayerIds(pos, r) { return this._playerIndex.nearby(pos, r) }
  nearbyPlayerIdsHysteresis(pos, r, viewerKey) { return this._playerIndex.nearbyHysteresis(pos, r, viewerKey) }

  registerProximityWatch(entityId, radius, callback) {
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) throw new TypeError('[AppRuntime] registerProximityWatch: radius must be a non-negative finite number')
    if (typeof callback !== 'function') throw new TypeError('[AppRuntime] registerProximityWatch: callback must be a function')
    this._proximityWatches.set(entityId, { radius, radius2: radius * radius, callback })
    return () => this._proximityWatches.delete(entityId)
  }

  registerPlayerContactWatch(appId, radius, callback) {
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) throw new TypeError('[AppRuntime] registerPlayerContactWatch: radius must be a non-negative finite number')
    if (typeof callback !== 'function') throw new TypeError('[AppRuntime] registerPlayerContactWatch: callback must be a function')
    this._playerContactWatches.set(appId, { radius2: radius * radius, callback })
    return () => this._playerContactWatches.delete(appId)
  }

  getSceneGraph() {
    const n=[]
    for (const [id,e] of this.entities) if (!e.parent&&(this.apps.has(id)||e.custom||e.model)) n.push(this._buildNode(id,e))
    return n
  }
  _buildNode(id, e) { const r1=v=>Math.round(v*10)/10; return { id, appName:e._appName, label:e._config?.label||e._appName||id, position:e.position?[r1(e.position[0]),r1(e.position[1]),r1(e.position[2])]:null, custom:e.custom||null, ...(e.model ? { model: e.model } : {}), children:[...e.children].map(cid=>this._buildNode(cid,this.entities.get(cid))).filter(Boolean) } }

  queryEntities(f) { const r = []; for (const e of this.entities.values()) { if (!f || f(e)) r.push(e) } return r }
  getEntity(id) { return this.entities.get(id) || null }
  fireEvent(eid, en, ...a) {
    const ad = this.apps.get(eid), c = this.contexts.get(eid); if (!ad || !c) return
    this._log('app_event', { entityId: eid, event: en, args: a }, { sourceEntity: eid })
    if (this._pendingSetupIds.has(eid)) {
      let q = this._pendingSetupQueues.get(eid); if (!q) this._pendingSetupQueues.set(eid, q = [])
      q.push({ en, a })
      this._log('app_event_queued_pending_setup', { entityId: eid, event: en }, { sourceEntity: eid })
      return
    }
    const s = ad.server || ad; if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${eid})`)
  }
  fireInteract(eid, p) { this.fireEvent(eid, 'onInteract', p) }
  fireMessage(eid, m) { this.fireEvent(eid, 'onMessage', m) }
  broadcastMessage(m) { for (const entityId of [...this.apps.keys()]) this.fireMessage(entityId, m) }
  addTimer(e, d, fn, r) { if (!this._timers.has(e)) this._timers.set(e, []); this._timers.get(e).push({ remaining: d, fn, repeat: r, interval: d }) }
  clearTimers(eid) { this._timers.delete(eid) }
  setPlayerManager(pm) { this._playerManager = pm }
  setStageLoader(sl) { this._stageLoader = sl }
  setPlacedModelStorage(pms) { this._placedModelStorage = pms }
  getPlayers() { return this._playerManager ? this._playerManager.getConnectedPlayers() : [] }
  getPlayerById(id) { return this._playerManager ? this._playerManager.getPlayer(id) : null }
  getNearestPlayer(pos, r) { if (!vecOK(pos, 3) || typeof r !== 'number' || !Number.isFinite(r)) return null; const id = this._playerIndex?.nearest(pos, r); if (id != null) return this._playerManager?.getPlayer(id) || null; let n=null,md=r*r; for (const p of this.getPlayers()) { const pp=p.state?.position; if (!pp) continue; const dx=pp[0]-pos[0],dy=pp[1]-pos[1],dz=pp[2]-pos[2],d=dx*dx+dy*dy+dz*dz; if (d<md) { md=d; n=p } } return n }
  broadcastToPlayers(m) { if (this._resimSuppressed) return; if (this._connections) this._connections.broadcast(MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.broadcast(m) }
  sendToPlayer(id, m) { if (this._resimSuppressed) return; if (this._connections) this._connections.send(id, MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.sendToPlayer(id, m) }
  setPlayerPosition(id, p) { if (!vecOK(p, 3)) return; this._physicsIntegration?.setPlayerPosition(id, p); if (this._playerManager) { const pl=this._playerManager.getPlayer(id); if (pl) pl.state.position=[...p] } }
  setPlayerName(id, name) { if (typeof name !== 'string') return false; const pl = this._playerManager?.getPlayer(id); if (!pl) return false; pl.name = name.trim().slice(0, 32) || pl.name; return true }
  setPlayerWeapon(id, name) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.state.weapon = weaponNameToCode(name)
    return true
  }
  setPlayerAppearance(id, appearance = {}) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.appearance = { ...(pl.appearance || {}), ...appearance }
    this.broadcastToPlayers({ type: 'player_appearance', playerId: id, tint: pl.appearance.tint, nameTag: pl.appearance.nameTag })
    return true
  }
  setPlayerModel(id, url) {
    if (typeof url !== 'string' || !url) return false
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.modelUrl = url
    this.broadcastToPlayers({ type: 'player_model', playerId: id, url })
    return true
  }
  setPlayerMovementOverride(id, overrides) { return this._playerManager ? this._playerManager.setMovementOverride(id, overrides) : false }
  attachEntityToPlayer(entityId, playerId, offset = [0, 1, 0]) {
    if (!this.entities.has(entityId)) return false
    this._attachments.set(entityId, { playerId, offset: vecOK(offset, 3) ? [...offset] : [0, 1, 0] })
    return true
  }
  detachEntityFromPlayer(entityId) { return this._attachments.delete(entityId) }
  _tickAttachments() {
    if (this._attachments.size === 0) return
    for (const [entityId, att] of this._attachments) {
      const e = this.entities.get(entityId); if (!e) { this._attachments.delete(entityId); continue }
      const pl = this._playerManager?.getPlayer(att.playerId); const pp = pl?.state?.position
      if (!pp) continue
      const pos = [pp[0] + att.offset[0], pp[1] + att.offset[1], pp[2] + att.offset[2]]
      if (this.setEntityPosition) this.setEntityPosition(entityId, pos, e.rotation)
      else { e.position[0] = pos[0]; e.position[1] = pos[1]; e.position[2] = pos[2] }
    }
  }
  setPlayerLifecycle(id, state, opts = {}) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    if (state !== 'alive' && state !== 'frozen' && state !== 'spectator') return false
    pl.lifecycle = state
    this.broadcastToPlayers({ type: 'player_lifecycle', playerId: id, state, spectateTarget: opts.spectateTarget ?? null })
    return true
  }
  playPlayerAnimation(id, clip, opts = {}) {
    if (typeof clip !== 'string' || !clip) return false
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    this.broadcastToPlayers({ type: 'player_anim', playerId: id, clip, loop: !!opts.loop, fade: opts.fade ?? 0.2 })
    return true
  }
  queueReload(n, d, cb) { this._hotReload.enqueue(n, d, cb) }
  _drainReloadQueue() { this._hotReload.drain() }
  hotReload(n, d) { this._hotReload._execute(n, d) }
  _spatialInsert(entity) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage && !stage.hasEntity(entity.id)) { stage.entityIds.add(entity.id); stage.spatial.insert(entity.id, entity.position); if (entity.bodyType==='static') stage._staticIds.add(entity.id) } }
  _spatialRemove(entityId) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage) { stage.spatial.remove(entityId); stage._staticIds.delete(entityId); stage.entityIds.delete(entityId) } }
  _spatialSync() { if (this._stageLoader) this._stageLoader.syncAllPositions() }
  nearbyEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getNearbyEntities(position, radius) }
  relevantEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getRelevantEntities(position, radius) }
  _log(type, data, meta = {}) { if (this._eventLog) this._eventLog.record(type, data, { ...meta, tick: this.currentTick }) }
  _logAppError(l, e) {
    console.error(`[AppRuntime] ${l}: ${e.message}`)
    this._log('app_error', { label: l, message: e.message, stack: e.stack }, {})
  }
  _safeCall(o, m, a, l) {
    if (!o?.[m]) return Promise.resolve()
    try { const r = o[m](...a); if (r?.catch) return r.catch(e => this._logAppError(l, e)); return Promise.resolve() }
    catch (e) { this._logAppError(l, e); return Promise.reject(e) }
  }

  snapshotGameState(opts = {}) {
    const includeStatic = !!opts.includeStatic
    const entities = new Map()
    for (const [id, e] of this.entities) {
      if (!includeStatic && e.bodyType === 'static') continue
      entities.set(id, {
        position: [...e.position],
        rotation: [...e.rotation],
        scale: [...e.scale],
        velocity: [...(e.velocity || [0, 0, 0])],
        bodyType: e.bodyType,
        custom: e.custom ? JSON.parse(JSON.stringify(e.custom)) : null,
        appState: tagAppState(e._appState)
      })
    }
    const respawnTimers = new Map()
    for (const [id, t] of this._respawnTimer) respawnTimers.set(id, { startTime: t.startTime, lastRespawn: t.lastRespawn })
    const timers = new Map()
    for (const [eid, list] of this._timers) timers.set(eid, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval, fn: t.fn })))
    const interactCooldowns = new Map(this._interactCooldowns)
    return { tick: this.currentTick, entities, respawnTimers, timers, interactCooldowns }
  }

  restoreGameState(snap) {
    for (const [id, s] of snap.entities) {
      const e = this.entities.get(id); if (!e) continue
      e.position[0] = s.position[0]; e.position[1] = s.position[1]; e.position[2] = s.position[2]
      e.rotation[0] = s.rotation[0]; e.rotation[1] = s.rotation[1]; e.rotation[2] = s.rotation[2]; e.rotation[3] = s.rotation[3]
      e.scale[0] = s.scale[0]; e.scale[1] = s.scale[1]; e.scale[2] = s.scale[2]
      e.velocity[0] = s.velocity[0]; e.velocity[1] = s.velocity[1]; e.velocity[2] = s.velocity[2]
      e.bodyType = s.bodyType
      e.custom = s.custom ? JSON.parse(JSON.stringify(s.custom)) : null
      e._appState = untagAppState(s.appState)
      const ctx = this.contexts.get(id)
      if (ctx) ctx._state = e._appState
      this._markDirty(id)
    }
    for (const [id, t] of snap.respawnTimers) this._respawnTimer.set(id, { startTime: t.startTime, lastRespawn: t.lastRespawn })
    for (const [eid, list] of snap.timers) {
      if (!this.entities.has(eid)) continue
      this._timers.set(eid, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval, fn: t.fn })))
    }
    if (snap.interactCooldowns) this._interactCooldowns = new Map(snap.interactCooldowns)
  }

  setResimSuppressed(v) {
    const wasSuppressed = this._resimSuppressed
    this._resimSuppressed = !!v
    if (this._eventLog) { if (this._resimSuppressed) this._eventLog.pause(); else this._eventLog.resume() }
    const suppressionJustEnded = wasSuppressed && !this._resimSuppressed
    if (suppressionJustEnded) { this._flushDeferredPopulationOps(); this._flushDeferredCommitmentOps() }
  }
}
