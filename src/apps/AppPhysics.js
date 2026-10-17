import { extractMeshFromGLB, extractMeshFromGLBAsync, extractAllVerticesFromGLBAsync } from '../physics/GLBLoader.js'
import { MSG } from '../protocol/MessageTypes.js'
import { nonNeg, num } from '../shared/vecGuard.js'

function motionType(ent) {
  return ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
}

function scaleOf(ent) {
  return ent.scale || [1, 1, 1]
}

export function parseInteractable(config = {}) {
  const radius = config.radius ?? 3
  const cooldown = config.cooldown ?? 500
  const prompt = config.prompt ?? 'Press E'
  nonNeg(radius, 'interactable: radius')
  nonNeg(cooldown, 'interactable: cooldown')
  if (typeof prompt !== 'string') throw new TypeError('interactable: prompt must be a string')
  return { prompt, radius, cooldown }
}

export function reifyInteractable(ent, runtime, cfg) {
  ent._interactable = true
  ent._interactRadius = cfg.radius
  ent._interactCooldown = cfg.cooldown
  if (!ent.custom) ent.custom = {}
  ent.custom._interactable = { prompt: cfg.prompt, radius: cfg.radius, cooldown: cfg.cooldown }
  runtime._interactableIds?.add(ent.id)
}

function scaledPoints(raw, sc) {
  return (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
}

function bodyOptsFor(ent, mt, extra) {
  return { mass: ent.mass, linearDamping: ent._linearDamping, angularDamping: ent._angularDamping, linearCast: resolveCCD(ent, mt), ...extra }
}

function setBodyType(ent, runtime, type) {
  if (ent.bodyType === type) return
  if (ent.bodyType === 'static') runtime._staticEntityIds?.delete(ent.id)
  else runtime._dynamicEntityIds?.delete(ent.id)
  ent.bodyType = type
  if (type === 'static') runtime._staticEntityIds?.add(ent.id)
  else runtime._dynamicEntityIds?.add(ent.id)
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

function scaledShapeKey(model, scale) {
  return `${model}|${scale[0]},${scale[1]},${scale[2]}`
}

function colliderFailure(what, cause) {
  const detail = cause && cause.message ? cause.message : String(cause)
  const err = new Error(`[physics] ${what} failed: ${detail}`)
  err.name = 'ColliderBuildError'
  err.cause = cause
  return err
}

async function _addTrimeshColliderImpl(ent, runtime) {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (isNode && ent.model && runtime._physics && ent.collider?.type === 'trimesh') return
  ent.collider = { type: 'trimesh', model: ent.model }
  if (isNode && ent.model && runtime._physics) {
    const sc = scaleOf(ent)
    try {
      const bid = await runtime._physics.addStaticTrimeshAsync(runtime.resolveAssetPath(ent.model), 0, ent.position, sc, ent.rotation || [0, 0, 0, 1])
      if (bid != null) { const deferOrRun = runtime._deferOrRun ? runtime._deferOrRun.bind(runtime) : (fn => fn()); deferOrRun(() => { if (!runtime.entities?.has?.(ent.id)) return; registerBody(ent, runtime, bid, 'static') }) }
    } catch (err) {
      runtime._log?.('app_error', { label: `addTrimeshCollider(${ent.model})`, message: err.message }, { sourceEntity: ent.id })
      runtime._connections?.broadcast?.(MSG.EDITOR_ERROR, { message: `addTrimeshCollider: trimesh build failed for ${ent.model}`, entityId: ent.id, detail: err.message })
      throw colliderFailure(`trimesh collider for entity ${ent.id} model ${ent.model}`, err)
    }
  } else if (runtime._pendingTrimeshEntities) {
    runtime._pendingTrimeshEntities.set(ent.id, ent)
  }
}

const BOX_SIZE_SHAPE = 'must be a number or a length-3 array of non-negative finite numbers'

function boxHalfExtents(s, name) {
  const raw = Array.isArray(s) ? s : [s, s, s]
  if (raw.length !== 3) throw new TypeError(`${name} ${BOX_SIZE_SHAPE}`)
  return raw.map(x => nonNeg(x, name))
}

export function liveBodyIdOf(runtime, ent) {
  return (!ent || !runtime._physics || ent._physicsBodyId === undefined) ? undefined : ent._physicsBodyId
}

export function buildPhysicsAPI(ent, runtime) {
  const liveBodyId = () => liveBodyIdOf(runtime, ent)
  const api = {
    setInteractable: (radius = 3) => reifyInteractable(ent, runtime, parseInteractable({ radius })),
    setStatic: (v) => { if (v) setBodyType(ent, runtime, 'static') },
    setDynamic: (v) => { if (v) setBodyType(ent, runtime, 'dynamic') },
    setKinematic: (v) => { if (v) setBodyType(ent, runtime, 'kinematic') },
    setMass: (v) => { ent.mass = nonNeg(v, 'physics.setMass: mass') },
    setLinearDamping: (v) => { ent._linearDamping = nonNeg(v, 'physics.setLinearDamping: linearDamping') },
    setAngularDamping: (v) => { ent._angularDamping = nonNeg(v, 'physics.setAngularDamping: angularDamping') },
    setCCDPolicy: (v) => {
      if (v != null && v !== 'auto' && v !== 'always' && v !== 'off') throw new TypeError('physics.setCCDPolicy: policy must be one of auto, always, off')
      ent._ccdPolicy = v ?? 'auto'
    },
    addBoxCollider: (s, shapeKey) => {
      const half = boxHalfExtents(s, 'physics.addBoxCollider: size')
      ent.collider = { type: 'box', size: half }
      const sc = scaleOf(ent)
      const he = [half[0] * sc[0], half[1] * sc[1], half[2] * sc[2]]
      const mt = motionType(ent)
      const opts = bodyOptsFor(ent, mt, shapeKey ? { shapeKey } : null)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'box', params: he, motionType: mt, opts }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('box', he, ent.position, mt, { rotation: ent.rotation, ...opts })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addSphereCollider: (r) => {
      nonNeg(r, 'physics.addSphereCollider: radius')
      ent.collider = { type: 'sphere', radius: r }
      const sc = scaleOf(ent)
      const sr = r * Math.max(sc[0], sc[1], sc[2])
      const mt = motionType(ent)
      const opts = bodyOptsFor(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'sphere', params: sr, motionType: mt, opts }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('sphere', sr, ent.position, mt, { rotation: ent.rotation, ...opts })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addCapsuleCollider: (r, h) => {
      nonNeg(r, 'physics.addCapsuleCollider: radius')
      nonNeg(h, 'physics.addCapsuleCollider: height')
      ent.collider = { type: 'capsule', radius: r, height: h }
      const sc = scaleOf(ent)
      const uniformS = Math.max(sc[0], sc[1], sc[2])
      const sr = r * uniformS, sh = h * uniformS
      const mt = motionType(ent)
      const opts = bodyOptsFor(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'capsule', params: [sr, sh / 2], motionType: mt, opts }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('capsule', [sr, sh / 2], ent.position, mt, { rotation: ent.rotation, ...opts })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addTrimeshCollider: () => {
      const p = _addTrimeshColliderImpl(ent, runtime)
      if (runtime.trackTrimeshBuild) runtime.trackTrimeshBuild(p)
      return p
    },
    addConvexCollider: (points) => {
      if (!Array.isArray(points) || points.length < 9 || points.length % 3 !== 0) throw new TypeError('physics.addConvexCollider: points must be a flat array of at least 9 finite numbers in [x,y,z,...] triples')
      const verts = points.map(x => num(x, 'physics.addConvexCollider: point'))
      ent.collider = { type: 'convex', points: verts }
      const mt = motionType(ent)
      const opts = bodyOptsFor(ent, mt)
      if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: verts, motionType: mt, opts }
      if (runtime._physics) {
        const bid = runtime._physics.addBody('convex', verts, ent.position, mt, { rotation: ent.rotation, ...opts })
        registerBody(ent, runtime, bid, mt)
      }
    },
    addConvexFromModel: (meshIndex = 0) => {
      if (!ent.model) return
      try {
        const mesh = extractMeshFromGLB(runtime.resolveAssetPath(ent.model), meshIndex)
        const sc = scaleOf(ent)
        const points = scaledPoints(mesh.vertices, sc)
        ent.collider = { type: 'convex', points }
        if (runtime._physics) {
          const mt = motionType(ent)
          const shapeKey = scaledShapeKey(ent.model, sc)
          const opts = bodyOptsFor(ent, mt, { shapeKey })
          if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts }
          const bid = runtime._physics.addBody('convex', points, ent.position, mt, { rotation: ent.rotation, ...opts })
          registerBody(ent, runtime, bid, mt)
        }
      } catch (err) {
        throw colliderFailure(`convex hull from model ${ent.model}`, err)
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
        throw colliderFailure(`mesh extraction from model ${ent.model}`, err)
      }
      const sc = scaleOf(ent)
      const points = scaledPoints(mesh.vertices, sc)
      ent.collider = { type: 'convex', points }
      const shapeKey = shapeKeyOverride || scaledShapeKey(ent.model, sc)
      if (runtime._physics) {
        const opts = bodyOptsFor(ent, mt, { shapeKey })
        if (mt === 'dynamic') ent._bodyDef = { shapeType: 'convex', params: points, motionType: mt, opts }
        try {
          const bid = await runtime._physics.addConvexBodyAsync(points, ent.position, mt, { rotation: ent.rotation, ...opts })
          registerBody(ent, runtime, bid, mt)
        } catch (err) {
          throw colliderFailure(`convex shape build for model ${ent.model}`, err)
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
      else if (ent.bodyType !== 'dynamic' && ent.bodyType !== 'kinematic') p.setStatic(true)
      if (type === 'box') p.addBoxCollider(cfg.size || [cfg.hx ?? 0.5, cfg.hy ?? 0.5, cfg.hz ?? 0.5], cfg.shapeKey)
      else if (type === 'sphere') p.addSphereCollider(cfg.radius ?? 0.5)
      else if (type === 'capsule') p.addCapsuleCollider(cfg.radius ?? 0.3, cfg.height ?? 1.8)
      else if (type === 'convex') return p.addConvexFromModelAsync(cfg.meshIndex ?? -1, cfg.shapeKey)
      else if (type === 'trimesh') return p.addTrimeshCollider()
    },
    addForce: (f) => runtime.applyImpulseToEntity?.(ent.id, f) ?? false,
    setVelocity: (v) => {
      const bodyId = liveBodyId()
      if (bodyId !== undefined) runtime._physics.setBodyVelocity(bodyId, v)
      ent.velocity = [...v]
    },
    setPosition: (p) => {
      const bodyId = liveBodyId()
      if (bodyId !== undefined) {
        runtime._physics.setBodyPosition(bodyId, p)
        runtime._physics.setBodyVelocity(bodyId, [0, 0, 0])
        runtime._physics.setBodyAngularVelocity?.(bodyId, [0, 0, 0])
      }
      ent.position = [...p]
    },
    getVelocity: () => { const b = liveBodyId(); return b !== undefined ? runtime._physics.getBodyVelocity(b) : [...(ent.velocity || [0,0,0])] },
    getAngularVelocity: () => { const b = liveBodyId(); return b !== undefined ? (runtime._physics.getBodyAngularVelocity?.(b) || [0,0,0]) : [0,0,0] },
    getRotation: () => { const b = liveBodyId(); return b !== undefined ? (runtime._physics.getBodyRotation?.(b) || [...ent.rotation]) : [...ent.rotation] },
    setFriction: (f) => { const b = liveBodyId(); return b !== undefined ? !!runtime._physics.setBodyFriction?.(b, f) : false },
    setRestitution: (r) => { const b = liveBodyId(); return b !== undefined ? !!runtime._physics.setBodyRestitution?.(b, r) : false },
    setMotionType: (motionType) => {
      const bodyId = liveBodyId()
      if (bodyId === undefined) return false
      if (motionType !== 'dynamic' && motionType !== 'kinematic' && motionType !== 'static') return false
      if (typeof runtime._physics.setBodyMotionType !== 'function') return false
      if (motionType !== 'dynamic') runtime._physics.setBodyVelocity?.(bodyId, [0, 0, 0])
      const previousId = bodyId
      const liveId = runtime._physics.setBodyMotionType(previousId, motionType, {
        mass: ent.mass,
        linearDamping: ent._linearDamping,
        angularDamping: ent._angularDamping,
        linearCast: resolveCCD(ent, motionType),
      })
      if (liveId === false) return false
      ent.bodyType = motionType
      if (ent._bodyDef) ent._bodyDef.motionType = motionType
      if (liveId !== previousId) runtime._adoptBodyId?.(ent, previousId, liveId)
      if (motionType === 'static') runtime._activeDynamicIds?.delete(ent.id)
      else runtime._activeDynamicIds?.add(ent.id)
      return true
    },
    getBodyId: () => liveBodyId() ?? null,
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

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapAppPhysics = (next) => {
  parseInteractable = next.parseInteractable
  reifyInteractable = next.reifyInteractable
  resolveCCD = next.resolveCCD
  liveBodyIdOf = next.liveBodyIdOf
  buildPhysicsAPI = next.buildPhysicsAPI
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapAppPhysics)
