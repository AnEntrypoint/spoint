import { extractMeshFromGLB, extractMeshFromGLBAsync } from '../physics/GLBLoader.js'

function motionType(ent) {
  return ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
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
  if (mt === 'dynamic') ent._bodyDef = { shapeType: 'box', params: [0.5, 0.5, 0.5], motionType: mt, opts: { mass: ent.mass, linearCast: true } }
  if (runtime._physics) {
    const bid = runtime._physics.addBody('box', [0.5, 0.5, 0.5], ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: mt === 'dynamic' })
    registerBody(ent, runtime, bid, mt)
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
    addBoxCollider: (s) => {
      ent.collider = { type: 'box', size: s }
      const rawHe = Array.isArray(s) ? s : [s, s, s]
      const sc = ent.scale || [1, 1, 1]
      const he = [rawHe[0] * sc[0], rawHe[1] * sc[1], rawHe[2] * sc[2]]
      const mt = motionType(ent)
      const bodyOpts = { mass: ent.mass, linearDamping: ent._linearDamping, angularDamping: ent._angularDamping, linearCast: mt === 'dynamic' }
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
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'sphere', params: sr, motionType: mt, opts: { mass: ent.mass, linearCast: true } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('sphere', sr, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: mt === 'dynamic' })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addCapsuleCollider: (r, h) => {
      ent.collider = { type: 'capsule', radius: r, height: h }
      const sc = ent.scale || [1, 1, 1]
      const uniformS = Math.max(sc[0], sc[1], sc[2])
      const sr = r * uniformS, sh = h * uniformS
      const mt = motionType(ent)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'capsule', params: [sr, sh / 2], motionType: mt, opts: { mass: ent.mass, linearCast: true } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('capsule', [sr, sh / 2], ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: mt === 'dynamic' })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addTrimeshCollider: async () => {
      ent.collider = { type: 'trimesh', model: ent.model }
      if (runtime._physics && ent.model) {
        const sc = ent.scale || [1, 1, 1]
        const bid = await runtime._physics.addStaticTrimeshAsync(runtime.resolveAssetPath(ent.model), 0, ent.position, sc)
        ent._physicsBodyId = bid; runtime._physicsBodyToEntityId?.set(bid, ent.id)
      }
    },
    addConvexCollider: (points) => {
      ent.collider = { type: 'convex', points }
      const mt = motionType(ent)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, linearCast: true } }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, linearCast: mt === 'dynamic' })
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
          if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, shapeKey: ent.model, linearCast: true } }
          const bid = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, shapeKey: ent.model, linearCast: mt === 'dynamic' })
          registerBody(ent, runtime, bid, mt)
        }
      } catch (err) {
        if (err.message.includes('Draco-compressed')) {
          runtime._debug?.warn('[physics] Draco mesh detected - use addTrimeshCollider() for physics or box/sphere/capsule for trigger')
          fallbackBox(ent, runtime, motionType(ent))
        } else {
          throw err
        }
      }
    },
    addConvexFromModelAsync: async (meshIndex = 0) => {
      if (!ent.model) return
      const mt = motionType(ent)
      let mesh
      try {
        mesh = await extractMeshFromGLBAsync(runtime.resolveAssetPath(ent.model), meshIndex)
      } catch (err) {
        console.warn(`[physics] ${ent.model}: mesh extraction failed (${err.message}), using box fallback`)
        fallbackBox(ent, runtime, mt)
        return
      }
      const sc = ent.scale || [1, 1, 1]
      const raw = mesh.vertices
      const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
      ent.collider = { type: 'convex', points }
      if (runtime._physics) {
        if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts: { mass: ent.mass, shapeKey: ent.model, linearCast: true } }
        const bid = await runtime._physics.addConvexBodyAsync(points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, shapeKey: ent.model, linearCast: mt === 'dynamic' })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addColliderFromConfig: (cfg = {}) => {
      const type = cfg.type || 'box'
      const p = buildPhysicsAPI(ent, runtime)
      if (cfg.mass !== undefined) p.setMass(cfg.mass)
      if (cfg.linearDamping !== undefined) p.setLinearDamping(cfg.linearDamping)
      if (cfg.angularDamping !== undefined) p.setAngularDamping(cfg.angularDamping)
      if (cfg.dynamic) p.setDynamic(true)
      else if (cfg.kinematic) p.setKinematic(true)
      else p.setStatic(true)
      if (type === 'box') p.addBoxCollider(cfg.size || [cfg.hx ?? 0.5, cfg.hy ?? 0.5, cfg.hz ?? 0.5])
      else if (type === 'sphere') p.addSphereCollider(cfg.radius ?? 0.5)
      else if (type === 'capsule') p.addCapsuleCollider(cfg.radius ?? 0.3, cfg.height ?? 1.8)
      else if (type === 'convex') return p.addConvexFromModelAsync(cfg.meshIndex ?? 0)
      else if (type === 'trimesh') return p.addTrimeshCollider()
    },
    addForce: (f) => {
      const mass = ent.mass || 1
      ent.velocity[0] += f[0] / mass
      ent.velocity[1] += f[1] / mass
      ent.velocity[2] += f[2] / mass
    },
    setVelocity: (v) => { ent.velocity = [...v] }
  }
  return api
}
