import initJolt from 'jolt-physics/wasm-compat'
import { extractMeshFromGLB, extractMeshFromGLBAsync, extractAllMeshesFromGLBAsync } from './GLBLoader.js'
const LAYER_STATIC = 0, LAYER_DYNAMIC = 1, NUM_LAYERS = 2
let joltInstance = null
async function getJolt() { if (!joltInstance) joltInstance = await initJolt(); return joltInstance }
export class PhysicsWorld {
  constructor(config = {}) {
    this.gravity = config.gravity || [0, -9.81, 0]
    this.crouchHalfHeight = config.crouchHalfHeight || 0.45
    this.Jolt = null; this.jolt = null; this.physicsSystem = null; this.bodyInterface = null
    this.bodies = new Map(); this.bodyMeta = new Map(); this.bodyIds = new Map()
    this._objFilter = null; this._ovbp = null
    this._charShapes = new Map()
    this._shapeCache = new Map()
    this._convexQueue = Promise.resolve()
    this._tmpVec3 = null; this._tmpRVec3 = null
    this._bulkOutP = null; this._bulkOutR = null; this._bulkOutLV = null; this._bulkOutAV = null
  }
  async init() {
    const J = await getJolt()
    this.Jolt = J
    const settings = new J.JoltSettings()
    const objFilter = new J.ObjectLayerPairFilterTable(NUM_LAYERS)
    objFilter.EnableCollision(LAYER_STATIC, LAYER_DYNAMIC); objFilter.EnableCollision(LAYER_DYNAMIC, LAYER_DYNAMIC)
    const bpI = new J.BroadPhaseLayerInterfaceTable(NUM_LAYERS, 2)
    bpI.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(0))
    bpI.MapObjectToBroadPhaseLayer(LAYER_DYNAMIC, new J.BroadPhaseLayer(1))
    const ovbp = new J.ObjectVsBroadPhaseLayerFilterTable(bpI, 2, objFilter, NUM_LAYERS)
    settings.mObjectLayerPairFilter = objFilter; settings.mBroadPhaseLayerInterface = bpI
    settings.mObjectVsBroadPhaseLayerFilter = ovbp
    this._objFilter = objFilter; this._ovbp = ovbp
    this.jolt = new J.JoltInterface(settings); J.destroy(settings)
    this.physicsSystem = this.jolt.GetPhysicsSystem(); this.bodyInterface = this.physicsSystem.GetBodyInterface()
    this._tmpVec3 = new J.Vec3(0, 0, 0); this._tmpRVec3 = new J.RVec3(0, 0, 0)
    this._bulkOutP = new J.RVec3(0, 0, 0); this._bulkOutR = new J.Quat(0, 0, 0, 1)
    this._bulkOutLV = new J.Vec3(0, 0, 0); this._bulkOutAV = new J.Vec3(0, 0, 0)
    const [gx, gy, gz] = this.gravity
    this.physicsSystem.SetGravity(new J.Vec3(gx, gy, gz))
    this._heap32 = new Int32Array(J.HEAP8.buffer)
    this._activationListener = new J.BodyActivationListenerJS()
    this._activationListener.OnBodyActivated = (bodyIdPtr) => {
      const seq = this._heap32[bodyIdPtr >> 2]
      if (this.onBodyActivated) this.onBodyActivated(seq)
    }
    this._activationListener.OnBodyDeactivated = (bodyIdPtr) => {
      const seq = this._heap32[bodyIdPtr >> 2]
      if (this.onBodyDeactivated) this.onBodyDeactivated(seq)
    }
    this.physicsSystem.SetBodyActivationListener(this._activationListener)
    return this
  }
  _addBody(shape, position, motionType, layer, opts = {}) {
    const J = this.Jolt
    const pos = new J.RVec3(position[0], position[1], position[2])
    const rot = opts.rotation ? new J.Quat(...opts.rotation) : new J.Quat(0, 0, 0, 1)
    const cs = new J.BodyCreationSettings(shape, pos, rot, motionType, layer)
    if (opts.mass) { cs.mMassPropertiesOverride.mMass = opts.mass; cs.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia }
    if (opts.friction !== undefined) cs.mFriction = opts.friction
    if (opts.restitution !== undefined) cs.mRestitution = opts.restitution
    if (opts.linearDamping !== undefined) cs.mLinearDamping = opts.linearDamping
    if (opts.angularDamping !== undefined) cs.mAngularDamping = opts.angularDamping
    const activate = motionType === J.EMotionType_Static ? J.EActivation_DontActivate : J.EActivation_Activate
    const body = this.bodyInterface.CreateBody(cs); this.bodyInterface.AddBody(body.GetID(), activate)
    J.destroy(cs)
    const id = body.GetID().GetIndexAndSequenceNumber()
    this.bodies.set(id, body); this.bodyMeta.set(id, opts.meta || {})
    this.bodyIds.set(id, body.GetID())
    return id
  }
  addStaticBox(halfExtents, position, rotation) {
    const J = this.Jolt
    const shape = new J.BoxShape(new J.Vec3(halfExtents[0], halfExtents[1], halfExtents[2]), 0.05, null)
    return this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { rotation, meta: { type: 'static', shape: 'box' } })
  }
  addBody(shapeType, params, position, motionType, opts = {}) {
    const J = this.Jolt
    let shape, layer
    if (shapeType === 'box') shape = new J.BoxShape(new J.Vec3(params[0], params[1], params[2]), 0.001, null)
    else if (shapeType === 'sphere') shape = new J.SphereShape(params)
    else if (shapeType === 'capsule') shape = new J.CapsuleShape(params[1], params[0])
    else if (shapeType === 'convex') {
      const cacheKey = opts.shapeKey || null
      let shape
      if (cacheKey && this._shapeCache.has(cacheKey)) {
        shape = this._shapeCache.get(cacheKey)
      } else {
        const pts = new J.VertexList()
        const f3 = new J.Float3(0, 0, 0)
        for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i + 1]; f3.z = params[i + 2]; pts.push_back(f3) }
        J.destroy(f3)
        const cvx = new J.ConvexHullShapeSettings()
        cvx.set_mPoints(pts)
        const shapeResult = cvx.Create()
        shape = shapeResult.Get()
        J.destroy(pts); J.destroy(cvx)
        if (cacheKey) this._shapeCache.set(cacheKey, shape)
        else J.destroy(shapeResult)
      }
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      const layer2 = motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC
      return this._addBody(shape, position, mt, layer2, { ...opts, meta: { type: motionType, shape: shapeType } })
    }
    else return null
    const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
    layer = motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC
    return this._addBody(shape, position, mt, layer, { ...opts, meta: { type: motionType, shape: shapeType } })
  }
  addConvexBodyAsync(params, position, motionType, opts = {}) {
    const J = this.Jolt
    const cacheKey = opts.shapeKey || null
    if (cacheKey && this._shapeCache.has(cacheKey)) {
      const shape = this._shapeCache.get(cacheKey)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return Promise.resolve(this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } }))
    }
    const work = () => {
      const pts = new J.VertexList()
      const f3 = new J.Float3(0, 0, 0)
      for (let i = 0; i < params.length; i += 3) { f3.x = params[i]; f3.y = params[i + 1]; f3.z = params[i + 2]; pts.push_back(f3) }
      J.destroy(f3)
      const cvx = new J.ConvexHullShapeSettings()
      cvx.set_mPoints(pts)
      const shapeResult = cvx.Create()
      const shape = shapeResult.Get()
      J.destroy(pts); J.destroy(cvx)
      if (cacheKey) this._shapeCache.set(cacheKey, shape)
      else J.destroy(shapeResult)
      const mt = motionType === 'dynamic' ? J.EMotionType_Dynamic : motionType === 'kinematic' ? J.EMotionType_Kinematic : J.EMotionType_Static
      return this._addBody(shape, position, mt, motionType === 'static' ? LAYER_STATIC : LAYER_DYNAMIC, { ...opts, meta: { type: motionType, shape: 'convex' } })
    }
    const result = this._convexQueue.then(work)
    this._convexQueue = result.then(() => {}, () => {})
    return result
  }
  addStaticTrimesh(glbPath, meshIndex = 0) {
    const J = this.Jolt
    const mesh = extractMeshFromGLB(glbPath, meshIndex)
    
    // Apply node transform if present (scale, rotation, translation)
    let vertices = mesh.vertices
    const nodeT = mesh.nodeTransform
    if (nodeT) {
      const numVerts = mesh.vertexCount
      vertices = new Float32Array(numVerts * 3)
      
      const scale = nodeT.scale || [1, 1, 1]
      const translation = nodeT.translation || [0, 0, 0]
      const rotation = nodeT.rotation
      
      for (let i = 0; i < numVerts; i++) {
        let x = mesh.vertices[i * 3] * scale[0]
        let y = mesh.vertices[i * 3 + 1] * scale[1]
        let z = mesh.vertices[i * 3 + 2] * scale[2]
        
        if (rotation) {
          const [qx, qy, qz, qw] = rotation
          const ix = qw * x + qy * z - qz * y
          const iy = qw * y + qz * x - qx * z
          const iz = qw * z + qx * y - qy * x
          const iw = -qx * x - qy * y - qz * z
          x = ix * qw - iw * qx - iy * qz + iz * qy
          y = iy * qw - iw * qy - iz * qx + ix * qz
          z = iz * qw - iw * qz - ix * qy + iy * qx
        }
        
        vertices[i * 3] = x + translation[0]
        vertices[i * 3 + 1] = y + translation[1]
        vertices[i * 3 + 2] = z + translation[2]
      }
    }
    
    const triangles = new J.TriangleList(); triangles.resize(mesh.triangleCount)
    const f3 = new J.Float3(0, 0, 0)
    for (let t = 0; t < mesh.triangleCount; t++) {
      const tri = triangles.at(t)
      for (let v = 0; v < 3; v++) {
        const idx = mesh.indices[t * 3 + v]
        f3.x = vertices[idx * 3]; f3.y = vertices[idx * 3 + 1]; f3.z = vertices[idx * 3 + 2]
        tri.set_mV(v, f3)
      }
    }
    const settings = new J.MeshShapeSettings(triangles)
    const shapeResult = settings.Create()
    const shape = shapeResult.Get()
    J.destroy(f3); J.destroy(triangles); J.destroy(settings)
    const id = this._addBody(shape, [0, 0, 0], J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'trimesh', mesh: mesh.name, triangles: mesh.triangleCount } })
    J.destroy(shapeResult)
    return id
  }

  addStaticTrimeshAsync(glbPath, meshIndex = 0, position = [0, 0, 0], scale = [1, 1, 1]) {
    return new Promise(async (resolve, reject) => {
      try {
        const J = this.Jolt
        // Use combined extraction: all meshes + all primitives (handles Draco, multi-mesh maps)
        const mesh = await extractAllMeshesFromGLBAsync(glbPath)
        let { vertices, indices, triangleCount } = mesh

        if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) {
          for (let i = 0; i < vertices.length; i += 3) {
            vertices[i] *= scale[0]; vertices[i+1] *= scale[1]; vertices[i+2] *= scale[2]
          }
        }

        const triangles = new J.TriangleList(); triangles.resize(triangleCount)
        // Reuse a single Float3 to avoid WASM heap growth from per-vertex allocations
        const f3 = new J.Float3(0, 0, 0)
        for (let t = 0; t < triangleCount; t++) {
          const tri = triangles.at(t)
          for (let v = 0; v < 3; v++) {
            const idx = indices[t * 3 + v]
            f3.x = vertices[idx * 3]; f3.y = vertices[idx * 3 + 1]; f3.z = vertices[idx * 3 + 2]
            tri.set_mV(v, f3)
          }
        }
        const settings = new J.MeshShapeSettings(triangles)
        const shapeResult = settings.Create()
        const shape = shapeResult.Get()
        J.destroy(f3); J.destroy(triangles); J.destroy(settings)
        const id = this._addBody(shape, position, J.EMotionType_Static, LAYER_STATIC, { meta: { type: 'static', shape: 'trimesh', triangles: triangleCount } })
        J.destroy(shapeResult)
        resolve(id)
      } catch (e) {
        reject(e)
      }
    })
  }
  addPlayerCharacter(radius, halfHeight, position, mass) {
    const J = this.Jolt
    const cvs = new J.CharacterVirtualSettings()
    cvs.mMass = mass || 80
    cvs.mMaxSlopeAngle = 0.7854
    cvs.mShape = new J.CapsuleShape(halfHeight, radius)
    cvs.mBackFaceMode = J.EBackFaceMode_CollideWithBackFaces
    cvs.mCharacterPadding = 0.02
    cvs.mPenetrationRecoverySpeed = 1.0
    cvs.mPredictiveContactDistance = 0.1
    cvs.mSupportingVolume = new J.Plane(J.Vec3.prototype.sAxisY(), -radius)
    const pos = new J.RVec3(position[0], position[1], position[2])
    const ch = new J.CharacterVirtual(cvs, pos, J.Quat.prototype.sIdentity(), this.physicsSystem)
    J.destroy(cvs)
    if (!this._charFilters) {
      this._charFilters = {
        bp: new J.DefaultBroadPhaseLayerFilter(this.jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_DYNAMIC),
        ol: new J.DefaultObjectLayerFilter(this.jolt.GetObjectLayerPairFilter(), LAYER_DYNAMIC),
        body: new J.BodyFilter(),
        shape: new J.ShapeFilter()
      }
      this._charUpdateSettings = new J.ExtendedUpdateSettings()
      this._charUpdateSettings.mStickToFloorStepDown = new J.Vec3(0, -0.5, 0)
      this._charUpdateSettings.mWalkStairsStepUp = new J.Vec3(0, 0.4, 0)
      this._charGravity = new J.Vec3(this.gravity[0], this.gravity[1], this.gravity[2])
      this._tmpVec3 = new J.Vec3(0, 0, 0)
      this._tmpRVec3 = new J.RVec3(0, 0, 0)
    }
    const id = this._nextCharId = (this._nextCharId || 0) + 1
    if (!this.characters) this.characters = new Map()
    this.characters.set(id, ch)
    this._charShapes.set(id, { radius, standHeight: halfHeight, crouchHeight: this.crouchHalfHeight })
    return id
  }
  setCharacterCrouch(charId, isCrouching) {
    const data = this._charShapes.get(charId)
    if (!data) return
    const heightDiff = (data.standHeight - data.crouchHeight) * 0.5
    const ch = this.characters?.get(charId)
    if (!ch) return
    const pos = this.getCharacterPosition(charId)
    if (isCrouching) {
      pos[1] -= heightDiff
    } else {
      pos[1] += heightDiff
    }
    this.setCharacterPosition(charId, pos)
  }
  updateCharacter(charId, dt) {
    const ch = this.characters?.get(charId)
    if (!ch) return
    const f = this._charFilters
    ch.ExtendedUpdate(dt, this._charGravity, this._charUpdateSettings, f.bp, f.ol, f.body, f.shape, this.jolt.GetTempAllocator())
  }
  getCharacterPosition(charId) {
    const ch = this.characters?.get(charId); if (!ch) return [0, 0, 0]
    const p = ch.GetPosition()
    return [p.GetX(), p.GetY(), p.GetZ()]
  }
  readCharacterPosition(charId, out) {
    const ch = this.characters?.get(charId); if (!ch) return
    const p = ch.GetPosition()
    out[0] = p.GetX(); out[1] = p.GetY(); out[2] = p.GetZ()
  }
  getCharacterVelocity(charId) {
    const ch = this.characters?.get(charId); if (!ch) return [0, 0, 0]
    const v = ch.GetLinearVelocity()
    const r = [v.GetX(), v.GetY(), v.GetZ()]
    this.Jolt.destroy(v)
    return r
  }
  readCharacterVelocity(charId, out) {
    const ch = this.characters?.get(charId); if (!ch) return
    const v = ch.GetLinearVelocity()
    out[0] = v.GetX(); out[1] = v.GetY(); out[2] = v.GetZ()
    this.Jolt.destroy(v)
  }
  setCharacterVelocity(charId, velocity) {
    const ch = this.characters?.get(charId); if (!ch) return
    const v = this._tmpVec3; v.Set(velocity[0], velocity[1], velocity[2])
    ch.SetLinearVelocity(v)
  }
  setCharacterPosition(charId, position) {
    const ch = this.characters?.get(charId); if (!ch) return
    const p = this._tmpRVec3; p.Set(position[0], position[1], position[2])
    ch.SetPosition(p)
  }
  getCharacterGroundState(charId) {
    const ch = this.characters?.get(charId); if (!ch) return false
    return ch.GetGroundState() === this.Jolt.EGroundState_OnGround
  }
  removeCharacter(charId) {
    if (!this.characters) return
    const ch = this.characters.get(charId)
    if (ch) {
      this.Jolt.destroy(ch)
      this.characters.delete(charId)
    }
  }
  _getBody(bodyId) { return this.bodies.get(bodyId) }
  isBodyActive(bodyId) {
    const b = this._getBody(bodyId); if (!b) return false
    return b.IsActive()
  }
  syncDynamicBody(bodyId, entity) {
    const b = this._getBody(bodyId); if (!b) return false
    if (!b.IsActive()) return false
    const id = this.bodyIds.get(bodyId)
    const bi = this.bodyInterface
    bi.GetPositionAndRotation(id, this._bulkOutP, this._bulkOutR)
    bi.GetLinearAndAngularVelocity(id, this._bulkOutLV, this._bulkOutAV)
    entity.position[0] = this._bulkOutP.GetX(); entity.position[1] = this._bulkOutP.GetY(); entity.position[2] = this._bulkOutP.GetZ()
    entity.rotation[0] = this._bulkOutR.GetX(); entity.rotation[1] = this._bulkOutR.GetY(); entity.rotation[2] = this._bulkOutR.GetZ(); entity.rotation[3] = this._bulkOutR.GetW()
    entity.velocity[0] = this._bulkOutLV.GetX(); entity.velocity[1] = this._bulkOutLV.GetY(); entity.velocity[2] = this._bulkOutLV.GetZ()
    return true
  }
  getBodyPosition(bodyId) {
    const b = this._getBody(bodyId); if (!b) return [0, 0, 0]
    const p = this.bodyInterface.GetPosition(b.GetID())
    const r = [p.GetX(), p.GetY(), p.GetZ()]
    this.Jolt.destroy(p)
    return r
  }
  getBodyRotation(bodyId) {
    const b = this._getBody(bodyId); if (!b) return [0, 0, 0, 1]
    const q = this.bodyInterface.GetRotation(b.GetID())
    const r = [q.GetX(), q.GetY(), q.GetZ(), q.GetW()]
    this.Jolt.destroy(q)
    return r
  }
  getBodyVelocity(bodyId) {
    const b = this._getBody(bodyId); if (!b) return [0, 0, 0]
    const v = this.bodyInterface.GetLinearVelocity(b.GetID())
    const r = [v.GetX(), v.GetY(), v.GetZ()]
    this.Jolt.destroy(v)
    return r
  }
  setBodyPosition(bodyId, position) {
    const b = this._getBody(bodyId); if (!b) return
    const p = this._tmpRVec3 || new this.Jolt.RVec3(0, 0, 0); p.Set(position[0], position[1], position[2])
    this.bodyInterface.SetPosition(b.GetID(), p, this.Jolt.EActivation_Activate)
  }
  setBodyVelocity(bodyId, velocity) {
    const b = this._getBody(bodyId); if (!b) return
    const v = this._tmpVec3 || new this.Jolt.Vec3(0, 0, 0); v.Set(velocity[0], velocity[1], velocity[2])
    this.bodyInterface.SetLinearVelocity(b.GetID(), v)
  }
  addForce(bodyId, force) {
    const b = this._getBody(bodyId); if (!b) return
    const v = this._tmpVec3 || new this.Jolt.Vec3(0, 0, 0); v.Set(force[0], force[1], force[2])
    this.bodyInterface.AddForce(b.GetID(), v)
  }
  addImpulse(bodyId, impulse) {
    const b = this._getBody(bodyId); if (!b) return
    const v = this._tmpVec3 || new this.Jolt.Vec3(0, 0, 0); v.Set(impulse[0], impulse[1], impulse[2])
    this.bodyInterface.AddImpulse(b.GetID(), v)
  }
  step(deltaTime) { if (!this.jolt) return; this.jolt.Step(deltaTime, deltaTime > 1 / 55 ? 2 : 1) }
  removeBody(bodyId) {
    const b = this._getBody(bodyId); if (!b) return
    this.bodyInterface.RemoveBody(b.GetID()); this.bodyInterface.DestroyBody(b.GetID())
    this.bodies.delete(bodyId); this.bodyMeta.delete(bodyId); this.bodyIds.delete(bodyId)
  }
  raycast(origin, direction, maxDistance = 1000, excludeBodyId = null) {
    if (!this.physicsSystem) return { hit: false, distance: maxDistance, body: null, position: null }
    const J = this.Jolt
    const len = Math.hypot(direction[0], direction[1], direction[2])
    const dir = len > 0 ? [direction[0] / len, direction[1] / len, direction[2] / len] : direction
    const ray = new J.RRayCast(new J.RVec3(origin[0], origin[1], origin[2]), new J.Vec3(dir[0] * maxDistance, dir[1] * maxDistance, dir[2] * maxDistance))
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
      result = { hit: true, distance: dist, body: null, position: [origin[0] + dir[0] * dist, origin[1] + dir[1] * dist, origin[2] + dir[2] * dist] }
    } else { result = { hit: false, distance: maxDistance, body: null, position: null } }
    J.destroy(ray); J.destroy(rs); J.destroy(col); J.destroy(bp); J.destroy(ol); J.destroy(bf); J.destroy(sf)
    return result
  }
  destroy() {
    if (!this.Jolt) return
    const J = this.Jolt
    if (this.characters) {
      for (const ch of this.characters.values()) J.destroy(ch)
      this.characters.clear()
    }
    if (this._charFilters) {
      J.destroy(this._charFilters.bp)
      J.destroy(this._charFilters.ol)
      J.destroy(this._charFilters.body)
      J.destroy(this._charFilters.shape)
      this._charFilters = null
    }
    if (this._charUpdateSettings) { J.destroy(this._charUpdateSettings); this._charUpdateSettings = null }
    if (this._charGravity) { J.destroy(this._charGravity); this._charGravity = null }
    for (const [id] of this.bodies) this.removeBody(id)
    if (this._tmpVec3) { J.destroy(this._tmpVec3); this._tmpVec3 = null }
    if (this._tmpRVec3) { J.destroy(this._tmpRVec3); this._tmpRVec3 = null }
    if (this.jolt) { J.destroy(this.jolt); this.jolt = null }
    this.physicsSystem = null; this.bodyInterface = null
  }
}
