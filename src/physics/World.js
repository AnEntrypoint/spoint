import { extractMeshFromGLB } from './GLBLoader.js'
import { CharacterManager } from './CharacterManager.js'
import { installVehiclePhysics } from './VehiclePhysics.js'
import { buildConvexShape, buildMeshShape, buildTrimeshShape } from './ShapeBuilder.js'
import { createStaticTileIndex } from './StaticTileIndex.js'
import { createDormantStatics } from './DormantStatics.js'

const LAYER_STATIC = 0, LAYER_DYNAMIC = 1, NUM_LAYERS = 2
const _PARK_POS = [0, -100000, 0]
let joltInstance = null
let liveWorlds = 0
export function livePhysicsWorldCount() { return liveWorlds }
export async function getJolt() {
  if (!joltInstance) {
    if (typeof globalThis.__SPOINT_EDGE_JOLT__ !== 'undefined') {
      joltInstance = await globalThis.__SPOINT_EDGE_JOLT__
      return joltInstance
    }
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    const _bundlerOpaqueJoltSpec = _isNode ? 'jolt-physics/wasm-compat' : ('/node_modules/' + 'jolt-physics/dist/jolt-physics.wasm.js')
    const { default: init } = await import(_bundlerOpaqueJoltSpec)
    joltInstance = await init()
  }
  return joltInstance
}

export class PhysicsWorld {
  constructor(config = {}) {
    this.gravity = config.gravity || [0, -9.81, 0]
    this.joltLimits = config.joltLimits || null
    this.Jolt = null; this.jolt = null; this.physicsSystem = null; this.bodyInterface = null
    this.bodies = new Map(); this.bodyMeta = new Map(); this.bodyIds = new Map()
    this._objFilter = null; this._ovbp = null
    this._shapeCache = new Map(); this._shapeRefs = new Map(); this._convexQueue = Promise.resolve()
    this._shapeBuilds = 0; this._shapeReuses = 0
    this._trimeshCache = new Map(); this._trimeshInflight = new Map()
    this._bodyPool = new Map(); this._bodyShapeKey = new Map()
    this._bodyQueue = []
    this._chartGuard = null; this._dormant = null
    this._constraints = new Map(); this._nextConstraintId = 0
    this._tmpVec3 = null; this._tmpRVec3 = null
    this._peakBodies = 0; this._peakActiveBodies = 0
    this._contactProbe = null; this._contactListener = null; this._contactLimitExceeded = null
    this._bulkOutP = null; this._bulkOutR = null; this._bulkOutLV = null; this._bulkOutAV = null
    this._rcScratch = null; this._vehWheelAxes = null
    this._charMgr = new CharacterManager(this.gravity, config.crouchHalfHeight || 0.45)
  }

  async init() {
    const J = await getJolt(); this.Jolt = J
    const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS)
    objFilter.EnableCollision(LAYER_STATIC, LAYER_DYNAMIC); objFilter.EnableCollision(LAYER_DYNAMIC, LAYER_DYNAMIC)
    const bpI = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, 2)
    bpI.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(0))
    bpI.MapObjectToBroadPhaseLayer(LAYER_DYNAMIC, new J.BroadPhaseLayer(1))
    const ovbp = new J.ObjectVsBroadPhaseLayerFilterTable(bpI, 2, objFilter, NUM_LAYERS)
    const settings = new J.JoltSettings()
    settings.mObjectLayerPairFilter = objFilter; settings.mBroadPhaseLayerInterface = bpI
    settings.mObjectVsBroadPhaseLayerFilter = ovbp
    const lim = this.joltLimits
    const settingsCap = Number.isFinite(settings.mMaxContactConstraints) && settings.mMaxContactConstraints > 0 ? settings.mMaxContactConstraints : null
    const contactCap = lim ? lim.maxContactConstraints : settingsCap
    if (lim) { settings.mMaxBodies = lim.maxBodies; settings.mMaxBodyPairs = lim.maxBodyPairs; settings.mMaxContactConstraints = lim.maxContactConstraints }
    this._objFilter = objFilter; this._ovbp = ovbp
    this.jolt = new J.JoltInterface(settings); J.destroy(settings)
    liveWorlds++
    this.physicsSystem = this.jolt.GetPhysicsSystem(); this.bodyInterface = this.physicsSystem.GetBodyInterface()
    if (contactCap) this._installContactDemandProbe(contactCap)
    this._sampleBodyPeaks()
    this._tmpVec3 = new J.Vec3(0, 0, 0); this._tmpRVec3 = new J.RVec3(0, 0, 0); this._tmpQuat = new J.Quat(0, 0, 0, 1)
    this._bulkOutP = new J.RVec3(0, 0, 0); this._bulkOutR = new J.Quat(0, 0, 0, 1)
    this._bulkOutLV = new J.Vec3(0, 0, 0); this._bulkOutAV = new J.Vec3(0, 0, 0)
    const [gx, gy, gz] = this.gravity
    const gv = new J.Vec3(gx, gy, gz); this.physicsSystem.SetGravity(gv); J.destroy(gv)
    this._heap32 = new Int32Array(J.HEAP8.buffer)
    this._activationListener = new J.BodyActivationListenerJS()
    this._activationListener.OnBodyActivated = (ptr) => { if (this.onBodyActivated) this.onBodyActivated(this._heap32[ptr >> 2]) }
    this._activationListener.OnBodyDeactivated = (ptr) => { if (this.onBodyDeactivated) this.onBodyDeactivated(this._heap32[ptr >> 2]) }
    this.physicsSystem.SetBodyActivationListener(this._activationListener)
    if (typeof this.physicsSystem.GetPhysicsSettings === 'function' && typeof this.physicsSystem.SetPhysicsSettings === 'function') {
      const ps = this.physicsSystem.GetPhysicsSettings()
      ps.mTimeBeforeSleep = 0.25
      ps.mPointVelocitySleepThreshold = 0.05
      this.physicsSystem.SetPhysicsSettings(ps)
    }
    this._charMgr.init(J, this.jolt, this.physicsSystem)
    return this
  }

  setGravity(gravity) {
    this.gravity = gravity
    if (this.physicsSystem) {
      const J = this.Jolt
      const gv = new J.Vec3(gravity[0], gravity[1], gravity[2])
      this.physicsSystem.SetGravity(gv)
      J.destroy(gv)
    }
    this._charMgr.setGravity(gravity)
  }

  _addBody(shape, position, motionType, layer, opts = {}) {
    const J = this.Jolt
    const resident = this.physicsSystem.GetNumBodies()
    const maxBodies = this._configuredMaxBodies()
    if (maxBodies > 0 && resident >= maxBodies) {
      throw new Error(`[physics] body limit reached: ${resident} of maxBodies ${maxBodies} bodies are resident and another was requested, so Jolt hands back an invalid body id that later crashes the wasm heap at teardown. Raise joltLimits.maxBodies above ${resident + 1} or lower the number of bodies this world streams in.`)
    }
    const pos = new J.RVec3(position[0], position[1], position[2])
    const rot = opts.rotation ? new J.Quat(...opts.rotation) : new J.Quat(0, 0, 0, 1)
    const cs = new J.BodyCreationSettings(shape, pos, rot, motionType, layer)
    J.destroy(pos); J.destroy(rot)
    if (opts.mass) { cs.mMassPropertiesOverride.mMass = opts.mass; cs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia }
    if (opts.friction !== undefined) cs.mFriction = opts.friction
    if (opts.restitution !== undefined) cs.mRestitution = opts.restitution
    if (opts.gravityFactor !== undefined) cs.mGravityFactor = opts.gravityFactor
    if (opts.linearDamping !== undefined) cs.mLinearDamping = opts.linearDamping
    if (opts.angularDamping !== undefined) cs.mAngularDamping = opts.angularDamping
    if (opts.linearCast) cs.mMotionQuality = J.EMotionQuality_LinearCast
    const activate = motionType === J.EMotionType_Static ? J.EActivation_DontActivate : J.EActivation_Activate
    const body = this.bodyInterface.CreateBody(cs)
    const bodyID = body.GetID()
    const id = bodyID.GetIndexAndSequenceNumber()
    if (!id) {
      J.destroy(cs)
      throw new Error(`[physics] Jolt refused a body: ${resident} of maxBodies ${maxBodies} bodies are resident and the new body got no slot, so every body past the limit is silently dropped and crashes the wasm heap at teardown. Raise joltLimits.maxBodies above ${resident + 1}.`)
    }
    this.bodyInterface.AddBody(bodyID, activate)
    J.destroy(cs)
    this._createCount = (this._createCount | 0) + 1
    const meta = opts.meta || {}
    if (opts.mass !== undefined) meta.mass = opts.mass
    this.bodies.set(id, body); this.bodyMeta.set(id, meta); this.bodyIds.set(id, bodyID)
    if (opts.shapeKey) { this._bodyShapeKey.set(id, opts.shapeKey); this._shapeRefs.set(opts.shapeKey, (this._shapeRefs.get(opts.shapeKey) | 0) + 1) }
    this._staticTiles?.update(id)
    this._sampleBodyPeaks()
    return id
  }

  _configuredMaxBodies() {
    if (this.joltLimits && Number.isFinite(this.joltLimits.maxBodies)) return this.joltLimits.maxBodies
    const fromJolt = this.physicsSystem?.GetMaxBodies?.()
    return Number.isFinite(fromJolt) ? fromJolt : 0
  }

  _installContactDemandProbe(limit) {
    const J = this.Jolt
    if (!J.ContactListenerJS || !this.physicsSystem.SetContactListener) return
    const probe = { live: 0, peak: 0, limit }
    const listener = new J.ContactListenerJS()
    listener.OnContactValidate = () => true
    listener.OnContactAdded = () => {
      probe.live++
      if (probe.live > probe.peak) probe.peak = probe.live
      if (probe.live > probe.limit && !this._contactLimitExceeded) {
        this._contactLimitExceeded = { live: probe.live, limit: probe.limit, starved: probe.live - probe.limit }
      }
    }
    listener.OnContactPersisted = () => {}
    listener.OnContactRemoved = () => { probe.live-- }
    this.physicsSystem.SetContactListener(listener)
    this._contactListener = listener
    this._contactProbe = probe
  }

  _sampleBodyPeaks() {
    const ps = this.physicsSystem
    if (!ps || !ps.GetNumBodies) return
    const n = ps.GetNumBodies()
    if (n > this._peakBodies) this._peakBodies = n
    const active = ps.GetNumActiveBodies ? ps.GetNumActiveBodies() : 0
    if (active > this._peakActiveBodies) this._peakActiveBodies = active
  }

  physicsStats() {
    const ps = this.physicsSystem
    return {
      bodies: ps?.GetNumBodies?.() ?? 0,
      activeBodies: ps?.GetNumActiveBodies?.() ?? 0,
      maxBodies: this._configuredMaxBodies(),
      peakBodies: this._peakBodies,
      peakActiveBodies: this._peakActiveBodies,
      shapeBuilds: this._shapeBuilds,
      shapeReuses: this._shapeReuses,
      shapesCached: this._shapeCache.size,
      shapeRefs: this._shapeRefs.size,
      contactManifolds: this._contactProbe
        ? { live: this._contactProbe.live, peak: this._contactProbe.peak, limit: this._contactProbe.limit }
        : null,
    }
  }

  physicsStatsLine() {
    const s = this.physicsStats()
    const manifolds = s.contactManifolds ? `, contact manifolds ${s.contactManifolds.peak}/${s.contactManifolds.limit}` : ''
    return `[physics] peak bodies ${s.peakBodies}/${s.maxBodies}, peak active ${s.peakActiveBodies}${manifolds}`
  }

  setChartFrameGuard(guard) { this._chartGuard = guard }

  get dormantStatics() { return this._dormant || (this._dormant = createDormantStatics(this)) }

  _captureCreationFrame(position, rotation) {
    return { epoch: this._chartGuard ? this._chartGuard.epoch() : 0, position: [position[0], position[1], position[2]], rotation: rotation ? [rotation[0], rotation[1], rotation[2], rotation[3]] : null }
  }

  _resolveCreationFrame(born) {
    if (!this._chartGuard || this._chartGuard.epoch() === born.epoch) return born
    return this._chartGuard.reexpress(born)
  }

  enableStaticTiles(tileM) {
    if (!this._staticTiles && this.Jolt) {
      this._staticTiles = createStaticTileIndex(this, tileM)
      for (const id of this.bodies.keys()) this._staticTiles.update(id)
    }
    return this._staticTiles || null
  }

  addStaticBox(halfExtents, position, rotation) {
    const J = this.Jolt
    const hv = new J.Vec3(halfExtents[0], halfExtents[1], halfExtents[2])
    const bs = new J.BoxShape(hv, 0.05, null); J.destroy(hv)
    return this._addBody(bs, position, J.EMotionType_Static, LAYER_STATIC, { rotation, meta: { type: 'static', shape: 'box' } })
  }

  _repositionBody(id, position, rotation, activate = null) {
    const b = this._getBody(id); if (!b) return
    this._tmpRVec3.Set(position[0], position[1], position[2])
    const act = activate === true ? this.Jolt.EActivation_Activate : this.Jolt.EActivation_DontActivate
    if (rotation) {
      this._tmpQuat.Set(rotation[0], rotation[1], rotation[2], rotation[3])
      this.bodyInterface.SetPositionAndRotation(b.GetID(), this._tmpRVec3, this._tmpQuat, act)
    } else {
      this.bodyInterface.SetPosition(b.GetID(), this._tmpRVec3, act)
    }
    if (activate === false && this.bodyInterface.DeactivateBody) this.bodyInterface.DeactivateBody(b.GetID())
    this._staticTiles?.update(id)
  }

  addBody(shapeType, params, position, motionType, opts = {}) {
    const J = this.Jolt; let shape
    const sk = opts.shapeKey || null
    if (sk) {
      const free = this._bodyPool.get(sk)
      while (free && free.length) {
        const id = free.pop()
        if (!this.bodies.has(id)) continue
        if (this.bodyMeta.get(id)?.type !== motionType) { this.removeBody(id, true); continue }
        this._revivePooledBody(id, position, motionType, shapeType, opts)
        return id
      }
      if (free && free.length === 0) this._bodyPool.delete(sk)
    }
    if (shapeType === 'box') {
      const bk = opts.shapeKey || null
      if (bk && this._shapeCache.has(bk)) { shape = this._shapeCache.get(bk); this._shapeReuses++ }
      else { const cr = Math.min(0.05, Math.min(params[0], params[1], params[2]) * 0.1); const bv = new J.Vec3(params[0], params[1], params[2]); shape = new J.BoxShape(bv, cr, null); J.destroy(bv); if (bk) { this._shapeCache.set(bk, shape); this._shapeBuilds++ } }
    }
    else if (shapeType === 'sphere') shape = new J.SphereShape(params)
    else if (shapeType === 'capsule') {
      const ck = opts.shapeKey || null
      if (ck && this._shapeCache.has(ck)) { shape = this._shapeCache.get(ck); this._shapeReuses++ }
      else { shape = new J.CapsuleShape(params[1], params[0]); if (ck) { this._shapeCache.set(ck, shape); this._shapeBuilds++ } }
    }
    else if (shapeType === 'convex') {
      const ck = opts.shapeKey || null
      const reused = !!(ck && this._shapeCache.has(ck))
      const { shape: cvxShape, sr } = buildConvexShape(J, params, this._shapeCache, ck)
      if (ck) { if (reused) this._shapeReuses++; else this._shapeBuilds++ }
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      const id = this._addBody(cvxShape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
      if (sr) J.destroy(sr)
      return id
    }
    else if (shapeType === 'mesh') {
      const mk = opts.shapeKey || null
      const reused = !!(mk && this._shapeCache.has(mk))
      const { shape: meshShape, sr } = buildMeshShape(J, params, this._shapeCache, mk)
      if (mk) { if (reused) this._shapeReuses++; else this._shapeBuilds++ }
      const id = this._addBody(meshShape, position, J.EMotionType_Static, LAYER_STATIC, { ...opts, meta: { type: 'static', shape: shapeType } })
      if (sr) J.destroy(sr)
      return id
    }
    else return null
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    return this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
  }

  _revivePooledBody(id, position, motionType, shapeType, opts = {}) {
    const J = this.Jolt
    const b = this._getBody(id); if (!b) return false
    const isStatic = motionType !== 'dynamic' && motionType !== 'kinematic'
    this._repositionBody(id, position, opts.rotation, isStatic ? false : true)
    this.setBodyVelocity(id, [0, 0, 0])
    this.setBodyAngularVelocity(id, [0, 0, 0])
    if (opts.mass) this.setBodyMass(id, opts.mass)
    if (opts.friction !== undefined) this.setBodyFriction(id, opts.friction)
    if (opts.restitution !== undefined) this.setBodyRestitution(id, opts.restitution)
    if (opts.gravityFactor !== undefined) this.setBodyGravityFactor(id, opts.gravityFactor)
    if (opts.linearDamping !== undefined || opts.angularDamping !== undefined) this._setBodyDamping(id, opts)
    if (this.bodyInterface.SetMotionQuality) {
      this.bodyInterface.SetMotionQuality(b.GetID(), opts.linearCast ? J.EMotionQuality_LinearCast : J.EMotionQuality_Discrete)
    }
    const carriedMass = opts.mass ?? this.bodyMeta.get(id)?.mass
    this.bodyMeta.set(id, carriedMass === undefined ? { type: motionType, shape: shapeType } : { type: motionType, shape: shapeType, mass: carriedMass })
    return true
  }

  _setBodyDamping(id, opts) {
    const b = this._getBody(id); if (!b || !b.GetMotionProperties) return false
    const mp = b.GetMotionProperties()
    if (!mp) return false
    if (opts.linearDamping !== undefined && typeof mp.SetLinearDamping === 'function') mp.SetLinearDamping(opts.linearDamping)
    if (opts.angularDamping !== undefined && typeof mp.SetAngularDamping === 'function') mp.SetAngularDamping(opts.angularDamping)
    return true
  }

  preallocatePool(shapeType, params, shapeKey, count) {
    if (!this.bodyInterface || !shapeKey || !(count > 0)) return 0
    let free = this._bodyPool.get(shapeKey); if (!free) this._bodyPool.set(shapeKey, free = [])
    const need = count - free.length
    if (need <= 0) return 0
    const ids = []
    for (let i = 0; i < need; i++) {
      const id = this.addBody(shapeType, params, _PARK_POS, 'static', { shapeKey })
      if (id == null) break
      ids.push(id)
    }
    for (const id of ids) { this._repositionBody(id, _PARK_POS, null); free.push(id) }
    return ids.length
  }

  addConvexBodyAsync(params, position, motionType, opts = {}) {
    const J = this.Jolt, cacheKey = opts.shapeKey || null
    const born = this._captureCreationFrame(position, opts.rotation)
    if (cacheKey && this._shapeCache.has(cacheKey)) {
      this._shapeReuses++
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return Promise.resolve(this._addBody(this._shapeCache.get(cacheKey), position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } }))
    }
    const result = this._convexQueue.then(() => {
      const { shape, sr } = buildConvexShape(J, params, this._shapeCache, cacheKey)
      if (cacheKey && this._shapeCache.has(cacheKey)) this._shapeBuilds++
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      const placed = this._resolveCreationFrame(born)
      const id = this._addBody(shape, placed.position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, ...(placed.rotation ? { rotation: placed.rotation } : {}), meta: { type: motionType, shape: 'convex' } })
      if (sr) J.destroy(sr)
      return id
    })
    this._convexQueue = result.then(() => {}, () => {}); return result
  }

  async addStaticTrimeshAsync(glbPath, meshIndex = 0, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0, 1]) {
    if (!glbPath) throw new Error('addStaticTrimeshAsync: no glbPath (resolveAssetPath rejected or returned an empty path)')
    const J = this.Jolt
    const born = this._captureCreationFrame(position, rotation)
    const key = `${glbPath}|${scale[0]},${scale[1]},${scale[2]}`
    let shape = this._trimeshCache.get(key)
    let srToDestroyAfterFirstUse = null
    if (!shape) {
      let inflight = this._trimeshInflight.get(key)
      if (!inflight) {
        inflight = buildTrimeshShape(J, glbPath, scale).then(built => {
          this._trimeshCache.set(key, built.shape)
          this._trimeshInflight.delete(key)
          return built
        }, err => { this._trimeshInflight.delete(key); throw err })
        this._trimeshInflight.set(key, inflight)
      }
      const built = await inflight
      shape = built.shape
      if (built.sr) { srToDestroyAfterFirstUse = built.sr; built.sr = null }
    }
    const placed = this._resolveCreationFrame(born)
    const id = this._addBody(shape, placed.position, J.EMotionType_Static, LAYER_STATIC, { rotation: placed.rotation || rotation, meta: { type: 'static', shape: 'trimesh', shapeKey: key } })
    if (srToDestroyAfterFirstUse) J.destroy(srToDestroyAfterFirstUse)
    return id
  }

  addHeightField(samples, sampleCount, scale, position) {
    const J = this.Jolt
    const settings = new J.HeightFieldShapeSettings()
    const offset = new J.Vec3(0, 0, 0); settings.set_mOffset(offset); J.destroy(offset)
    const sv = new J.Vec3(scale[0], scale[1], scale[2]); settings.set_mScale(sv); J.destroy(sv)
    settings.set_mSampleCount(sampleCount)
    if (typeof settings.set_mBlockSize === 'function') settings.set_mBlockSize(2)
    const heights = settings.get_mHeightSamples()
    heights.resize(samples.length)
    let bulkOk = false
    if (typeof heights.data === 'function' && typeof J.getPointer === 'function' && J.HEAPF32) {
      const ref = heights.data()
      const ptr = J.getPointer(ref)
      if (ptr) {
        const view = samples instanceof Float32Array ? samples : Float32Array.from(samples)
        J.HEAPF32.set(view, ptr >> 2)
        bulkOk = true
      }
    }
    if (!bulkOk) {
      heights.clear(); heights.reserve(samples.length)
      for (let i = 0; i < samples.length; i++) heights.push_back(samples[i])
    }
    const sr = settings.Create()
    if (!sr.IsValid()) { console.error('[heightfield] shape invalid:', sr.GetError().c_str()); J.destroy(settings); J.destroy(sr); return null }
    const shape = sr.Get()
    const id = this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'heightfield' } })
    J.destroy(settings); J.destroy(sr)
    return id
  }

  addStaticTrimeshFromData(entityId,v,ix,pos,rot=[0,0,0,1]){const J=this.Jolt,tc=ix.length/3,tl=new J.TriangleList(),f3=new J.Float3(0,0,0);tl.resize(tc);for(let t=0;t<tc;t++){const tri=tl.at(t);for(let k=0;k<3;k++){const i=ix[t*3+k];f3.x=v[i*3];f3.y=v[i*3+1];f3.z=v[i*3+2];tri.set_mV(k,f3)}}const ms=new J.MeshShapeSettings(tl),sr=ms.Create();if(!sr.IsValid()){console.error('[trimesh] shape invalid for',entityId,sr.GetError().c_str());J.destroy(f3);J.destroy(tl);J.destroy(ms);J.destroy(sr);return null}const shape=sr.Get();J.destroy(f3);J.destroy(tl);const id=this._addBody(shape,pos,J.EMotionType_Static,LAYER_STATIC,{rotation:rot,meta:{type:'static',shape:'trimesh'}});J.destroy(ms);J.destroy(sr);console.log('[trimesh] body created for',entityId,'id='+id,'tris='+tc);return id}

  addPlayerCharacter(radius, halfHeight, position, mass) { return this._charMgr.addCharacter(radius, halfHeight, position, mass) }
  setCharacterCrouch(id, v) { this._charMgr.setCrouch(id, v) }
  updateCharacter(id, dt) { this._charMgr.update(id, dt) }
  getCharacterPosition(id) { return this._charMgr.getPosition(id) }
  readCharacterPosition(id, out) { this._charMgr.readPosition(id, out) }
  getCharacterVelocity(id) { return this._charMgr.getVelocity(id) }
  readCharacterVelocity(id, out) { this._charMgr.readVelocity(id, out) }
  setCharacterVelocity(id, v) { this._charMgr.setVelocity(id, v) }
  setCharacterPosition(id, p) { this._charMgr.setPosition(id, p) }
  getCharacterGroundState(id) { return this._charMgr.getGroundState(id) }
  readCharacterGroundNormal(id, out) { return this._charMgr.readGroundNormal(id, out) }
  readCharacterWallNormals(id, out) { return this._charMgr.readWallNormals(id, out) }
  removeCharacter(id) { this._charMgr.removeCharacter(id) }
  get characters() { return this._charMgr.characters }
  wasmHeapBytes() {
    const J = this.Jolt
    return { total: J._emscripten_bind_JoltInterface_sGetTotalMemory_0(), free: J._emscripten_bind_JoltInterface_sGetFreeMemory_0(), worlds: liveWorlds }
  }
  get liveWorldCount() { return liveWorlds }
  createStateRecorder() { return new this.Jolt.StateRecorderImpl() }

  saveExactState(recorder) {
    recorder.Clear()
    this.physicsSystem.SaveState(recorder)
    for (const ch of this._charMgr.characters.values()) ch.SaveState(recorder)
    return recorder
  }

  restoreExactState(recorder) {
    recorder.Rewind()
    if (!this.physicsSystem.RestoreState(recorder)) throw new Error('[PhysicsWorld] Jolt RestoreState failed: recorder does not match the current body set')
    for (const ch of this._charMgr.characters.values()) ch.RestoreState(recorder)
    this._charMgr.refreshGroundCaches()
  }

  destroyStateRecorder(recorder) { if (recorder && this.Jolt) this.Jolt.destroy(recorder) }

  snapshotCharacters() { return this._charMgr.snapshotAll() }
  restoreCharacters(snap) { this._charMgr.restoreAll(snap) }

  _getBody(id) { return this.bodies.get(id) }
  isBodyActive(id) { const b = this._getBody(id); return b ? b.IsActive() : false }

  syncDynamicBody(bodyId, entity) {
    const b = this._getBody(bodyId); if (!b || !b.IsActive()) return false
    const id = this.bodyIds.get(bodyId), bi = this.bodyInterface
    bi.GetPositionAndRotation(id, this._bulkOutP, this._bulkOutR)
    bi.GetLinearAndAngularVelocity(id, this._bulkOutLV, this._bulkOutAV)
    entity.position[0] = this._bulkOutP.GetX(); entity.position[1] = this._bulkOutP.GetY(); entity.position[2] = this._bulkOutP.GetZ()
    entity.rotation[0] = this._bulkOutR.GetX(); entity.rotation[1] = this._bulkOutR.GetY(); entity.rotation[2] = this._bulkOutR.GetZ(); entity.rotation[3] = this._bulkOutR.GetW()
    entity.velocity[0] = this._bulkOutLV.GetX(); entity.velocity[1] = this._bulkOutLV.GetY(); entity.velocity[2] = this._bulkOutLV.GetZ()
    return true
  }

  snapshotBodies() {
    const out = new Map()
    const bi = this.bodyInterface
    for (const [id, meta] of this.bodyMeta) {
      if (meta && meta.type === 'static') continue
      const jid = this.bodyIds.get(id); if (!jid) continue
      bi.GetPositionAndRotation(jid, this._bulkOutP, this._bulkOutR)
      bi.GetLinearAndAngularVelocity(jid, this._bulkOutLV, this._bulkOutAV)
      out.set(id, {
        position: [this._bulkOutP.GetX(), this._bulkOutP.GetY(), this._bulkOutP.GetZ()],
        rotation: [this._bulkOutR.GetX(), this._bulkOutR.GetY(), this._bulkOutR.GetZ(), this._bulkOutR.GetW()],
        velocity: [this._bulkOutLV.GetX(), this._bulkOutLV.GetY(), this._bulkOutLV.GetZ()],
        angularVelocity: [this._bulkOutAV.GetX(), this._bulkOutAV.GetY(), this._bulkOutAV.GetZ()],
      })
    }
    return out
  }

  restoreBodies(snap) {
    const bi = this.bodyInterface, J = this.Jolt
    const entries = snap instanceof Map ? snap.entries() : Object.entries(snap)
    for (const [idKey, s] of entries) {
      const id = typeof idKey === 'number' ? idKey : Number(idKey)
      const jid = this.bodyIds.get(id); if (!jid) continue
      this._bulkOutP.Set(s.position[0], s.position[1], s.position[2])
      this._bulkOutR.Set(s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3])
      bi.SetPositionAndRotation(jid, this._bulkOutP, this._bulkOutR, J.EActivation_Activate)
      this._bulkOutLV.Set(s.velocity[0], s.velocity[1], s.velocity[2])
      this._bulkOutAV.Set(s.angularVelocity[0], s.angularVelocity[1], s.angularVelocity[2])
      bi.SetLinearAndAngularVelocity(jid, this._bulkOutLV, this._bulkOutAV)
    }
  }

  getBodyPosition(id) { const b = this._getBody(id); if (!b) return [0,0,0]; this.bodyInterface.GetPositionAndRotation(b.GetID(), this._bulkOutP, this._bulkOutR); return [this._bulkOutP.GetX(),this._bulkOutP.GetY(),this._bulkOutP.GetZ()] }
  getBodyRotation(id) { const b = this._getBody(id); if (!b) return [0,0,0,1]; this.bodyInterface.GetPositionAndRotation(b.GetID(), this._bulkOutP, this._bulkOutR); return [this._bulkOutR.GetX(),this._bulkOutR.GetY(),this._bulkOutR.GetZ(),this._bulkOutR.GetW()] }
  getBodyVelocity(id) { const b = this._getBody(id); if (!b) return [0,0,0]; const v = this.bodyInterface.GetLinearVelocity(b.GetID()); const r=[v.GetX(),v.GetY(),v.GetZ()]; this.Jolt.destroy(v); return r }
  getBodyAngularVelocity(id) { const b = this._getBody(id); if (!b || !this.bodyInterface.GetAngularVelocity) return [0,0,0]; const v = this.bodyInterface.GetAngularVelocity(b.GetID()); return [v.GetX(),v.GetY(),v.GetZ()] }
  setBodyFriction(id, f) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetFriction) return false; this.bodyInterface.SetFriction(b.GetID(), f); return true }
  setBodyRestitution(id, r) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetRestitution) return false; this.bodyInterface.SetRestitution(b.GetID(), r); return true }
  setBodyPosition(id, p) { const b = this._getBody(id); if (!b) return; this._tmpRVec3.Set(p[0],p[1],p[2]); this.bodyInterface.SetPosition(b.GetID(), this._tmpRVec3, this.Jolt.EActivation_Activate); this._staticTiles?.update(id) }
  setBodyTransform(id, position, rotation) { this._repositionBody(id, position, rotation, null) }
  setBodyMotionType(id, motionType, opts = {}) {
    const b = this._getBody(id); if (!b || !this.bodyInterface.SetMotionType) return false
    const J = this.Jolt
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    const gid = b.GetID()
    const previousMt = b.GetMotionType()
    const simulates = mt !== J.EMotionType_Static
    this.bodyInterface.SetMotionType(gid, mt, simulates ? J.EActivation_Activate : J.EActivation_DontActivate)
    if (simulates) this.bodyInterface.ActivateBody(gid)
    if (!simulates || b.IsActive()) {
      this._staticTiles?.update(id)
      const meta = this.bodyMeta.get(id)
      if (meta) meta.type = motionType
      return id
    }
    this.bodyInterface.SetMotionType(gid, previousMt, J.EActivation_DontActivate)
    this._staticTiles?.update(id)
    const recreated = this.recreateBodyWithMotionType(id, mt, motionType, opts)
    return recreated === null ? false : recreated
  }

  recreateBodyWithMotionType(id, joltMotionType, motionTypeName, opts = {}) {
    const b = this._getBody(id)
    if (!b || !this._bodyCanBeRecreated(id, joltMotionType)) return null
    const J = this.Jolt
    const shape = b.GetShape()
    if (!shape) return null
    const gid = b.GetID()
    const meta = this.bodyMeta.get(id) || {}
    const mass = opts.mass ?? meta.mass
    const createOpts = {
      rotation: this.getBodyRotation(id),
      meta: { ...meta, type: motionTypeName },
      friction: b.GetFriction(),
      restitution: b.GetRestitution(),
      linearCast: this.bodyInterface.GetMotionQuality?.(gid) === J.EMotionQuality_LinearCast,
      gravityFactor: this.bodyInterface.GetGravityFactor?.(gid),
    }
    const shapeKey = this._bodyShapeKey.get(id)
    if (shapeKey) createOpts.shapeKey = shapeKey
    if (mass !== undefined) createOpts.mass = mass
    if (opts.linearDamping !== undefined) createOpts.linearDamping = opts.linearDamping
    if (opts.angularDamping !== undefined) createOpts.angularDamping = opts.angularDamping
    let nextId = null
    try {
      nextId = this._addBody(shape, this.getBodyPosition(id), joltMotionType, joltMotionType === J.EMotionType_Static ? LAYER_STATIC : LAYER_DYNAMIC, createOpts)
    } catch (e) {
      console.warn(`[physics] body ${id} could not be recreated as ${motionTypeName}: ${e?.message || e}`)
      return null
    }
    const created = this._getBody(nextId)
    const simulates = joltMotionType !== J.EMotionType_Static
    if (!created || (simulates && !created.IsActive())) {
      if (created) this.removeBody(nextId, true)
      return null
    }
    if (!b.IsStatic()) {
      const lv = this.getBodyVelocity(id), av = this.getBodyAngularVelocity(id)
      if (lv[0] !== 0 || lv[1] !== 0 || lv[2] !== 0) this.setBodyVelocity(nextId, lv)
      if (av[0] !== 0 || av[1] !== 0 || av[2] !== 0) this.setBodyAngularVelocity(nextId, av)
    }
    this.removeBody(id, true)
    this._rebindRecreatedBodyId(id, nextId)
    return nextId
  }

  _bodyCanBeRecreated(id, joltMotionType) {
    const J = this.Jolt
    for (const entry of this._constraints.values()) if (entry.bodyA === id || entry.bodyB === id) return false
    if (this._vehicles) for (const v of this._vehicles.values()) if (v.chassisBodyId === id) return false
    if (joltMotionType !== J.EMotionType_Static) {
      const shape = this.bodyMeta.get(id)?.shape
      if (shape === 'trimesh' || shape === 'mesh' || shape === 'heightfield') return false
    }
    return true
  }

  _rebindRecreatedBodyId(oldId, newId) {
    if (oldId === newId) return
    if (this._trunkColliderIds?.delete(oldId)) this._trunkColliderIds.add(newId)
    if (this._rockColliderIds?.delete(oldId)) this._rockColliderIds.add(newId)
    if (this._terrainBodyId === oldId) this._terrainBodyId = newId
  }
  deactivateBody(id) {
    const b = this._getBody(id); if (!b || !this.bodyInterface.DeactivateBody) return false
    this.bodyInterface.DeactivateBody(b.GetID())
    return true
  }
  setBodyVelocity(id, v) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(v[0],v[1],v[2]); this.bodyInterface.SetLinearVelocity(b.GetID(), this._tmpVec3) }
  setBodyAngularVelocity(id, v) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetAngularVelocity) return false; this._tmpVec3.Set(v[0],v[1],v[2]); this.bodyInterface.SetAngularVelocity(b.GetID(), this._tmpVec3); return true }
  addForce(id, f) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(f[0],f[1],f[2]); this.bodyInterface.AddForce(b.GetID(), this._tmpVec3) }
  addImpulse(id, im, worldPoint) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(im[0],im[1],im[2]); if (worldPoint) { this._tmpRVec3.Set(worldPoint[0],worldPoint[1],worldPoint[2]); this.bodyInterface.AddImpulse(b.GetID(), this._tmpVec3, this._tmpRVec3) } else this.bodyInterface.AddImpulse(b.GetID(), this._tmpVec3) }
  setBodyGravityFactor(id, f) { const b = this._getBody(id); if (!b || typeof f !== 'number' || !Number.isFinite(f)) return; this.bodyInterface.SetGravityFactor(b.GetID(), f) }
  setBodyMass(id, mass) {
    const b = this._getBody(id)
    if (!b || !Number.isFinite(mass) || mass <= 0 || !b.GetMotionProperties) return false
    if (b.IsStatic && b.IsStatic()) return false
    const mp = b.GetMotionProperties()
    if (!mp || typeof mp.ScaleToMass !== 'function') return false
    mp.ScaleToMass(mass)
    return true
  }

  addConstraint(bodyIdA, bodyIdB, opts = {}) {
    if (!this.physicsSystem) return null
    const ba = this._getBody(bodyIdA), bb = this._getBody(bodyIdB)
    if (!ba || !bb) return null
    const J = this.Jolt, type = opts.type || 'fixed'
    const aA = opts.anchorA || this.getBodyPosition(bodyIdA)
    const aB = opts.anchorB || this.getBodyPosition(bodyIdB)
    const p = this._tmpRVec3, v = this._tmpVec3
    let settings = null
    try {
      settings = type === 'point' ? new J.PointConstraintSettings()
        : type === 'distance' ? new J.DistanceConstraintSettings()
        : type === 'hinge' ? new J.HingeConstraintSettings()
        : new J.FixedConstraintSettings()
      settings.mSpace = J.EConstraintSpace_WorldSpace
      p.Set(aA[0], aA[1], aA[2]); settings.mPoint1 = p
      p.Set(aB[0], aB[1], aB[2]); settings.mPoint2 = p
      if (type === 'distance') {
        if (opts.minDistance != null) settings.mMinDistance = opts.minDistance
        if (opts.maxDistance != null) settings.mMaxDistance = opts.maxDistance
      } else if (type === 'hinge') {
        const ax = opts.axis || [0, 1, 0]
        v.Set(ax[0], ax[1], ax[2]); settings.mHingeAxis1 = v; settings.mHingeAxis2 = v
        v.Set(1, 0, 0); settings.mNormalAxis1 = v; settings.mNormalAxis2 = v
      }
      const c = settings.Create(ba, bb)
      this.physicsSystem.AddConstraint(c)
      const cid = ++this._nextConstraintId
      this._constraints.set(cid, { c, bodyA: bodyIdA, bodyB: bodyIdB })
      return cid
    } catch (e) { console.error('[physics] addConstraint failed:', e?.message || e); return null }
    finally { if (settings) J.destroy(settings) }
  }
  removeConstraint(constraintId) {
    const entry = this._constraints.get(constraintId)
    if (!entry || !this.physicsSystem) return false
    this.physicsSystem.RemoveConstraint(entry.c)
    this._constraints.delete(constraintId)
    return true
  }
  _removeConstraintsOfBody(bodyId) {
    for (const [cid, entry] of this._constraints) if (entry.bodyA === bodyId || entry.bodyB === bodyId) this.removeConstraint(cid)
  }


  enqueueAdd(shapeType, params, position, motionType, opts, onAdded) {
    this._bodyQueue.push({ op: 'add', shapeType, params, position, motionType, opts: opts || {}, onAdded })
  }

  enqueueRemove(id, force = false) {
    this._bodyQueue.push({ op: 'remove', id, force })
  }

  drainBodyQueue() {
    const q = this._bodyQueue
    if (q.length === 0) return 0
    this._bodyQueue = []
    let applied = 0
    for (let i = 0; i < q.length; i++) {
      const r = q[i]; if (r.op !== 'add') continue
      try { const id = this.addBody(r.shapeType, r.params, r.position, r.motionType, r.opts); if (r.onAdded) r.onAdded(id); applied++ }
      catch (e) { console.error('[physics] queued add error:', e?.message || e); if (r.onAdded) try { r.onAdded(null) } catch (_) {} }
    }
    for (let i = 0; i < q.length; i++) {
      const r = q[i]; if (r.op !== 'remove') continue
      try { this.removeBody(r.id, r.force); applied++ }
      catch (e) { console.error('[physics] queued remove error:', e?.message || e) }
    }
    return applied
  }

  get bodyQueueLength() { return this._bodyQueue.length }

  setTrunkColliderIds(set) { return (this._trunkColliderIds = set) }
  getTrunkColliderIds() { return this._trunkColliderIds }
  setRockColliderIds(set) { return (this._rockColliderIds = set) }
  getRockColliderIds() { return this._rockColliderIds }
  setTerrainBodyId(id) { return (this._terrainBodyId = id) }
  getTerrainBodyId() { return this._terrainBodyId ?? null }
  setTerrainHeightSource(fn, frame, offsetY = 0) { this._terrainHeightAt = fn; this._planetFrame = frame; this._terrainOffsetY = offsetY }
  getTerrainHeightFn() { return this._terrainHeightAt }
  getTerrainOffsetY() { return this._terrainOffsetY || 0 }
  terrainHeightAt(x, z) { return typeof this._terrainHeightAt === 'function' ? this._terrainHeightAt(x, z) + (this._terrainOffsetY || 0) : null }

  step(dt, collisionSteps = 2) {
    if (!this.jolt) return
    this.jolt.Step(dt, collisionSteps)
    this._sampleBodyPeaks()
    const over = this._contactLimitExceeded
    if (over) {
      throw new Error(`[physics] contact constraint limit exceeded: ${over.live} contact manifolds are live but maxContactConstraints is ${over.limit}, so ${over.starved} manifold(s) get no constraint and the bodies they held fall through. Raise joltLimits.maxContactConstraints above ${this._contactProbe.peak}.`)
    }
  }

  removeBody(id, force = false) {
    const b = this._getBody(id); if (!b) return
    this._removeConstraintsOfBody(id)
    const sk = !force && this._bodyShapeKey.get(id)
    if (sk) {
      const isDynamic = this.bodyMeta.get(id)?.type === 'dynamic'
      this._repositionBody(id, _PARK_POS, null, isDynamic ? false : null)
      if (isDynamic) { this.setBodyVelocity(id, [0, 0, 0]); this.setBodyAngularVelocity(id, [0, 0, 0]) }
      let free = this._bodyPool.get(sk); if (!free) this._bodyPool.set(sk, free = [])
      free.push(id)
      return
    }
    if (this._dormant && this._dormant.has(id)) this._dormant.forget(id)
    else this.bodyInterface.RemoveBody(b.GetID())
    const destroyedShapeKey = this._bodyShapeKey.get(id)
    if (destroyedShapeKey) {
      const pooled = this._bodyPool.get(destroyedShapeKey)
      if (pooled) {
        const at = pooled.indexOf(id)
        if (at >= 0) pooled.splice(at, 1)
        if (pooled.length === 0) this._bodyPool.delete(destroyedShapeKey)
      }
      const refs = (this._shapeRefs.get(destroyedShapeKey) | 0) - 1
      if (refs > 0) this._shapeRefs.set(destroyedShapeKey, refs)
      else { this._shapeRefs.delete(destroyedShapeKey); this._shapeCache.delete(destroyedShapeKey) }
    }
    this.bodyInterface.DestroyBody(b.GetID())
    this.bodies.delete(id); this.bodyMeta.delete(id); this.bodyIds.delete(id); this._bodyShapeKey.delete(id)
    this._staticTiles?.update(id)
  }

  asyncQuery(queries) {
    if (!Array.isArray(queries) || queries.length === 0) return Promise.resolve([])
    return new Promise(resolve => {
      if (!this._asyncQueryQueue) this._asyncQueryQueue = []
      if (!this._asyncQueryResolves) this._asyncQueryResolves = []
      const idx = this._asyncQueryQueue.length
      this._asyncQueryQueue.push(queries)
      this._asyncQueryResolves.push(resolve)
      if (!this._asyncQueryScheduled) {
        this._asyncQueryScheduled = true
        Promise.resolve().then(() => {
          this._asyncQueryScheduled = false
          const batch = this._asyncQueryQueue.splice(0)
          const resolvers = this._asyncQueryResolves.splice(0)
          const results = batch.map(qs => qs.map(q => {
            try {
              return this.raycast(q.origin, q.direction, q.maxDistance || 1000, q.excludeBodyId)
            } catch (e) {
              return { hit: false, distance: q.maxDistance || 1000, body: null, position: null, error: e.message }
            }
          }))
          for (let i = 0; i < resolvers.length; i++) resolvers[i](results[i])
        })
      }
    })
  }

  _raycastScratch() {
    const J = this.Jolt
    let s = this._rcScratch
    if (!s) s = this._rcScratch = {
      origin: new J.RVec3(0, 0, 0), dir: new J.Vec3(0, 0, 0), ray: new J.RRayCast(),
      rs: new J.RayCastSettings(), col: new J.CastRayClosestHitCollisionCollector(),
      bp: new J.DefaultBroadPhaseLayerFilter(this.jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_DYNAMIC),
      ol: new J.DefaultObjectLayerFilter(this.jolt.GetObjectLayerPairFilter(), LAYER_DYNAMIC),
      bf: new J.BodyFilter(), sf: new J.ShapeFilter(),
    }
    return s
  }

  raycast(origin, direction, maxDistance = 1000, excludeBodyId = null) {
    if (!this.physicsSystem) return { hit: false, distance: maxDistance, body: null, position: null }
    const J = this.Jolt
    const len = Math.hypot(direction[0], direction[1], direction[2])
    const dirX = len > 0 ? direction[0]/len : direction[0]
    const dirY = len > 0 ? direction[1]/len : direction[1]
    const dirZ = len > 0 ? direction[2]/len : direction[2]
    const s = this._raycastScratch()
    s.origin.Set(origin[0], origin[1], origin[2])
    s.dir.Set(dirX*maxDistance, dirY*maxDistance, dirZ*maxDistance)
    s.ray.set_mOrigin(s.origin); s.ray.set_mDirection(s.dir)
    s.col.Reset()
    const excludedBody = excludeBodyId != null ? this._getBody(excludeBodyId) : null
    const bf = excludedBody ? new J.IgnoreSingleBodyFilter(excludedBody.GetID()) : s.bf
    const col = s.col
    this.physicsSystem.GetNarrowPhaseQuery().CastRay(s.ray, s.rs, col, s.bp, s.ol, bf, s.sf)
    let result
    if (col.HadHit()) {
      const hit = col.get_mHit()
      const dist = hit.mFraction * maxDistance
      const position = [origin[0]+dirX*dist, origin[1]+dirY*dist, origin[2]+dirZ*dist]
      let bodyId = null, normal = null
      try {
        const bid = hit.mBodyID
        if (bid) bodyId = bid.GetIndexAndSequenceNumber()
        const b = bodyId != null ? this._getBody(bodyId) : null
        if (b) {
          this._tmpRVec3.Set(position[0], position[1], position[2])
          const n = b.GetWorldSpaceSurfaceNormal(hit.mSubShapeID2, this._tmpRVec3)
          normal = [n.GetX(), n.GetY(), n.GetZ()]
          J.destroy(n)
        }
      } catch (_) { }
      result = { hit: true, distance: dist, body: null, bodyId, normal, position }
    } else result = { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null }
    if (excludedBody) J.destroy(bf)
    if (this._dormant && this._dormant.pendingCount > 0) {
      const reach = this._dormant.firstReach(origin, [dirX, dirY, dirZ], maxDistance)
      if (reach < (result.hit ? result.distance : maxDistance)) return { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null, unavailable: 'static-colliders-migrating' }
    }
    return result
  }

  destroy() {
    if (!this.Jolt) return
    if (this._peakBodies > 0) console.log(this.physicsStatsLine())
    if (this._dormant) { this._dormant.destroy(); this._dormant = null }
    if (this._rcScratch) {
      const s = this._rcScratch, J = this.Jolt
      J.destroy(s.ray); J.destroy(s.origin); J.destroy(s.dir); J.destroy(s.rs)
      J.destroy(s.col); J.destroy(s.bp); J.destroy(s.ol); J.destroy(s.bf); J.destroy(s.sf)
      this._rcScratch = null
    }
    if (this._vehWheelAxes) { this.Jolt.destroy(this._vehWheelAxes.right); this.Jolt.destroy(this._vehWheelAxes.up); this._vehWheelAxes = null }
    this._charMgr.destroy()
    if (this._staticTiles) { this._staticTiles.destroy(); this._staticTiles = null }
    if (this._vehicles) for (const [id] of this._vehicles) this.removeVehicle(id)
    for (const [id] of this.bodies) this.removeBody(id, true)
    this._bodyPool.clear(); this._bodyShapeKey.clear()
    this._trimeshCache.clear(); this._trimeshInflight.clear()
    const J = this.Jolt
    if (this._tmpVec3) { J.destroy(this._tmpVec3); this._tmpVec3 = null }
    if (this._tmpRVec3) { J.destroy(this._tmpRVec3); this._tmpRVec3 = null }
    if (this._tmpQuat) { J.destroy(this._tmpQuat); this._tmpQuat = null }
    if (this._bulkOutP) { J.destroy(this._bulkOutP); this._bulkOutP = null }
    if (this._bulkOutR) { J.destroy(this._bulkOutR); this._bulkOutR = null }
    if (this._bulkOutLV) { J.destroy(this._bulkOutLV); this._bulkOutLV = null }
    if (this._bulkOutAV) { J.destroy(this._bulkOutAV); this._bulkOutAV = null }
    if (this._contactListener) { J.destroy(this._contactListener); this._contactListener = null }
    if (this.jolt) { J.destroy(this.jolt); this.jolt = null; liveWorlds = Math.max(0, liveWorlds - 1) }
    this.physicsSystem = null; this.bodyInterface = null
  }
}

installVehiclePhysics(PhysicsWorld)
