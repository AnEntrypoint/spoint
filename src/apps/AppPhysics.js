import { extractMeshFromGLB, extractMeshFromGLBAsync, extractAllVerticesFromGLBAsync } from '../physics/GLBLoader.js'
import { MSG } from '../protocol/MessageTypes.js'

function motionType(ent) {
  return ent.bodyType === 'dynamic' ? 'dynamic' : ent.bodyType === 'kinematic' ? 'kinematic' : 'static'
}

// Per-entity-class CCD (continuous collision detection) policy. Before this, every collider-creation
// call site below hardcoded `linearCast: mt === 'dynamic'` -- CCD (Jolt EMotionQuality_LinearCast) was
// unconditionally ON for every dynamic body and unconditionally OFF for every static/kinematic body,
// with no app-manifest lever either way. That is real cost on both ends: a fast projectile/character
// genuinely needs it (a thin collider would tunnel through in one physics step without it), but a slow
// debris prop (a crate, a rock chunk) pays LinearCast's real per-step swept-shape cost for zero benefit,
// and a fast-moving kinematic mover had no way to opt in either. ent._ccdPolicy (set via
// setCCDPolicy()/addColliderFromConfig's cfg.ccd, or AppRuntime.spawnEntity's config.ccd -- see that
// file) is one of:
//   'auto'   (default, unchanged behavior) -- CCD on for dynamic bodies, off otherwise.
//   'always' -- force CCD on regardless of motion type (fast kinematic movers, fast projectiles).
//   'off'    -- force CCD off even for a dynamic body (slow debris/props -- the perf win).
export function resolveCCD(ent, mt) {
  const policy = ent._ccdPolicy
  if (policy === 'always') return true
  if (policy === 'off') return false
  return mt === 'dynamic' // 'auto' / unset: prior hardcoded behavior, unchanged default
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

// Real implementation behind the addTrimeshCollider public API (see buildPhysicsAPI below) -- split out
// so the wrapper can capture and track this function's own returned promise via runtime.trackTrimeshBuild.
async function _addTrimeshColliderImpl(ent, runtime) {
  ent.collider = { type: 'trimesh', model: ent.model }
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (isNode && ent.model && runtime._physics) {
    const sc = ent.scale || [1, 1, 1]
    try {
      const bid = await runtime._physics.addStaticTrimeshAsync(runtime.resolveAssetPath(ent.model), 0, ent.position, sc, ent.rotation || [0, 0, 0, 1])
      // rollback-population-inflight-async-commitment-at-suppression-start: this await is reachable
      // from an app's own setup() (called BEFORE _attachApp's `await setup(ctx)` resolves), so it can
      // resolve during a suppression window that opened after this call started -- same race as
      // AppRuntime.spawnEntity's own autoTrimesh path, gated the same way. entities.has() guards a
      // destroy that raced ahead of this from mutating a since-deleted entity.
      if (bid != null) { const deferOrRun = runtime._deferOrRun ? runtime._deferOrRun.bind(runtime) : (fn => fn()); deferOrRun(() => { if (!runtime.entities?.has?.(ent.id)) return; registerBody(ent, runtime, bid, 'static') }) }
    } catch (err) {
      console.warn(`[physics] ${ent.model}: trimesh build failed (${err.message}), using box fallback`)
      runtime._debug?.warn?.(`[physics] ${ent.model}: trimesh build failed (${err.message}), using box fallback`)
      runtime._log?.('app_error', { label: `addTrimeshCollider(${ent.model})`, message: err.message }, { sourceEntity: ent.id })
      const deferOrRun = runtime._deferOrRun ? runtime._deferOrRun.bind(runtime) : (fn => fn())
      deferOrRun(() => {
        if (!runtime.entities?.has?.(ent.id)) return
        fallbackBox(ent, runtime, 'static')
        // Real error surfaced to every connected editor client instead of console-only silence,
        // matching EditorHandlers.sendError's EDITOR_ERROR shape.
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
    // 'auto' (default) | 'always' | 'off' -- see resolveCCD above. Settable independently of bodyType/
    // collider so an app can declare it once in setup() before (or after) adding the collider.
    setCCDPolicy: (v) => { ent._ccdPolicy = (v === 'always' || v === 'off') ? v : 'auto' },
    // shapeKey (optional): ties this body into World.js's addBody/removeBody shapeKey pool -- a
    // removeBody() on a shapeKey'd body parks+pools its Jolt body/shape instead of destroying it, and
    // the next addBody() with the SAME key pulls it back out with a cheap reposition instead of a fresh
    // native CreateBody. Needed by any caller that repeatedly creates+destroys many same-sized bodies
    // (e.g. apps/destructible-debris pooled debris pieces) -- without it every collider call is a fresh
    // Jolt allocation regardless of how many identical bodies came and went before it.
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
    // Bad/missing GLB path (or any trimesh-build failure) must NEVER become an unhandled promise
    // rejection: this used to `await` addStaticTrimeshAsync with no try/catch while its own caller
    // (an app's synchronous setup()) never awaits or attaches a .catch() to the promise this async
    // function returns -- an ENOENT from a nonexistent modelPath crashed the entire server process
    // (Node's default unhandledRejection behavior). Mirrors the fallback-to-box pattern already used
    // by addConvexFromModelAsync/AppRuntime.spawnEntity's own trimesh path: log + fall back, never throw.
    //
    // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: the public
    // addTrimeshCollider is a thin SYNCHRONOUS wrapper around _addTrimeshColliderImpl below, so it can
    // register the impl's own returned promise with runtime.trackTrimeshBuild BEFORE any awaiting happens
    // inside it -- an async arrow cannot reference its own promise from inside its own body, so the promise
    // has to be captured from the calling side instead. This changes nothing about the fire-and-forget
    // call convention every existing caller already uses (apps call `ctx.physics.addTrimeshCollider()`
    // without awaiting it, same as before).
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
        // Draco was the only compressed-mesh case this sync path could hit historically;
        // now that all NEW/re-encoded GLB output standardizes on meshopt (see AGENTS.md
        // meshopt-standardization-draco-legacy-only), extractMeshFromGLB's sync reader
        // throws the same shape of "can't sync-decode this compression" error for
        // EXT_meshopt_compression too (its decode needs the async WASM-backed path) --
        // handle both the same way instead of an unhandled throw on every new-format asset.
        if (err.message.includes('Draco-compressed') || err.message.includes('Meshopt-compressed')) {
          runtime._debug?.warn(`[physics] ${err.message.includes('Draco') ? 'Draco' : 'Meshopt'} mesh detected - use addConvexFromModelAsync()/addTrimeshCollider() for physics or box/sphere/capsule for trigger`)
          fallbackBox(ent, runtime, motionType(ent))
        } else {
          throw err
        }
      }
    },
    // meshIndex -1 merges all meshes into one point cloud (a multi-mesh model would otherwise get a hull missing every mesh but the first).
    // shapeKeyOverride: the shapeCache key World.js's addConvexBodyAsync uses to dedupe/reuse a cooked
    // Shape. Defaults to ent.model (correct for meshIndex===-1, exactly one hull per model path) -- but a
    // caller selecting a SPECIFIC meshIndex out of a multi-mesh GLB (e.g. a scripts/fracture-glb.mjs-baked
    // fractured asset, one mesh per debris piece) MUST pass its own key here. A real bug found+fixed while
    // wiring fractured-GLB debris shapes: without this override, every piece of the SAME fracturedAsset
    // shared the identical shapeKey (ent.model alone, meshIndex-blind), so the SECOND piece ever built
    // would hit World.js's shapeCache on the FIRST piece's already-cooked hull and silently render/collide
    // as the wrong geometry -- a shape-cache collision, not a crash, so it would have shipped undetected
    // without this fix.
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
        // A degenerate point cloud (a fractured piece can genuinely produce one -- too few/near-coplanar
        // vertices from a sliver cell) now throws from buildConvexShape's own sr.IsValid() guard
        // (ShapeBuilder.js) rather than silently corrupting Jolt state -- must be caught here, same
        // fail-loud-then-box-fallback discipline as the mesh-extraction catch just above, or an
        // unhandled promise rejection would propagate out of this fire-and-forget async call (this
        // function's own caller, addColliderFromConfig, is never awaited by a typical app's setup()).
        try {
          const bid = await runtime._physics.addConvexBodyAsync(points, ent.position, mt, { rotation: ent.rotation, mass: ent.mass, shapeKey, linearCast: ccd })
          registerBody(ent, runtime, bid, mt)
        } catch (err) {
          console.warn(`[physics] ${ent.model}: convex shape build failed (${err.message}), using box fallback`)
          fallbackBox(ent, runtime, mt)
        }
      }
    },
    // cfg.ccd: 'auto' (default) | 'always' | 'off' -- the app-manifest-level CCD policy lever (see
    // resolveCCD above). Applied BEFORE the collider methods below so setCCDPolicy has taken effect
    // by the time addBoxCollider/addSphereCollider/etc read ent._ccdPolicy.
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
    // Teleport: authoritative position set for a body with a REAL Jolt body attached (dynamic or
    // kinematic bodyType). A bare `ctx.entity.position = v` assignment only writes the JS-side entity
    // object -- for a dynamic body, the next physics.step() reads the Jolt body's own simulated
    // transform back into entity.position (World.js's per-tick bulk position readback) and silently
    // overwrites that write, matching the documented "dynamic bodies must be teleported... or
    // physics.step overwrites the write next tick" caveat already known to src/sdk/EditorHandlers.js's
    // syncEntityCollider for editor-driven moves -- this is the same primitive made available to an
    // app's own server update() loop, needed by any app that drives a dynamic entity's movement itself
    // (steering-driven bots, scripted movers) rather than letting Jolt's own dynamics own the motion.
    // Zeroes velocity too (matching syncEntityCollider) so the body doesn't carry stale momentum into
    // the teleported position and immediately drift/tumble away from where it was just placed.
    setPosition: (p) => {
      if (runtime._physics && ent._physicsBodyId !== undefined) {
        runtime._physics.setBodyPosition(ent._physicsBodyId, p)
        runtime._physics.setBodyVelocity(ent._physicsBodyId, [0, 0, 0])
        // Zero angular velocity too -- a dynamic body's stale spin/tumble momentum otherwise survives
        // a teleport exactly like stale linear velocity would (the bug the comment above already
        // documents for linear); real gap found+fixed while pooling destructible debris (a REUSED
        // pooled body carrying over the previous piece's spin into its next life). setBodyAngularVelocity
        // is a no-op (returns false) on a Jolt build without SetAngularVelocity, never throws.
        runtime._physics.setBodyAngularVelocity?.(ent._physicsBodyId, [0, 0, 0])
      }
      ent.position = [...p]
    },
    // --- Rest-state reads (tower-topple / balance / Jenga lose condition, "has the ball stopped") ---
    getVelocity: () => (runtime._physics && ent._physicsBodyId !== undefined) ? runtime._physics.getBodyVelocity(ent._physicsBodyId) : [...(ent.velocity || [0,0,0])],
    getAngularVelocity: () => (runtime._physics && ent._physicsBodyId !== undefined) ? (runtime._physics.getBodyAngularVelocity?.(ent._physicsBodyId) || [0,0,0]) : [0,0,0],
    getRotation: () => (runtime._physics && ent._physicsBodyId !== undefined) ? (runtime._physics.getBodyRotation?.(ent._physicsBodyId) || [...ent.rotation]) : [...ent.rotation],
    // Settled = both linear and angular speed below `eps` (default 0.05). The "is this at rest yet" check.
    isAtRest: (eps = 0.05) => {
      const v = api.getVelocity(), a = api.getAngularVelocity()
      return (v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) < eps*eps && (a[0]*a[0]+a[1]*a[1]+a[2]*a[2]) < eps*eps
    },
    // Tilt from upright in radians: angle between the body's local +Y and world +Y. A tower/piece that has
    // toppled reads a large angle (near PI/2+). Derived from the body quaternion, no extra Jolt call beyond getRotation.
    tiltFromUpright: () => {
      const q = api.getRotation()
      // rotate local up [0,1,0] by q; upY is the world-space Y-component of the rotated up vector.
      const x=q[0], y=q[1], z=q[2], w=q[3]
      const upY = 1 - 2*(x*x + z*z)
      return Math.acos(Math.max(-1, Math.min(1, upY)))
    },
    setFriction: (f) => (runtime._physics && ent._physicsBodyId !== undefined) ? !!runtime._physics.setBodyFriction?.(ent._physicsBodyId, f) : false,
    setRestitution: (r) => (runtime._physics && ent._physicsBodyId !== undefined) ? !!runtime._physics.setBodyRestitution?.(ent._physicsBodyId, r) : false,
    // Flip this entity's REAL Jolt body motion type in place (dynamic<->kinematic<->static), reusing the
    // same body/shape -- no destroy/recreate. Same primitive AppRuntimePhysics.js's distance-driven hard-
    // activation-ring LOD already uses internally (World.js's setBodyMotionType), now exposed for an
    // app-level (lifetime/age-driven, not distance-driven) LOD decision -- e.g. apps/_lib/destructible.js's
    // debris lifetime state machine (physics-simulated -> kinematic-frozen -> static -> despawn). Zeroes
    // velocity when freezing to kinematic/static (matches the ring-LOD convention: a frozen body shouldn't
    // carry stale momentum) so it doesn't drift once no longer dynamically integrated. Updates ent.bodyType
    // too so any other code reading it (e.g. a future body-recreate) stays consistent with the live body.
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
    // Exposes this entity's own physics body id (the raw entity's _physicsBodyId is engine-internal,
    // not on the public ctx.entity proxy -- see AppContext.js's _buildEntityProxy, which deliberately
    // does not surface it) so an app can pass itself as ctx.raycast's excludeBodyId when self-probing
    // movement ahead of itself (a self-driving bot/mover raycasting its own intended path would
    // otherwise immediately self-hit its own collider at ~0 distance, since the probe origin sits
    // inside its own capsule/box shape).
    getBodyId: () => (ent._physicsBodyId !== undefined ? ent._physicsBodyId : null),
    // --- Real Jolt WheeledVehicleController (vehicles-jolt-wheeled-constraints-app) ---
    // Requires the entity already have a DYNAMIC box/convex collider (the chassis body) -- call
    // addBoxCollider/addColliderFromConfig({dynamic:true,...}) first. wheelDefs: array of
    // {position:[x,y,z] chassis-local, radius, width, suspensionMin, suspensionMax, maxSteerAngle,
    // maxBrakeTorque, maxHandBrakeTorque, steer:bool, drive:bool}. See World.js createWheeledVehicle's
    // header comment for the full option shape (opts.up/forward/differentials/engine).
    createVehicle: (wheelDefs, opts) => runtime.createVehicleForEntity?.(ent.id, wheelDefs, opts) ?? null,
    // forward/right: -1..1 (throttle/reverse, steer). brake/handbrake: 0..1. Straight passthrough to
    // Jolt's own per-physics-step engine/transmission/wheel-friction simulation.
    setVehicleInput: (forward, right, brake, handbrake) => runtime.setEntityVehicleDriverInput?.(ent.id, forward, right, brake, handbrake) ?? false,
    // --- Real Jolt TrackedVehicleController (vehicles-tracked-controller-follow-up) ---
    // Sibling to createVehicle above -- same dynamic-body precondition, wheelDefs shape documented in
    // World.js createTrackedVehicle's header comment (side:'left'|'right' + driven:bool per wheel
    // instead of steer/drive). Shares the SAME _vehicleId slot as createVehicle (an entity has at most
    // one vehicle constraint of either kind at a time -- hasVehicle/destroyVehicle/getVehicleWheelTransform/
    // getVehicleWheelState below already work generically for both, no tracked-specific variant needed).
    createTrackedVehicle: (wheelDefs, opts) => runtime.createTrackedVehicleForEntity?.(ent.id, wheelDefs, opts) ?? null,
    // forward: -1..1. leftRatio/rightRatio: -1..1 per-track power ratio (equal = straight, differing =
    // steer/pivot). brake: 0..1. Deliberately different shape from setVehicleInput -- tracks steer via
    // per-side power, not a wheel-turn angle.
    setTrackedVehicleInput: (forward, leftRatio, rightRatio, brake) => runtime.setEntityTrackedVehicleDriverInput?.(ent.id, forward, leftRatio, rightRatio, brake) ?? false,
    // World-space {position,rotation} for one wheel -- the client-rendering primitive (spin/steer a
    // wheel mesh to match the real simulated suspension/steer/roll state) and {grounded,speed} for HUD/audio.
    getVehicleWheelTransform: (wheelIndex) => runtime.getEntityVehicleWheelTransform?.(ent.id, wheelIndex) ?? null,
    getVehicleWheelState: (wheelIndex) => runtime.getEntityVehicleWheelState?.(ent.id, wheelIndex) ?? null,
    hasVehicle: () => ent._vehicleId != null,
    destroyVehicle: () => runtime.destroyVehicleForEntity?.(ent.id) ?? false,
  }
  return api
}
