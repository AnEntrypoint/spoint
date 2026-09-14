import { extractMeshFromGLB, extractMeshFromGLBAsync, extractAllVerticesFromGLBAsync } from '../physics/GLBLoader.js'
import { MSG } from '../protocol/MessageTypes.js'

function motionType(ent) {
  return ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
}

export function resolveCCD(ent, mt) {
  const policy = ent._ccdPolicy
  if (policy === 'always') return true
  if (policy === 'off') return false
  return mt === 'dynamic'
}

function registerBody(ent, runtime, bid, mt) {
  ent._physicsBodyId = bid
  ent._bodyActive = true
  ent._bodyCreatedTick = runtime.currentTick
  runtime._physicsBodyToEntityId?.set(bid, ent.id)
  if (mt === 'dynamic') runtime._activeDynamicIds?.add(ent.id)
}

function fallbackBox(ent, runtime, mt) {
  ent.collider = { type: 'box', size: [0.5, 0.5, 0.5] }
  const ccd = resolveCCD(ent, mt)
  if (mt === 'dynamic') ent._bodyDef = { shapeType: 'box', params: [0.5, 0.5, 0.5], motionType: mt, opts: { mass: ent.mass, linearCast: ccd } }
  if (runtime._physics) {
    const bid = runtime._physics.addBody('box', [0.5, 0.5, 0.5], ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: ccd })
    registerBody(ent, runtime, bid, mt)
  }
}

async function _addTrimeshColliderImpl(ent, runtime) {
  ent.collider = { type: 'trimesh', model: ent.model }
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (isNode && ent.model && runtime._physics) {
    const sc = ent.scale || [1, 1, 1]
    try {
      const bid = await runtime._physics.addStaticTrimeshAsync(runtime.resolveAssetPath(ent.model), 0, ent.position, sc, ent.rotation || [0, 0, 0, 1])
      if (bid != null) { const deferOrRun = runtime._deferOrRun ? runtime._deferOrRun.bind(runtime) : (fn => fn()); deferOrRun(() => { if (!runtime.entities?.has?.(ent.id)) return; registerBody(ent, runtime, bid, 'static') }) }
    } catch (err) {
      console.warn(`[physics] ${ent.model}: trimesh build failed (${err.message}), using box fallback`)
      runtime._debug?.warn?.(`[physics] ${ent.model}: trimesh build failed (${err.message}), using box fallback`)
      runtime._log?.('app_error', { label: `addTrimeshCollider(${ent.model})`, message: err.message }, { sourceEntity: ent.id })
      const deferOrRun = runtime._deferOrRun ? runtime._deferOrRun.bind(runtime) : (fn => fn())
      deferOrRun(() => {
        if (!runtime.entities?.has?.(ent.id)) return
        fallbackBox(ent, runtime, 'static')
        runtime._connections?.broadcast?.(MSG.EDITOR_ERROR, { message: `PLACE_MODEL: trimesh build failed for ${ent.model}, using box collider fallback`, entityId: ent.id, detail: err.message })
      })
    }
  } else if (runtime._pendingTrimeshEntities) {
    runtime._pendingTrimeshEntities.set(ent.id, ent)
  }
}

export function buildPhysicsAPI(ent, runtime) {
  const api = {
    setInteractable: (radius = 3) => { ent._interactable = true; ent._interactRadius = radius; runtime._interactableIds?.add(ent.id) },
    setStatic: (v) => { ent.bodyType = v ? 'static' : ent.bodyType; if (v) runtime._dynamicEntityIds?.delete(ent.id) },
    setDynamic: (v) => { ent.bodyType = v ? 'dynamic' : ent.bodyType; if (v) runtime._dynamicEntityIds?.add(ent.id) },
    setKinematic: (v) => { ent.bodyType = v ? 'kinematic' : ent.bodyType; if (v) runtime._dynamicEntityIds?.add(ent.id) },
    setMass: (v) => { ent.mass = v },
    setLinearDamping: (v) => { ent._linearDamping = v },
    setAngularDamping: (v) => { ent._angularDamping = v },
    setCCDPolicy: (v) => { ent._ccdPolicy = (v === 'always' || v === 'off') ? v : 'auto' },
    addBoxCollider: (s, shapeKey) => {
      ent.collider = { type: 'box', size: s }
      const rawHe = Array.isArray(s) ? s : [s, s, s]
      const sc = ent.scale || [1, 1, 1]
      const he = [rawHe[0] * sc[0], rawHe[1] * sc[1], rawHe[2] * sc[2]]
      const mt = motionType(ent)
      const bodyOpts = { mass: ent.mass, linearDamping: ent._linearDamping, angularDamping: ent._angularDamping, linearCast: resolveCCD(ent, mt) }
      if (shapeKey) bodyOpts.shapeKey = shapeKey
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'box', params: he, motionType: mt, opts: bodyOpts }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('box', he, ent.position, mt, { rotation: ent.rotation, ...bodyOpts })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addSphereCollider: (r) => {
      ent.collider = { type: 'sphere', radius: r }
      const sc = ent.scale || [1, 1, 1]
      const sr = r * Math.max(sc[0], sc[1], sc[2])
      const mt = motionType(ent)
      const ccd = resolveCCD(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'sphere', params: sr, motionType: mt, opts: { mass: ent.mass, linearCast: ccd } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('sphere', sr, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: ccd })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addCapsuleCollider: (r, h) => {
      ent.collider = { type: 'capsule', radius: r, height: h }
      const sc = ent.scale || [1, 1, 1]
      const uniformS = Math.max(sc[0], sc[1], sc[2])
      const sr = r * uniformS, sh = h * uniformS
      const mt = motionType(ent)
      const ccd = resolveCCD(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'capsule', params: [sr, sh / 2], motionType: mt, opts: { mass: ent.mass, linearCast: ccd } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('capsule', [sr, sh / 2], ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: ccd })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addTrimeshCollider: () => {
      const p = _addTrimeshColliderImpl(ent, runtime)
      if (runtime.trackTrimeshBuild) runtime.trackTrimeshBuild(p)
      return p
    },
    addConvexCollider: (points) => {
      ent.collider = { type: 'convex', points }
      const mt = motionType(ent)
      const ccd = resolveCCD(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, linearCast: ccd } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: ccd })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addConvexFromModel: (meshIndex = 0) => {
      if (!ent.model) return
      try {
        const mesh = extractMeshFromGLB(runtime.resolveAssetPath(ent.model), meshIndex)
        const sc = ent.scale || [1, 1, 1]
        const raw = mesh.vertices
        const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
        ent.collider = { type: 'convex', points }
        if (runtime._physics) {
          const mt = motionType(ent)
          const ccd = resolveCCD(ent, mt)
          if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, shapeKey: ent.model, linearCast: ccd } }
          const bid = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, shapeKey: ent.model, linearCast: ccd })
          registerBody(ent, runtime, bid, mt)
        }
      } catch (err) {
        if (err.message.includes('Draco-compressed') || err.message.includes('Meshopt-compressed')) {
          runtime._debug?.warn(`[physics] ${err.message.includes('Draco') ? 'Draco' : 'Meshopt'} mesh detected - use addConvexFromModelAsync()/addTrimeshCollider() for physics or box/sphere/capsule for trigger`)
          fallbackBox(ent, runtime, motionType(ent))
        } else {
          throw err
        }
      }
    },
    addConvexFromModelAsync: async (meshIndex = -1, shapeKeyOverride) => {
      if (!ent.model) return
      const mt = motionType(ent)
      let mesh
      try {
        mesh = meshIndex >= 0
          ? await extractMeshFromGLBAsync(runtime.resolveAssetPath(ent.model), meshIndex)
          : await extractAllVerticesFromGLBAsync(runtime.resolveAssetPath(ent.model))
      } catch (err) {
        console.warn(`[physics] ${ent.model}: mesh extraction failed (${err.message}), using box fallback`)
        fallbackBox(ent, runtime, mt)
        return
      }
      const sc = ent.scale || [1, 1, 1]
      const raw = mesh.vertices
      const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
      ent.collider = { type: 'convex', points }
      const shapeKey = shapeKeyOverride || ent.model
      if (runtime._physics) {
        const ccd = resolveCCD(ent, mt)
        if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, shapeKey, linearCast: ccd } }
        try {
          const bid = await runtime._physics.addConvexBodyAsync(points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, shapeKey, linearCast: ccd })
          registerBody(ent, runtime, bid, mt)
        } catch (err) {
          console.warn(`[physics] ${ent.model}: convex shape build failed (${err.message}), using box fallback`)
          fallbackBox(ent, runtime, mt)
        }
      }
    },
    addColliderFromConfig: (cfg = {}) => {
      const type = cfg.type || 'box'
      const p = api
      if (cfg.mass !== undefined) p.setMass(cfg.mass)
      if (cfg.linearDamping !== undefined) p.setLinearDamping(cfg.linearDamping)
      if (cfg.angularDamping !== undefined) p.setAngularDamping(cfg.angularDamping)
      if (cfg.ccd !== undefined) p.setCCDPolicy(cfg.ccd)
      if (cfg.dynamic) p.setDynamic(true)
      else if (cfg.kinematic) p.setKinematic(true)
      else p.setStatic(true)
      if (type === 'box') p.addBoxCollider(cfg.size || [cfg.hx ?? 0.5, cfg.hy ?? 0.5, cfg.hz ?? 0.5], cfg.shapeKey)
      else if (type === 'sphere') p.addSphereCollider(cfg.radius ?? 0.5)
      else if (type === 'capsule') p.addCapsuleCollider(cfg.radius ?? 0.3, cfg.height ?? 1.8)
      else if (type === 'convex') return p.addConvexFromModelAsync(cfg.meshIndex ?? -1, cfg.shapeKey)
      else if (type === 'trimesh') return p.addTrimeshCollider()
    },
    addForce: (f) => {
      if (runtime._physics && ent._physicsBodyId !== undefined) {
        runtime._physics.addImpulse(ent._physicsBodyId, f)
      } else {
        const mass = ent.mass || 1
        ent.velocity[0] += f[0] / mass; ent.velocity[1] += f[1] / mass; ent.velocity[2] += f[2] / mass
      }
    },
    setVelocity: (v) => {
      if (runtime._physics && ent._physicsBodyId !== undefined) runtime._physics.setBodyVelocity(ent._physicsBodyId, v)
      ent.velocity = [...v]
    },
    setPosition: (p) => {
      if (runtime._physics && ent._physicsBodyId !== undefined) {
        runtime._physics.setBodyPosition(ent._physicsBodyId, p)
        runtime._physics.setBodyVelocity(ent._physicsBodyId, [0, 0, 0])
        runtime._physics.setBodyAngularVelocity?.(ent._physicsBodyId, [0, 0, 0])
      }
      ent.position = [...p]
    },
    getVelocity: () => (runtime._physics && ent._physicsBodyId !== undefined) ? runtime._physics.getBodyVelocity(ent._physicsBodyId) : [...(ent.velocity || [0,0,0])],
    getAngularVelocity: () => (runtime._physics && ent._physicsBodyId !== undefined) ? (runtime._physics.getBodyAngularVelocity?.(ent._physicsBodyId) || [0,0,0]) : [0,0,0],
    getRotation: () => (runtime._physics && ent._physicsBodyId !== undefined) ? (runtime._physics.getBodyRotation?.(ent._physicsBodyId) || [...ent.rotation]) : [...ent.rotation],
    isAtRest: (eps = 0.05) => {
      const v = api.getVelocity(), a = api.getAngularVelocity()
      return (v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) < eps*eps && (a[0]*a[0]+a[1]*a[1]+a[2]*a[2]) < eps*eps
    },
    tiltFromUpright: () => {
      const q = api.getRotation()
      const x=q[0], y=q[1], z=q[2], w=q[3]
      const upY = 1 - 2*(x*x + z*z)
      return Math.acos(Math.max(-1, Math.min(1, upY)))
    },
    setFriction: (f) => (runtime._physics && ent._physicsBodyId !== undefined) ? !!runtime._physics.setBodyFriction?.(ent._physicsBodyId, f) : false,
    setRestitution: (r) => (runtime._physics && ent._physicsBodyId !== undefined) ? !!runtime._physics.setBodyRestitution?.(ent._physicsBodyId, r) : false,
    setMotionType: (motionType) => {
      if (!runtime._physics || ent._physicsBodyId === undefined) return false
      if (motionType !== 'dynamic' && motionType !== 'kinematic' && motionType !== 'static') return false
      if (typeof runtime._physics.setBodyMotionType !== 'function') return false
      if (motionType !== 'dynamic') runtime._physics.setBodyVelocity?.(ent._physicsBodyId, [0, 0, 0])
      const ok = runtime._physics.setBodyMotionType(ent._physicsBodyId, motionType)
      if (ok) {
        ent.bodyType = motionType
        if (ent._bodyDef) ent._bodyDef.motionType = motionType
        if (motionType === 'static') runtime._activeDynamicIds?.delete(ent.id)
        else runtime._activeDynamicIds?.add(ent.id)
      }
      return ok
    },
    getMotionType: () => ent.bodyType || 'static',
    getBodyId: () => (ent._physicsBodyId !== undefined ? ent._physicsBodyId : null),
    createVehicle: (wheelDefs, opts) => runtime.createVehicleForEntity?.(ent.id, wheelDefs, opts) ?? null,
    setVehicleInput: (forward, right, brake, handbrake) => runtime.setEntityVehicleDriverInput?.(ent.id, forward, right, brake, handbrake) ?? false,
    createTrackedVehicle: (wheelDefs, opts) => runtime.createTrackedVehicleForEntity?.(ent.id, wheelDefs, opts) ?? null,
    setTrackedVehicleInput: (forward, leftRatio, rightRatio, brake) => runtime.setEntityTrackedVehicleDriverInput?.(ent.id, forward, leftRatio, rightRatio, brake) ?? false,
    getVehicleWheelTransform: (wheelIndex) => runtime.getEntityVehicleWheelTransform?.(ent.id, wheelIndex) ?? null,
    getVehicleWheelState: (wheelIndex) => runtime.getEntityVehicleWheelState?.(ent.id, wheelIndex) ?? null,
    hasVehicle: () => ent._vehicleId != null,
    destroyVehicle: () => runtime.destroyVehicleForEntity?.(ent.id) ?? false,
  }
  return api
}
