import initJolt from '/spoint/node_modules/jolt-physics/dist/jolt-physics.wasm-compat.js'
import { extractMeshFromGLB, extractMeshFromGLBAsync } from './GLBLoader.js'
import { CharacterManager } from './CharacterManager.js'
import { buildConvexShape, buildTrimeshShape } from './ShapeBuilder.js'

const LAYER_STATIC = 0, LAYER_DYNAMIC = 1, NUM_LAYERS = 2
let joltInstance = null
async function getJolt() { if (!joltInstance) joltInstance = await initJolt(); return joltInstance }

export class PhysicsWorld {
  constructor(config = {}) {
    this.gravity = config.gravity || [0, -9.81, 0]
    this.Jolt = null; this.jolt = null; this.physicsSystem = null; this.bodyInterface = null
    this.bodies = new Map(); this.bodyMeta = new Map(); this.bodyIds = new Map()
    this._objFilter = null; this._ovbp = null
    this._shapeCache = new Map(); this._convexQueue = Promise.resolve()
    this._tmpVec3 = null; this._tmpRVec3 = null
    this._bulkOutP = null; this._bulkOutR = null; this._bulkOutLV = null; this._bulkOutAV = null
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
    this._tmpVec3 = new J.Vec3(0, 0, 0); this._tmpRVec3 = new J.RVec3(0, 0, 0)
    this._bulkOutP = new J.RVec3(0, 0, 0); this._bulkOutR = new J.Quat(0, 0, 0, 1)
    this._bulkOutLV = new J.Vec3(0, 0, 0); this._bulkOutAV = new J.Vec3(0, 0, 0)
    const [gx, gy, gz] = this.gravity
    const gv = new J.Vec3(gx, gy, gz); this.physicsSystem.SetGravity(gv); J.destroy(gv)
    this._heap32 = new Int32Array(J.HEAP8.buffer)
    this._activationListener = new J.BodyActivationListenerJS()
    this._activationListener.OnBodyActivated = (ptr) => { if (this.onBodyActivated) this.onBodyActivated(this._heap32[ptr >> 2]) }
    this._activationListener.OnBodyDeactivated = (ptr) => { if (this.onBodyDeactivated) this.onBodyDeactivated(this._heap32[ptr >> 2]) }
    this.physicsSystem.SetBodyActivationListener(this._activationListener)
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
    if (opts.restitution !== undefined) cs.mRestitution = opts.restitution
    if (opts.linearDamping !== undefined) cs.mLinearDamping = opts.linearDamping
    if (opts.angularDamping !== undefined) cs.mAngularDamping = opts.angularDamping
    if (opts.linearCast) cs.mMotionQuality = J.EMotionQuality_LinearCast
    const activate = motionType === J.EMotionType_Static ? J.EActivation_DontActivate : J.EActivation_Activate
    const body = this.bodyInterface.CreateBody(cs); this.bodyInterface.AddBody(body.GetID(), activate)
    J.destroy(cs)
    const id = body.GetID().GetIndexAndSequenceNumber()
    this.bodies.set(id, body); this.bodyMeta.set(id, opts.meta || {}); this.bodyIds.set(id, body.GetID())
    return id
  }

  addStaticBox(halfExtents, position, rotation) {
    const J = this.Jolt
    const hv = new J.Vec3(halfExtents[0], halfExtents[1], halfExtents[2])
    const bs = new J.BoxShape(hv, 0.05, null); J.destroy(hv)
    return this._addBody(bs, position, J.EMotionType_Static, LAYER_STATIC, { rotation, meta: { type: 'static', shape: 'box' } })
  }

  addBody(shapeType, params, position, motionType, opts = {}) {
    const J = this.Jolt; let shape
    if (shapeType === 'box') { const cr = Math.min(0.05, Math.min(params[0], params[1], params[2]) * 0.1); const bv = new J.Vec3(params[0], params[1], params[2]); shape = new J.BoxShape(bv, cr, null); J.destroy(bv) }
    else if (shapeType === 'sphere') shape = new J.SphereShape(params)
    else if (shapeType === 'capsule') shape = new J.CapsuleShape(params[1], params[0])
    else if (shapeType === 'convex') {
      const { shape: cvxShape } = buildConvexShape(J, params, this._shapeCache, opts.shapeKey || null)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return this._addBody(cvxShape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
    }
    else return null
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    return this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: shapeType } })
  }

  addConvexBodyAsync(params, position, motionType, opts = {}) {
    const J = this.Jolt, cacheKey = opts.shapeKey || null
    if (cacheKey && this._shapeCache.has(cacheKey)) {
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return Promise.resolve(this._addBody(this._shapeCache.get(cacheKey), position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } }))
    }
    const result = this._convexQueue.then(() => {
      const { shape } = buildConvexShape(J, params, this._shapeCache, cacheKey)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } })
    })
    this._convexQueue = result.then(() => {}, () => {}); return result
  }

  async addStaticTrimeshAsync(glbPath, meshIndex = 0, position = [0, 0, 0], scale = [1, 1, 1]) {
    const J = this.Jolt
    const { shape, sr, triangleCount } = await buildTrimeshShape(J, glbPath, scale)
    const id = this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'trimesh', triangles: triangleCount } })
    J.destroy(sr); return id
  }

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

  getBodyPosition(id) { const b = this._getBody(id); if (!b) return [0,0,0]; const p = this.bodyInterface.GetPosition(b.GetID()); const r=[p.GetX(),p.GetY(),p.GetZ()]; this.Jolt.destroy(p); return r }
  getBodyRotation(id) { const b = this._getBody(id); if (!b) return [0,0,0,1]; const q = this.bodyInterface.GetRotation(b.GetID()); const r=[q.GetX(),q.GetY(),q.GetZ(),q.GetW()]; this.Jolt.destroy(q); return r }
  getBodyVelocity(id) { const b = this._getBody(id); if (!b) return [0,0,0]; const v = this.bodyInterface.GetLinearVelocity(b.GetID()); const r=[v.GetX(),v.GetY(),v.GetZ()]; this.Jolt.destroy(v); return r }
  setBodyPosition(id, p) { const b = this._getBody(id); if (!b) return; this._tmpRVec3.Set(p[0],p[1],p[2]); this.bodyInterface.SetPosition(b.GetID(), this._tmpRVec3, this.Jolt.EActivation_Activate) }
  setBodyVelocity(id, v) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(v[0],v[1],v[2]); this.bodyInterface.SetLinearVelocity(b.GetID(), this._tmpVec3) }
  addForce(id, f) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(f[0],f[1],f[2]); this.bodyInterface.AddForce(b.GetID(), this._tmpVec3) }
  addImpulse(id, im) { const b = this._getBody(id); if (!b) return; this._tmpVec3.Set(im[0],im[1],im[2]); this.bodyInterface.AddImpulse(b.GetID(), this._tmpVec3) }
  step(dt) { if (this.jolt) this.jolt.Step(dt, 2) }

  removeBody(id) {
    const b = this._getBody(id); if (!b) return
    this.bodyInterface.RemoveBody(b.GetID()); this.bodyInterface.DestroyBody(b.GetID())
    this.bodies.delete(id); this.bodyMeta.delete(id); this.bodyIds.delete(id)
  }

  raycast(origin, direction, maxDistance = 1000, excludeBodyId = null) {
    if (!this.physicsSystem) return { hit: false, distance: maxDistance, body: null, position: null }
    const J = this.Jolt
    const len = Math.hypot(direction[0], direction[1], direction[2])
    const dir = len > 0 ? [direction[0]/len, direction[1]/len, direction[2]/len] : direction
    const ray = new J.RRayCast(new J.RVec3(origin[0], origin[1], origin[2]), new J.Vec3(dir[0]*maxDistance, dir[1]*maxDistance, dir[2]*maxDistance))
    const rs = new J.RayCastSettings(), col = new J.CastRayClosestHitCollisionCollector()
    const bp = new J.DefaultBroadPhaseLayerFilter(this.jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_DYNAMIC)
    const ol = new J.DefaultObjectLayerFilter(this.jolt.GetObjectLayerPairFilter(), LAYER_DYNAMIC)
    const eb = excludeBodyId != null ? this._getBody(excludeBodyId) : null
    const bf = eb ? new J.IgnoreSingleBodyFilter(eb.GetID()) : new J.BodyFilter()
    const sf = new J.ShapeFilter()
    this.physicsSystem.GetNarrowPhaseQuery().CastRay(ray, rs, col, bp, ol, bf, sf)
    let result
    if (col.HadHit()) {
      const dist = col.get_mHit().mFraction * maxDistance
      result = { hit: true, distance: dist, body: null, position: [origin[0]+dir[0]*dist, origin[1]+dir[1]*dist, origin[2]+dir[2]*dist] }
    } else result = { hit: false, distance: maxDistance, body: null, position: null }
    J.destroy(ray); J.destroy(rs); J.destroy(col); J.destroy(bp); J.destroy(ol); J.destroy(bf); J.destroy(sf)
    return result
  }

  destroy() {
    if (!this.Jolt) return
    this._charMgr.destroy()
    for (const [id] of this.bodies) this.removeBody(id)
    const J = this.Jolt
    if (this._tmpVec3) { J.destroy(this._tmpVec3); this._tmpVec3 = null }
    if (this._tmpRVec3) { J.destroy(this._tmpRVec3); this._tmpRVec3 = null }
    if (this._bulkOutP) { J.destroy(this._bulkOutP); this._bulkOutP = null }
    if (this._bulkOutR) { J.destroy(this._bulkOutR); this._bulkOutR = null }
    if (this._bulkOutLV) { J.destroy(this._bulkOutLV); this._bulkOutLV = null }
    if (this._bulkOutAV) { J.destroy(this._bulkOutAV); this._bulkOutAV = null }
    if (this.jolt) { J.destroy(this.jolt); this.jolt = null }
    this.physicsSystem = null; this.bodyInterface = null
  }
}
