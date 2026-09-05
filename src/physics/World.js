import { extractMeshFromGLB, extractMeshFromGLBAsync } from './GLBLoader.js'
import { CharacterManager } from './CharacterManager.js'
import { installVehiclePhysics } from './VehiclePhysics.js'
import { buildConvexShape, buildTrimeshShape } from './ShapeBuilder.js'

const LAYER_STATIC = 0, LAYER_DYNAMIC = 1, NUM_LAYERS = 2
const _PARK_POS = [0, -100000, 0]
let joltInstance = null
export async function getJolt() {
  if (!joltInstance) {
    // Edge-target seam (edge-cf-durable-object-transport-adapter-real-websocketpair): a Cloudflare
    // Durable Object has no node:fs (so the Node branch's `jolt-physics/wasm-compat` import is right
    // for AppRuntime.js's own isNode checks generally, but jolt-physics's OWN bundled Emscripten glue
    // independently re-checks `process.versions.node` and crashes on `createRequire(import.meta.url)`
    // when `nodejs_compat` is enabled -- live-reproduced via a real `wrangler dev` workerd instance)
    // and no static URL to fetch the browser branch's `/node_modules/...` path from either (workerd has
    // no filesystem route to serve that string, live-reproduced as a bundler-time unresolvable dynamic
    // import). Real fix (proven live against workerd): the edge worker imports jolt-physics/wasm's
    // native `.wasm` module binding at BUILD TIME (the only embedder-allowed way to get compiled Wasm
    // into a Worker -- ahead-of-time compiled, not runtime `WebAssembly.instantiate()` from raw bytes,
    // which workerd's embedder policy blocks outright) and instantiates it itself via Emscripten's
    // standard `Module.instantiateWasm` hook (checked before either of Jolt's own broken internal
    // branches run), then stashes the resulting live Jolt module here before any PhysicsWorld boots --
    // see edge/cf-do/spoint-do.js's initJoltForEdge(). This is a pure opt-in: unset in every existing
    // Node/browser boot path, so both of those branches are byte-unchanged from before this fix.
    if (typeof globalThis.__SPOINT_EDGE_JOLT__ !== 'undefined') {
      joltInstance = await globalThis.__SPOINT_EDGE_JOLT__
      return joltInstance
    }
    const _isNode = typeof process !== 'undefined' && process.versions?.node
    // Specifier built at runtime (not a literal passed straight to import()) so an edge/DO bundler
    // build (esbuild via wrangler) never tries to statically resolve the browser-only absolute
    // '/node_modules/...' path -- it isn't reachable there anyway (see the __SPOINT_EDGE_JOLT__
    // early-return above), but a bundler's static import-graph walk doesn't know that; it fails the
    // WHOLE build on an unresolvable literal specifier regardless of runtime reachability. Zero
    // behavior change for Node/browser: same two real specifiers, same ternary choice, just built as
    // a string first (live-confirmed via a real wrangler --dry-run build that this defeats esbuild's
    // static resolution while a literal ternary-in-import() does not).
    const _joltSpec = _isNode ? 'jolt-physics/wasm-compat' : ('/node_modules/' + 'jolt-physics/dist/jolt-physics.wasm.js')
    const { default: init } = await import(_joltSpec)
    joltInstance = await init()
  }
  return joltInstance
}

export class PhysicsWorld {
  constructor(config = {}) {
    this.gravity = config.gravity || [0, -9.81, 0]
    this.Jolt = null; this.jolt = null; this.physicsSystem = null; this.bodyInterface = null
    this.bodies = new Map(); this.bodyMeta = new Map(); this.bodyIds = new Map()
    this._objFilter = null; this._ovbp = null
    this._shapeCache = new Map(); this._convexQueue = Promise.resolve()
    this._trimeshCache = new Map(); this._trimeshInflight = new Map()
    this._bodyPool = new Map(); this._bodyShapeKey = new Map()
    this._bodyQueue = []
    this._tmpVec3 = null; this._tmpRVec3 = null
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
    this._objFilter = objFilter; this._ovbp = ovbp
    this.jolt = new J.JoltInterface(settings); J.destroy(settings)
    this.physicsSystem = this.jolt.GetPhysicsSystem(); this.bodyInterface = this.physicsSystem.GetBodyInterface()
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
    // Aggressive body-sleep tuning: Jolt's own defaults (mTimeBeforeSleep=0.5s, mPointVelocitySleepThreshold=0.03)
    // were left untouched -- for a large scene of mostly-static-once-settled dynamic props (the 30k-model
    // budget target) a shorter settle time + slightly higher velocity floor means far more of the active-body
    // set self-sleeps via Jolt's own island-based sleep logic BEFORE the hard-activation-ring/global-budget
    // logic in AppRuntimePhysics even has to intervene -- the two mechanisms are complementary, not redundant:
    // this lowers the steady-state active count, the ring/budget logic bounds the worst case under load.
    if (typeof this.physicsSystem.GetPhysicsSettings === 'function' && typeof this.physicsSystem.SetPhysicsSettings === 'function') {
      const ps = this.physicsSystem.GetPhysicsSettings()
      ps.mTimeBeforeSleep = 0.25              // was Jolt default 0.5s -- settle twice as fast
      ps.mPointVelocitySleepThreshold = 0.05  // was Jolt default 0.03 -- sleep at a slightly higher residual jitter
      this.physicsSystem.SetPhysicsSettings(ps)
    }
    this._charMgr.init(J, this.jolt, this.physicsSystem)
    return this
  }

  _addBody(shape, position, motionType, layer, opts = {}) {
    const J = this.Jolt
    const pos = new J.RVec3(position[0], position[1], position[2])
    const rot = opts.rotation ? new J.Quat(...opts.rotation) : new J.Quat(0, 0, 0, 1)
    const cs = new J.BodyCreationSettings(shape, pos, rot, motionType, layer)
    J.destroy(pos); J.destroy(rot)
    if (opts.mass) { cs.mMassPropertiesOverride.mMass = opts.mass; cs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia }
    if (opts.friction !== undefined) cs.mFriction = opts.friction
    if (opts.restitution !== undefined) cs.mRestitution = opts.restitution   // bounciness 0..1
    if (opts.gravityFactor !== undefined) cs.mGravityFactor = opts.gravityFactor   // 0 = float, <0 = anti-gravity
    if (opts.linearDamping !== undefined) cs.mLinearDamping = opts.linearDamping
    if (opts.angularDamping !== undefined) cs.mAngularDamping = opts.angularDamping
    if (opts.linearCast) cs.mMotionQuality = J.EMotionQuality_LinearCast
    const activate = motionType === J.EMotionType_Static ? J.EActivation_DontActivate : J.EActivation_Activate
    const body = this.bodyInterface.CreateBody(cs); this.bodyInterface.AddBody(body.GetID(), activate)
    J.destroy(cs)
    this._createCount = (this._createCount | 0) + 1
    const id = body.GetID().GetIndexAndSequenceNumber()
    this.bodies.set(id, body); this.bodyMeta.set(id, opts.meta || {}); this.bodyIds.set(id, body.GetID())
    if (opts.shapeKey) this._bodyShapeKey.set(id, opts.shapeKey)
    return id
  }

  addStaticBox(halfExtents, position, rotation) {
    const J = this.Jolt
    const hv = new J.Vec3(halfExtents[0], halfExtents[1], halfExtents[2])
    const bs = new J.BoxShape(hv, 0.05, null); J.destroy(hv)
    return this._addBody(bs, position, J.EMotionType_Static, LAYER_STATIC, { rotation, meta: { type: 'static', shape: 'box' } })
  }

  // activate: null (default) = EActivation_DontActivate (original behavior, correct for the STATIC
  // shapeKey pool users this was written for -- terrain colliders etc, which never simulate dynamics
  // either way). Pass true/false explicitly to force-activate or force-deactivate a DYNAMIC body being
  // parked/revived through the pool -- see removeBody/addBody's pool paths below, and the header comment
  // on why a dynamic body needs this (a merely-repositioned park with DontActivate does NOT deactivate an
  // already-active body -- it keeps simulating/falling forever at the park position, a real measured
  // per-tick cost live-witnessed while pooling destructible debris: a "parked" dynamic body fell
  // continuously the whole time it sat in the pool, 6.46m of drift across 1s of ticks in one probe).
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
  }

  addBody(shapeType, params, position, motionType, opts = {}) {
    const J = this.Jolt; let shape
    const sk = opts.shapeKey || null
    if (sk) {
      const free = this._bodyPool.get(sk)
      if (free && free.length) {
        const id = free.pop()
        // Dynamic revive: reactivate + wipe stale linear/angular velocity from the piece's PREVIOUS life
        // (live-witnessed carrying over: a body removeBody'd mid-fall at -4.8m/s kept that exact velocity
        // into its next life at a totally different position, a real correctness bug for pooled debris --
        // a freshly "destroyed" piece would otherwise inherit whatever momentum the last occupant of this
        // pool slot happened to have when it despawned). Static/kinematic reuse (terrain colliders, the
        // pool's original use case) is unaffected since motionType there is never 'dynamic'.
        const isDynamic = motionType === 'dynamic'
        this._repositionBody(id, position, opts.rotation, isDynamic ? true : null)
        if (isDynamic) {
          this.setBodyVelocity(id, [0, 0, 0])
          this.setBodyAngularVelocity(id, [0, 0, 0])
        }
        return id
      }
    }
    if (shapeType === 'box') {
      const bk = opts.shapeKey || null
      if (bk && this._shapeCache.has(bk)) shape = this._shapeCache.get(bk)
      else { const cr = Math.min(0.05, Math.min(params[0], params[1], params[2]) * 0.1); const bv = new J.Vec3(params[0], params[1], params[2]); shape = new J.BoxShape(bv, cr, null); J.destroy(bv); if (bk) this._shapeCache.set(bk, shape) }
    }
    else if (shapeType === 'sphere') shape = new J.SphereShape(params)
    else if (shapeType === 'capsule') {
      const ck = opts.shapeKey || null
      if (ck && this._shapeCache.has(ck)) shape = this._shapeCache.get(ck)
      else { shape = new J.CapsuleShape(params[1], params[0]); if (ck) this._shapeCache.set(ck, shape) }
    }
    else if (shapeType === 'convex') {
      // sr must outlive the _addBody call that consumes cvxShape -- see ShapeBuilder.js's buildConvexShape
      // header comment (a real, live-reproduced WASM state-corruption bug found+fixed while wiring
      // destructibles-fractured-glb-shape-wiring's dynamic convex debris bodies).
      const { shape: cvxShape, sr } = buildConvexShape(J, params, this._shapeCache, opts.shapeKey || null)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      const id = this._addBody(cvxShape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
      if (sr) J.destroy(sr)
      return id
    }
    else return null
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    return this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
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
    if (cacheKey && this._shapeCache.has(cacheKey)) {
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return Promise.resolve(this._addBody(this._shapeCache.get(cacheKey), position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } }))
    }
    const result = this._convexQueue.then(() => {
      // sr must outlive the _addBody call below -- see ShapeBuilder.js's buildConvexShape header comment.
      const { shape, sr } = buildConvexShape(J, params, this._shapeCache, cacheKey)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      const id = this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } })
      if (sr) J.destroy(sr)
      return id
    })
    this._convexQueue = result.then(() => {}, () => {}); return result
  }

  // Shape caching/welding: a static trimesh cooked from a GLB (extractAllMeshesFromGLBAsync + Jolt
  // MeshShapeSettings.Create()) is real, measurable per-call cost -- full mesh extraction plus native
  // triangle-list construction -- yet maps commonly place the SAME model many times (rocks, crates,
  // barrels, props). Every prior call re-extracted and re-cooked from scratch even for an identical
  // glbPath+scale pair. Cache key is glbPath+scale (buildTrimeshShape pre-scales vertices into world
  // space, so two different scales of the same model genuinely need two different cooked shapes; a
  // rotation-only difference does NOT, since rotation is applied at the body level via _addBody's
  // BodyCreationSettings, not baked into the shape). The cached Shape is a real Jolt-side ref-counted
  // object (Shape.AddRef/Release/GetRefCount, confirmed in jolt-physics.wasm-compat.d.ts) -- sharing one
  // cooked shape across many bodies is Jolt's own supported "welding" pattern, same trust level as the
  // pre-existing box/capsule/convex shapeKey cache in addBody/buildConvexShape above (which also never
  // destroys a cached shape, relying on Jolt's own refcounting under each BodyCreationSettings/body).
  // In-flight dedupe (_trimeshInflight) additionally prevents two concurrent placements of the same
  // model+scale from racing two independent cook operations before either populates the cache.
  async addStaticTrimeshAsync(glbPath, meshIndex = 0, position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0, 1]) {
    if (!glbPath) throw new Error('addStaticTrimeshAsync: no glbPath (resolveAssetPath rejected or returned an empty path)')
    const J = this.Jolt
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
      // Live-witnessed hard rule (WASM "null function or function signature mismatch" crash on the
      // NEXT distinct trimesh add otherwise): the ShapeResult (`sr`) must be destroyed only AFTER a
      // real _addBody call has consumed/reffed the Shape it wraps -- destroying it any earlier (e.g.
      // inside the .then() before the first body exists) corrupts Jolt's WASM state for subsequent
      // shape creation, even though `shape` itself looks like a valid JS object at that point.
      // `built` is the SAME object handed to every concurrent `await inflight` caller (a resolved
      // Promise shares its value, it does not clone it) -- when N callers raced the same fresh key
      // (the in-flight-dedupe case _trimeshInflight exists for), naively checking `built.sr` would
      // have every one of them see it truthy and each call J.destroy(built.sr), a double-destroy of
      // the same native object. Null it out on first claim so only ONE of the N awaiters (whichever
      // microtask runs first, harmless which) actually owns and performs the destroy.
      if (built.sr) { srToDestroyAfterFirstUse = built.sr; built.sr = null }
    }
    const id = this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { rotation, meta: { type: 'static', shape: 'trimesh', shapeKey: key } })
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
    if (!sr.IsValid()) { console.error('[heightfield] shape invalid:', sr.GetError()); J.destroy(settings); J.destroy(sr); return null }
    const shape = sr.Get()
    const id = this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'heightfield' } })
    J.destroy(settings); J.destroy(sr)
    return id
  }

  addStaticTrimeshFromData(entityId,v,ix,pos,rot=[0,0,0,1]){const J=this.Jolt,tc=ix.length/3,tl=new J.TriangleList(),f3=new J.Float3(0,0,0);tl.resize(tc);for(let t=0;t<tc;t++){const tri=tl.at(t);for(let k=0;k<3;k++){const i=ix[t*3+k];f3.x=v[i*3];f3.y=v[i*3+1];f3.z=v[i*3+2];tri.set_mV(k,f3)}}const ms=new J.MeshShapeSettings(tl),sr=ms.Create();if(!sr.IsValid()){console.error('[trimesh] shape invalid for',entityId,sr.GetError());J.destroy(f3);J.destroy(tl);J.destroy(ms);return null}const shape=sr.Get();J.destroy(f3);J.destroy(tl);const id=this._addBody(shape,pos,J.EMotionType_Static,LAYER_STATIC,{rotation:rot,meta:{type:'static',shape:'trimesh'}});J.destroy(ms);J.destroy(sr);console.log('[trimesh] body created for',entityId,'id='+id,'tris='+tc);return id}

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
  removeCharacter(id) { this._charMgr.removeCharacter(id) }
  get characters() { return this._charMgr.characters }
  // Rollback-netcode primitive, character-body half of snapshotBodies/restoreBodies (players use
  // CharacterVirtual, not regular Jolt bodies -- see CharacterManager.js's own snapshotAll/restoreAll
  // header comment for why only position+velocity round-trip).
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

  // Rollback-netcode primitive (rollback-netcode-ggpo-style-input-rollback first slice): capture every
  // non-static body's full dynamics state (position, rotation, linear+angular velocity) for later exact
  // restore, the save/rewind half of a GGPO-style save-state -> resimulate-forward loop. Static bodies
  // (terrain, placed props with autoTrimesh, etc) are skipped entirely -- by construction a static body
  // never moves under simulation, so capturing/restoring it is pure waste on every single rollback save,
  // which per this row's own architecture happens on a tight per-tick budget. Uses the SAME
  // GetPositionAndRotation/GetLinearAndAngularVelocity bulk-read convention syncDynamicBody already
  // proved safe every tick in production (see the getBodyPosition/getBodyRotation header comment above
  // for why the two single-field getters are NOT safe to call back-to-back -- this reuses the safe path).
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

  // Restores exactly the bodies present in `snap` (a Map from snapshotBodies, or a plain object with the
  // same per-entry shape for a wire-deserialized snapshot). A body present in `snap` but since removed
  // from the live world (removeBody'd between save and rollback -- e.g. a debris piece that despawned) is
  // silently skipped, matching CharacterManager.restoreAll's same-set assumption: a rollback caller always
  // restores against the identical body population it saved, so this is a defensive skip, not a real path.
  // EActivation_Activate: a rolled-back body must be simulating again even if the pre-restore Jolt state
  // happened to have it asleep (a resimulate pass needs every body live for the physics.step() calls that
  // follow, or Jolt will not integrate a sleeping body and the resimulation silently diverges from a truly
  // deterministic replay where that body was awake throughout).
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

  // NOTE: routed through GetPositionAndRotation + the pre-allocated, never-destroyed _bulkOutP/_bulkOutR
  // scratch pair (the same buffers syncDynamicBody already used safely), NOT the single-field
  // GetPosition/GetRotation calls the two used to make independently. Real bug found+fixed this session
  // (deterministic-simulation-jolt-fixed-point-rollback probe): calling getBodyPosition(id) then
  // getBodyRotation(id) for the same body in the same tick -- in EITHER order, even across two separate
  // loops over the same body set (not just interleaved per-body) -- crashed with a real, 100% reproducible
  // "RuntimeError: memory access out of bounds" WASM trap, live-isolated down to a single dynamic body,
  // first tick, fresh process (not a multi-world/heap-accumulation artifact). Root cause: GetPosition's and
  // GetRotation's own embind wrappers each return a value via an embind by-value-return convention that,
  // like the already-documented GetAngularVelocity buffer below, is NOT safe to Jolt.destroy() when a sibling
  // getter's return value is live in the same synchronous scope -- calling BOTH getters (each individually
  // safe when called alone, confirmed via a 600-tick isolation run) then destroying either return value
  // corrupts shared WASM-side state the other getter's wrapper also touches. GetPositionAndRotation's own
  // out-param convention was already proven safe under the identical 24-body/600-tick stress (syncDynamicBody
  // uses it every tick in production) -- reusing it here fixes both getters without changing either's public
  // signature or return shape. This is a real fix, not exemption: nothing new is heap-allocated per call to
  // the reused _bulkOutP/_bulkOutR pair, same discipline as getBodyAngularVelocity's no-destroy fix.
  getBodyPosition(id) { const b = this._getBody(id); if (!b) return [0,0,0]; this.bodyInterface.GetPositionAndRotation(b.GetID(), this._bulkOutP, this._bulkOutR); return [this._bulkOutP.GetX(),this._bulkOutP.GetY(),this._bulkOutP.GetZ()] }
  getBodyRotation(id) { const b = this._getBody(id); if (!b) return [0,0,0,1]; this.bodyInterface.GetPositionAndRotation(b.GetID(), this._bulkOutP, this._bulkOutR); return [this._bulkOutR.GetX(),this._bulkOutR.GetY(),this._bulkOutR.GetZ(),this._bulkOutR.GetW()] }
  getBodyVelocity(id) { const b = this._getBody(id); if (!b) return [0,0,0]; const v = this.bodyInterface.GetLinearVelocity(b.GetID()); const r=[v.GetX(),v.GetY(),v.GetZ()]; this.Jolt.destroy(v); return r }
  // NOTE: deliberately does NOT Jolt.destroy() the returned Vec3, unlike every sibling getter above.
  // Live-reproduced real bug (destructibles-debris-lifetime-lod session): BodyInterface.GetAngularVelocity's
  // embind wrapper returns a reference into a Jolt-internal reusable temp buffer (not a fresh heap Vec3 the
  // way GetPosition/GetRotation/GetLinearVelocity's OWN return values behave when called in isolation) --
  // destroying it here, then calling GetLinearVelocity (or GetAngularVelocity again) in the SAME tick during
  // a body's collision-response step, corrupted that shared buffer: a real "RuntimeError: memory access out
  // of bounds" WASM trap, deterministically reproduced at the exact tick a falling body first contacts the
  // ground (collision resolution touches the same internal velocity buffer Jolt is about to hand back out).
  // Isolated via paired probes: GetLinearVelocity-only (destroyed every tick) survives 500 ticks fine;
  // GetAngularVelocity-only (destroyed every tick) ALSO survives fine; only the INTERLEAVED linear+angular
  // sequence in one tick crashes -- and skipping the destroy() on angular's result alone (leaving linear's
  // existing destroy() untouched) fully fixes it. A one-time-per-call skipped destroy on a reused Jolt-side
  // temp buffer is not a real leak (nothing new is allocated per call to begin with).
  getBodyAngularVelocity(id) { const b = this._getBody(id); if (!b || !this.bodyInterface.GetAngularVelocity) return [0,0,0]; const v = this.bodyInterface.GetAngularVelocity(b.GetID()); return [v.GetX(),v.GetY(),v.GetZ()] }
  setBodyFriction(id, f) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetFriction) return false; this.bodyInterface.SetFriction(b.GetID(), f); return true }
  setBodyRestitution(id, r) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetRestitution) return false; this.bodyInterface.SetRestitution(b.GetID(), r); return true }
  setBodyPosition(id, p) { const b = this._getBody(id); if (!b) return; this._tmpRVec3.Set(p[0],p[1],p[2]); this.bodyInterface.SetPosition(b.GetID(), this._tmpRVec3, this.Jolt.EActivation_Activate) }
  // Flip an existing body's Jolt motion type in place (Dynamic<->Kinematic) for the hard-activation-ring
  // 30-100m tier -- reuses the same body/shape rather than destroy+recreate, so a ring crossing is one
  // Jolt call instead of a full shape rebuild. EActivation_DontActivate: caller decides activation separately.
  setBodyMotionType(id, motionType) {
    const b = this._getBody(id); if (!b || !this.bodyInterface.SetMotionType) return false
    const J = this.Jolt
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    this.bodyInterface.SetMotionType(b.GetID(), mt, J.EActivation_DontActivate)
    return true
  }
  // Proximity-priority sleep: put an active body to sleep without destroying it (cheap to reactivate,
  // unlike removeBody which frees the Jolt shape). DeactivateBody fires the same OnBodyDeactivated
  // listener a natural velocity-threshold sleep would, so AppRuntimePhysics' bookkeeping (active/sleeping
  // sets) stays correct via the existing listener, no separate code path needed downstream.
  deactivateBody(id) {
    const b = this._getBody(id); if (!b || !this.bodyInterface.DeactivateBody) return false
    this.bodyInterface.DeactivateBody(b.GetID())
    return true
  }
  setBodyVelocity(id, v) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(v[0],v[1],v[2]); this.bodyInterface.SetLinearVelocity(b.GetID(), this._tmpVec3) }
  // Undocumented-in-.d.ts but real, compiled-WASM-confirmed binding (same class of gap as the
  // Vehicle* surface -- see project/vehicles-jolt-constraint-available-not-just-twobody in AGENTS.md).
  // Needed to fully reset a REUSED dynamic body (pooled debris revival): SetLinearVelocity alone leaves
  // stale angular velocity/spin from the body's PREVIOUS life on the pooled Jolt body, since Jolt does
  // not reset angular velocity as a side effect of SetPosition/SetLinearVelocity.
  setBodyAngularVelocity(id, v) { const b = this._getBody(id); if (!b || !this.bodyInterface.SetAngularVelocity) return false; this._tmpVec3.Set(v[0],v[1],v[2]); this.bodyInterface.SetAngularVelocity(b.GetID(), this._tmpVec3); return true }
  addForce(id, f) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(f[0],f[1],f[2]); this.bodyInterface.AddForce(b.GetID(), this._tmpVec3) }
  // Optional worldPoint applies the impulse OFF-CENTRE (Jolt AddImpulse(id, impulse, point)) so it
  // imparts spin/torque -- a ball curves, a kick tumbles a prop. Without it the impulse is centre-of-mass.
  addImpulse(id, im, worldPoint) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(im[0],im[1],im[2]); if (worldPoint) { this._tmpRVec3.Set(worldPoint[0],worldPoint[1],worldPoint[2]); this.bodyInterface.AddImpulse(b.GetID(), this._tmpVec3, this._tmpRVec3) } else this.bodyInterface.AddImpulse(b.GetID(), this._tmpVec3) }
  setBodyGravityFactor(id, f) { const b = this._getBody(id); if (!b || typeof f !== 'number' || !Number.isFinite(f)) return; this.bodyInterface.SetGravityFactor(b.GetID(), f) }

  // Join two bodies with a Jolt TwoBodyConstraint. type: 'fixed' (weld -- lock relative transform),
  // 'point' (ball joint -- share a point, free rotation), 'distance' (rigid rod between anchors),
  // 'hinge' (rotate about an axis). anchorA/anchorB are WORLD-space attach points (default both bodies'
  // current positions). Returns a constraintId for removeConstraint, or null if a body is unknown.
  addConstraint(bodyIdA, bodyIdB, opts = {}) {
    if (!this.physicsSystem) return null
    const ba = this._getBody(bodyIdA), bb = this._getBody(bodyIdB)
    if (!ba || !bb) return null
    const J = this.Jolt, type = opts.type || 'fixed'
    const pa = this.bodyInterface.GetPosition(ba.GetID()), pb = this.bodyInterface.GetPosition(bb.GetID())
    const aA = opts.anchorA || [pa.GetX(), pa.GetY(), pa.GetZ()]
    const aB = opts.anchorB || [pb.GetX(), pb.GetY(), pb.GetZ()]
    J.destroy(pa); J.destroy(pb)
    let settings = null
    try {
      if (type === 'point') {
        settings = new J.PointConstraintSettings()
        settings.mSpace = J.EConstraintSpace_WorldSpace
        settings.mPoint1 = new J.RVec3(aA[0], aA[1], aA[2]); settings.mPoint2 = new J.RVec3(aB[0], aB[1], aB[2])
      } else if (type === 'distance') {
        settings = new J.DistanceConstraintSettings()
        settings.mSpace = J.EConstraintSpace_WorldSpace
        settings.mPoint1 = new J.RVec3(aA[0], aA[1], aA[2]); settings.mPoint2 = new J.RVec3(aB[0], aB[1], aB[2])
        if (opts.minDistance != null) settings.mMinDistance = opts.minDistance
        if (opts.maxDistance != null) settings.mMaxDistance = opts.maxDistance
      } else if (type === 'hinge') {
        settings = new J.HingeConstraintSettings()
        settings.mSpace = J.EConstraintSpace_WorldSpace
        settings.mPoint1 = new J.RVec3(aA[0], aA[1], aA[2]); settings.mPoint2 = new J.RVec3(aB[0], aB[1], aB[2])
        const ax = opts.axis || [0, 1, 0]
        settings.mHingeAxis1 = new J.Vec3(ax[0], ax[1], ax[2]); settings.mHingeAxis2 = new J.Vec3(ax[0], ax[1], ax[2])
        settings.mNormalAxis1 = new J.Vec3(1, 0, 0); settings.mNormalAxis2 = new J.Vec3(1, 0, 0)
      } else { // fixed / weld
        settings = new J.FixedConstraintSettings()
        settings.mSpace = J.EConstraintSpace_WorldSpace
        settings.mPoint1 = new J.RVec3(aA[0], aA[1], aA[2]); settings.mPoint2 = new J.RVec3(aB[0], aB[1], aB[2])
      }
      const c = settings.Create(ba, bb)
      this.physicsSystem.AddConstraint(c)
      const cid = (this._nextConstraintId = (this._nextConstraintId || 0) + 1)
      if (!this._constraints) this._constraints = new Map()
      this._constraints.set(cid, c)
      return cid
    } catch (e) { console.error('[physics] addConstraint failed:', e?.message || e); return null }
    finally { if (settings) J.destroy(settings) }
  }
  removeConstraint(constraintId) {
    const c = this._constraints && this._constraints.get(constraintId)
    if (!c || !this.physicsSystem) return false
    this.physicsSystem.RemoveConstraint(c); this.Jolt.destroy(c); this._constraints.delete(constraintId)
    return true
  }


  // Vehicle constraint methods (createWheeledVehicle, createTrackedVehicle, driver-input, wheel
  // accessors, removeVehicle) live in VehiclePhysics.js, mixed onto this prototype below the class
  // body -- see that file's header comment for the full WASM-crash-avoidance rationale.

  enqueueAdd(shapeType, params, position, motionType, opts, onAdded) {
    this._bodyQueue.push({ op: 'add', shapeType, params, position, motionType, opts: opts || {}, onAdded })
  }

  enqueueRemove(id, force = false) {
    this._bodyQueue.push({ op: 'remove', id, force })
  }

  // drainBodyQueue must run before physics.step() each tick: adds before removes.
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

  // collisionSteps is Jolt's own real Step(deltaTime, inCollisionSteps) sub-stepping parameter --
  // more collision steps per physics tick catch fast-moving bodies that would otherwise tunnel
  // through thin colliders within a single tick's motion. Default stays 2 (unchanged from before
  // this option existed) since quadrupling it unconditionally for every world would be a real,
  // needless per-tick cost for the common case (most bodies are slow enough that 2 is already
  // sufficient) -- a caller with genuinely fast projectiles/characters (the CCD-policy-per-entity-
  // class need this pairs with) passes a higher value explicitly instead.
  step(dt, collisionSteps = 2) { if (this.jolt) this.jolt.Step(dt, collisionSteps) }

  removeBody(id, force = false) {
    const b = this._getBody(id); if (!b) return
    const sk = !force && this._bodyShapeKey.get(id)
    if (sk) {
      // Force-deactivate a DYNAMIC body on park (see addBody's pool-hit revive comment above for the
      // measured cost of NOT doing this): merely repositioning with DontActivate does not stop an
      // already-active body from continuing to simulate/fall at the park position for however long it
      // sits pooled. Static/kinematic park (the pool's original terrain-collider use case) is unaffected
      // -- those never simulate dynamics regardless of active/inactive state.
      const isDynamic = this.bodyMeta.get(id)?.type === 'dynamic'
      this._repositionBody(id, _PARK_POS, null, isDynamic ? false : null)
      if (isDynamic) { this.setBodyVelocity(id, [0, 0, 0]); this.setBodyAngularVelocity(id, [0, 0, 0]) }
      let free = this._bodyPool.get(sk); if (!free) this._bodyPool.set(sk, free = [])
      free.push(id)
      return
    }
    this.bodyInterface.RemoveBody(b.GetID()); this.bodyInterface.DestroyBody(b.GetID())
    this.bodies.delete(id); this.bodyMeta.delete(id); this.bodyIds.delete(id); this._bodyShapeKey.delete(id)
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

  // Per-call Jolt scratch, created once and reused (same convention CharacterManager.init already uses
  // for its own bp/ol/body/shape filters + _tmpVec3/_tmpRVec3). Removes 9 embind constructions and 7
  // destroy() calls per raycast (measured 5.7us -> 1.15us per raycast against a real aim_sillos trimesh
  // BVH). It also stops a real leak: the RVec3/Vec3 handed to the RRayCast constructor were the two
  // allocations the old code never destroyed -- 80 bytes of WASM heap high-water per raycast, measured
  // monotonic (8 MB per 100k casts) and flat once destroyed.
  // Not re-entrant: raycast is fully synchronous with no user callback inside it, and asyncQuery's only
  // other caller path invokes it in a plain sequential loop.
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
    // Scalars, not a `dir` array: same `/len` division (NOT a reciprocal multiply -- that shifts the
    // result by 1 ulp), so every returned number is bit-identical to the pre-scratch version.
    const dirX = len > 0 ? direction[0]/len : direction[0]
    const dirY = len > 0 ? direction[1]/len : direction[1]
    const dirZ = len > 0 ? direction[2]/len : direction[2]
    const s = this._raycastScratch()
    s.origin.Set(origin[0], origin[1], origin[2])
    s.dir.Set(dirX*maxDistance, dirY*maxDistance, dirZ*maxDistance)
    s.ray.set_mOrigin(s.origin); s.ray.set_mDirection(s.dir)
    s.col.Reset()
    const eb = excludeBodyId != null ? this._getBody(excludeBodyId) : null
    const bf = eb ? new J.IgnoreSingleBodyFilter(eb.GetID()) : s.bf
    const col = s.col
    this.physicsSystem.GetNarrowPhaseQuery().CastRay(s.ray, s.rs, col, s.bp, s.ol, bf, s.sf)
    let result
    if (col.HadHit()) {
      const hit = col.get_mHit()
      const dist = hit.mFraction * maxDistance
      const position = [origin[0]+dirX*dist, origin[1]+dirY*dist, origin[2]+dirZ*dist]
      // Resolve the hit body back to a World body id -- the World id IS the Jolt
      // GetIndexAndSequenceNumber() (see addBody), so this keys the same bodyMeta / the runtime's
      // _physicsBodyToEntityId reverse map directly. Callers get an ATTRIBUTED hit (which entity/body),
      // not just a point -- this is the primitive that makes shoot/click-a-target games authorable.
      let bodyId = null, normal = null
      try {
        const bid = hit.mBodyID
        if (bid) bodyId = bid.GetIndexAndSequenceNumber()
        // Surface normal at the hit point (world space), for oriented decals / bounce / aim feedback.
        const b = bodyId != null ? this._getBody(bodyId) : null
        if (b) {
          this._tmpRVec3.Set(position[0], position[1], position[2])
          const n = b.GetWorldSpaceSurfaceNormal(hit.mSubShapeID2, this._tmpRVec3)
          normal = [n.GetX(), n.GetY(), n.GetZ()]
          J.destroy(n)
        }
      } catch (_) { /* normal/body extraction is best-effort; position always returns */ }
      result = { hit: true, distance: dist, body: null, bodyId, normal, position }
    } else result = { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null }
    if (eb) J.destroy(bf)   // only the per-call IgnoreSingleBodyFilter; the rest is reused scratch
    return result
  }

  destroy() {
    if (!this.Jolt) return
    if (this._rcScratch) {
      const s = this._rcScratch, J = this.Jolt
      J.destroy(s.ray); J.destroy(s.origin); J.destroy(s.dir); J.destroy(s.rs)
      J.destroy(s.col); J.destroy(s.bp); J.destroy(s.ol); J.destroy(s.bf); J.destroy(s.sf)
      this._rcScratch = null
    }
    if (this._vehWheelAxes) { this.Jolt.destroy(this._vehWheelAxes.right); this.Jolt.destroy(this._vehWheelAxes.up); this._vehWheelAxes = null }
    this._charMgr.destroy()
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
    if (this.jolt) { J.destroy(this.jolt); this.jolt = null }
    this.physicsSystem = null; this.bodyInterface = null
  }
}

installVehiclePhysics(PhysicsWorld)
