import initJolt from 'jolt-physics/wasm-compat'
import { extractMeshFromGLB, extractMeshFromGLBAsync, extractAllMeshesFromGLBAsync } from './GLBLoader.js'
import { CharacterController } from './CharacterController.js'
const LAYER_STATIC = 0, LAYER_DYNAMIC = 1, NUM_LAYERS = 2
let joltInstance = null
async function getJolt() { if (!joltInstance) joltInstance = await initJolt(); return joltInstance }
export class PhysicsWorld {
  constructor(config = {}) {
    this.gravity = config.gravity || [0, -9.81, 0]; this.crouchHalfHeight = config.crouchHalfHeight || 0.45
    this.Jolt = null; this.jolt = null; this.physicsSystem = null; this.bodyInterface = null
    this.bodies = new Map(); this.bodyMeta = new Map(); this.bodyIds = new Map()
    this._char = new CharacterController(this); this._shapeCache = new Map()
    this._tmpVec3 = null; this._tmpRVec3 = null; this._bulkOutP = null; this._bulkOutR = null; this._bulkOutLV = null; this._bulkOutAV = null
  }
  async init() {
    const J = await getJolt(); this.Jolt = J; const settings = new J.JoltSettings()
    const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS); objFilter.EnableCollision(LAYER_STATIC, LAYER_DYNAMIC); objFilter.EnableCollision(LAYER_DYNAMIC, LAYER_DYNAMIC)
    const bpI = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, 2); bpI.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(0)); bpI.MapObjectToBroadPhaseLayer(LAYER_DYNAMIC, new J.BroadPhaseLayer(1))
    const ovbp = new J.ObjectVsBroadPhaseLayerFilterTable(bpI, 2, objFilter, NUM_LAYERS)
    settings.mObjectLayerPairFilter = objFilter; settings.mBroadPhaseLayerInterface = bpI; settings.mObjectVsBroadPhaseLayerFilter = ovbp
    this.jolt = new J.JoltInterface(settings); J.destroy(settings)
    this.physicsSystem = this.jolt.GetPhysicsSystem(); this.bodyInterface = this.physicsSystem.GetBodyInterface()
    this._tmpVec3 = new J.Vec3(0, 0, 0); this._tmpRVec3 = new J.RVec3(0, 0, 0); this._bulkOutP = new J.RVec3(0, 0, 0); this._bulkOutR = new J.Quat(0, 0, 0, 1); this._bulkOutLV = new J.Vec3(0, 0, 0); this._bulkOutAV = new J.Vec3(0, 0, 0)
    this.physicsSystem.SetGravity(new J.Vec3(this.gravity[0], this.gravity[1], this.gravity[2]))
    this._heap32 = new Int32Array(J.HEAP8.buffer); this._activationListener = new J.BodyActivationListenerJS()
    this._activationListener.OnBodyActivated = (p) => { if (this.onBodyActivated) this.onBodyActivated(this._heap32[p >> 2]) }
    this._activationListener.OnBodyDeactivated = (p) => { if (this.onBodyDeactivated) this.onBodyDeactivated(this._heap32[p >> 2]) }
    this.physicsSystem.SetBodyActivationListener(this._activationListener); return this
  }
  _addBody(shape, position, motionType, layer, opts = {}) {
    const J = this.Jolt, pos = new J.RVec3(position[0], position[1], position[2]), rot = opts.rotation ? new J.Quat(...opts.rotation) : new J.Quat(0, 0, 0, 1), cs = new J.BodyCreationSettings(shape, pos, rot, motionType, layer)
    if (opts.mass) { cs.mMassPropertiesOverride.mMass = opts.mass; cs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia }
    if (opts.friction !== undefined) cs.mFriction = opts.friction; if (opts.restitution !== undefined) cs.mRestitution = opts.restitution
    const body = this.bodyInterface.CreateBody(cs); this.bodyInterface.AddBody(body.GetID(), motionType === J.EMotionType_Static ? J.EActivation_DontActivate : J.EActivation_Activate)
    const id = body.GetID().GetIndexAndSequenceNumber(); this.bodies.set(id, body); this.bodyMeta.set(id, opts.meta || {}); this.bodyIds.set(id, body.GetID()); J.destroy(cs); return id
  }
  addBody(type, params, pos, mt, opts = {}) {
    const J = this.Jolt; let s, layer = mt === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, mot = mt === 'dynamic' ? J.EMotionType_Dynamic : mt === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    if (type === 'box') s = new J.BoxShape(new J.Vec3(params[0], params[1], params[2]), 0.001, null); else if (type === 'sphere') s = new J.SphereShape(params); else if (type === 'capsule') s = new J.CapsuleShape(params[1], params[0])
    else if (type === 'convex') {
      if (opts.shapeKey && this._shapeCache.has(opts.shapeKey)) s = this._shapeCache.get(opts.shapeKey); else {
        const pts = new J.VertexList(), f3 = new J.Float3(0, 0, 0); for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i + 1]; f3.z = params[i + 2]; pts.push_back(f3) }
        const cvx = new J.ConvexHullShapeSettings(); cvx.set_mPoints(pts); const res = cvx.Create(); s = res.Get(); J.destroy(f3); J.destroy(pts); J.destroy(cvx); if (opts.shapeKey) this._shapeCache.set(opts.shapeKey, s); else J.destroy(res)
      }
    } else return null; return this._addBody(s, pos, mot, layer, { ...opts, meta: { type: mt, shape: type } })
  }
  async addStaticTrimeshAsync(path, idx, pos) {
    const J = this.Jolt, mesh = await extractAllMeshesFromGLBAsync(path), tris = new J.TriangleList(), f3 = new J.Float3(0, 0, 0); tris.resize(mesh.triangleCount)
    for (let t = 0; t < mesh.triangleCount; t++) { const tri = tris.at(t); for (let v = 0; v < 3; v++) { const i = mesh.indices[t * 3 + v]; f3.x = mesh.vertices[i * 3]; f3.y = mesh.vertices[i * 3 + 1]; f3.z = mesh.vertices[i * 3 + 2]; tri.set_mV(v, f3) } }
    const set = new J.MeshShapeSettings(tris), res = set.Create(), s = res.Get(); J.destroy(f3); J.destroy(tris); J.destroy(set); const id = this._addBody(s, pos || [0,0,0], J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'trimesh', triangles: mesh.triangleCount } }); J.destroy(res); return id
  }
  addPlayerCharacter(r, h, p, m) { return this._char.add(r, h, p, m) }
  updateCharacter(id, dt) { this._char.update(id, dt) }
  getCharacterPosition(id, out) { this._char.getPosition(id, out) }
  getCharacterVelocity(id, out) { this._char.getVelocity(id, out) }
  setCharacterVelocity(id, x, y, z) { this._char.setVelocity(id, x, y, z) }
  setCharacterPosition(id, x, y, z) { this._char.setPosition(id, x, y, z) }
  getCharacterGroundState(id) { return this._char.getGroundState(id) }
  setCharacterCrouch(id, is) { this._char.setCrouch(id, is) }
  removeCharacter(id) { this._char.remove(id) }
  isBodyActive(id) { const b = this.bodies.get(id); return b ? b.IsActive() : false }
  syncDynamicBody(bid, e) {
    const b = this.bodies.get(bid); if (!b || !b.IsActive()) return false; this.bodyInterface.GetPositionAndRotation(this.bodyIds.get(bid), this._bulkOutP, this._bulkOutR); this.bodyInterface.GetLinearAndAngularVelocity(this.bodyIds.get(bid), this._bulkOutLV, this._bulkOutAV)
    e.position[0] = this._bulkOutP.GetX(); e.position[1] = this._bulkOutP.GetY(); e.position[2] = this._bulkOutP.GetZ(); e.rotation[0] = this._bulkOutR.GetX(); e.rotation[1] = this._bulkOutR.GetY(); e.rotation[2] = this._bulkOutR.GetZ(); e.rotation[3] = this._bulkOutR.GetW(); e.velocity[0] = this._bulkOutLV.GetX(); e.velocity[1] = this._bulkOutLV.GetY(); e.velocity[2] = this._bulkOutLV.GetZ(); return true
  }
  setBodyPosition(id, p) { const b = this.bodies.get(id); if (b) { const v = this._tmpRVec3; v.Set(p[0], p[1], p[2]); this.bodyInterface.SetPosition(b.GetID(), v, this.Jolt.EActivation_Activate) } }
  setBodyVelocity(id, p) { const b = this.bodies.get(id); if (b) { const v = this._tmpVec3; v.Set(p[0], p[1], p[2]); this.bodyInterface.SetLinearVelocity(b.GetID(), v) } }
  removeBody(id) { const b = this.bodies.get(id); if (b) { this.bodyInterface.RemoveBody(b.GetID()); this.bodyInterface.DestroyBody(b.GetID()); this.bodies.delete(id); this.bodyMeta.delete(id); this.bodyIds.delete(id) } }
  step(dt) { if (this.jolt) this.jolt.Step(dt, dt > 1 / 55 ? 2 : 1) }
  raycast(o, d, max, exc) {
    if (!this.physicsSystem) return { hit: false, distance: max }; const J = this.Jolt, l = Math.hypot(d[0], d[1], d[2]), n = l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : d
    const ray = new J.RRayCast(new J.RVec3(o[0], o[1], o[2]), new J.Vec3(n[0] * max, n[1] * max, n[2] * max)), rs = new J.RayCastSettings(), col = new J.CastRayClosestHitCollisionCollector()
    const bp = new J.DefaultBroadPhaseLayerFilter(this.jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_DYNAMIC), ol = new J.DefaultObjectLayerFilter(this.jolt.GetObjectLayerPairFilter(), LAYER_DYNAMIC), eb = exc != null ? this.bodies.get(exc) : null, bf = eb ? new J.IgnoreSingleBodyFilter(eb.GetID()) : new J.BodyFilter()
    this.physicsSystem.GetNarrowPhaseQuery().CastRay(ray, rs, col, bp, ol, bf, new J.ShapeFilter()); let res = col.HadHit() ? { hit: true, distance: col.get_mHit().mFraction * max, body: null, position: [o[0] + n[0] * col.get_mHit().mFraction * max, o[1] + n[1] * col.get_mHit().mFraction * max, o[2] + n[2] * col.get_mHit().mFraction * max] } : { hit: false, distance: max }; J.destroy(ray); J.destroy(rs); J.destroy(col); J.destroy(bp); J.destroy(ol); J.destroy(bf); return res
  }
  destroy() { this._char.destroy(); for (const [id] of this.bodies) this.removeBody(id); if (this.jolt) this.Jolt.destroy(this.jolt); this.physicsSystem = null; this.bodyInterface = null }
}
