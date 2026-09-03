// createDestructible(spec, appCtx) -> a per-object damage/impact accumulator that, once a threshold
// is crossed, swaps the owning (intact) entity for N physics-driven debris pieces with a configurable
// launch-impulse pattern, then optionally despawns the debris after a lifetime and/or respawns the
// original intact object after a delay. Generalizes the object-destruction-therapy prototype's
// hand-rolled uniform box-shard tower destruction (40 real debris pieces, live-verified) into a
// spec-driven, shape-agnostic primitive. Uses the existing cross-entity impulse primitive
// (ctx.world.applyImpulse -> AppRuntimePhysics.js's applyImpulseToEntity) for every debris launch --
// does not reimplement impulse routing. Debris pieces get real dynamic Jolt bodies via the
// apps/destructible-debris helper app (ctx.world.spawnChild(..., { app: 'destructible-debris' })),
// the same config.app -> _attachApp -> ctx.physics.addColliderFromConfig path every other physics
// entity in this engine uses -- no direct runtime/body internals are touched here.
//
// POOLED SPAWN (destructibles-pooled-instanced-debris-spawn): a fixed-size pool of debris ENTITIES,
// sized to debrisCount, is spawned lazily on this destructible's first destruction and then REUSED for
// every subsequent one -- a repeated destroy/respawn/destroy stress test does not keep allocating fresh
// entities (spawnEntity's full AppContext+_attachApp+_scheduleRebuild cost, see AppRuntime.js) or fresh
// Jolt bodies (apps/destructible-debris's shapeKey wiring feeds World.js's existing addBody/removeBody
// shapeKey pool, see that file's header comment). A "despawned" pooled piece is PARKED (scale 0 + moved
// far below the play volume, the exact same hide primitive already used for the intact object below) and
// its Jolt body deactivated+velocity-zeroed (World.js removeBody/addBody pool-hit path), not destroyed;
// the next destruction reactivates+repositions+re-impulses the same entities instead of respawning new
// ones. Only drain() (called from the owning app's teardown(ctx), e.g. on hot-reload) actually destroys
// the pooled entities -- see that function's own header.
//
// LIFETIME LOD (destructibles-debris-lifetime-lod): layered on top of the pool above -- an active piece
// ages through physical -> frozen -> static before its despawn timer releases it back to the pool (see
// tick()'s per-piece state machine and the debrisLOD getter). Despawn itself is a pool release
// (_releasePoolPiece), not a real destroy, so the two features compose: LOD bounds per-tick physics cost
// while a piece is active, pooling bounds allocation cost across repeated destructions.
//
// FRACTURED-GLB SHAPE SOURCE (destructibles-fractured-glb-shape-wiring): by default, debris pieces are
// still uniform procedurally-sized boxes (or a caller-supplied shape via spec.debrisShape) -- but
// spec.fracturedAsset opts a destructible into REAL fractured-mesh debris instead: a
// scripts/fracture-glb.mjs-baked GLB (one convex-hull Voronoi cell per child mesh) drives each piece's
// actual collider+visual shape via apps/destructible-debris's fracturedAsset+pieceIndex config ->
// ctx.physics.addConvexFromModelAsync(pieceIndex) (the existing per-mesh convex-hull extraction
// primitive, unchanged, just pointed at one mesh of a multi-mesh GLB instead of a whole single-mesh
// model). Pooling in this mode is PER PIECE INDEX (see _acquirePoolPiece's fixedSlotKey), not a generic
// interchangeable free-list, since two different baked pieces are never geometrically identical the way
// two uniform debris boxes can be -- pooling here still bounds allocation cost (repeated destructions of
// the SAME destructible reuse the SAME per-piece entities/bodies), it just can't share buckets ACROSS
// different piece indexes the way the uniform-box path shares buckets across different destructibles of
// the same size. Client-side per-piece MESH rendering (a real geometry, not a box placeholder, for
// custom.mesh==='fracturedPiece' entities) is separately scoped -- see client/EntityLoader.js's own
// handling of that custom.mesh value.
//
// The intact object itself is NOT destroyed/respawned as an entity (that would tear down the very
// AppContext driving this destructible's tick/respawn timers, since destroyEntity() detaches the app).
// Instead "destruction" parks the intact entity out of the play volume (so its still-live collider can't
// interfere) AND zero-scales it: client/EntityLoader.js's buildEntityMesh falls back to a default orange
// placeholder box for any custom-less entity, so custom=null does NOT hide a mesh -- scale=0 is the real
// hide primitive. "respawn" restores both position and scale. The owning entity/app stays alive
// throughout, so its tick/respawn timers are never interrupted.
//
// Impact detection: the engine's onCollision hook (AppRuntime._tickCollisionsBrute/Grid) only fires
// between a PAIR of entities that BOTH implement onCollision on their own app -- a plain physics prop
// (e.g. box-dynamic) or a player can never trigger another entity's onCollision, so relying on it alone
// would make impactThreshold unusable against the most common "something rammed this" case. tick(dt)
// therefore runs its own proximity+closing-speed scan every tick (via ctx.world.nearby + ctx.players)
// whenever impactThreshold > 0 -- this is the primary, universal trigger path, calling impact()
// internally. impact(velocity) also stays public so an app that DOES implement its own onCollision
// (object-vs-object games with both sides wired) can forward that event's velocity directly instead of
// waiting a tick.
//
// Call destructible.tick(dt) once per server tick from the owning app's update(ctx, dt) -- this object
// owns its own debris-lifetime/respawn/impact-scan timers, it does not register a runtime-level watch.

import { validateDestructibleSpec, resolveDebrisImpulsePattern, jitter } from './destructibleSpec.js'

const _PARK_OFFSET = [0, -5000, 0] // far enough below any reasonable playfield that stray collisions are impossible

// spec = {
//   health?: number                 -- total damage capacity before destruction (default 100)
//   impactThreshold?: number        -- closing speed (m/s) of a nearby dynamic entity/player that counts
//                                      as a destroying hit; 0 disables impact-based triggering entirely,
//                                      leaving only explicit damage()/destroy() calls (default 0)
//   impactRadius?: number           -- proximity radius (m) for the tick()-driven impact scan (default:
//                                      intact object's own half-extent max * 1.5)
//   debrisCount?: number            -- number of debris pieces spawned on destruction (default 8)
//   debrisShape?: { hx,hy,hz, mass, color, roughness } -- per-piece box half-extents/mass/look
//                                      (default: intact object's own half-extents shrunk by debrisCount^(1/3),
//                                      so total debris volume roughly matches the intact object regardless of count)
//   debrisLifetime?: number         -- seconds before debris auto-despawns (default 8, 0 = never despawn)
//   debrisSettleGrace?: number      -- seconds after spawn before a piece is even eligible to freeze
//                                      (default 0.5 -- gives the launch impulse time to actually move it,
//                                      so a piece landing on a flat surface instantly isn't frozen mid-launch)
//   debrisFreezeAfter?: number      -- if a piece has NOT settled (isAtRest) by this many seconds since
//                                      spawn, force-freeze it to kinematic anyway (default 3 -- a piece
//                                      wedged in a crevice or endlessly micro-jittering must still get
//                                      LOD'd down, "at rest" cannot be relied on to ever fire for every
//                                      piece); 0 disables the force-freeze, a never-settling piece then
//                                      just rides physics-simulated until debrisLifetime despawns it
//   debrisImpulsePattern?: 'outward'|'outward-up'|'up'|(i,n,rng)=>[x,y,z] -- per-piece launch impulse (default 'outward-up')
//   fracturedAsset?: string         -- path to a scripts/fracture-glb.mjs-baked GLB (one child mesh per
//                                      Voronoi-fractured debris piece). When set, debris pieces get their
//                                      SHAPE from the baked convex-hull geometry (apps/destructible-debris's
//                                      fracturedAsset+pieceIndex config -> ctx.physics.addConvexFromModelAsync,
//                                      the existing per-mesh convex-hull extraction primitive) instead of
//                                      uniform procedural boxes -- a real fractured-mesh debris shape, not a
//                                      box-shard placeholder. debrisCount/debrisShape are IGNORED when this
//                                      is set (see fracturedPieceCount below); every destruction spawns
//                                      exactly the baked piece set, one entity per baked piece index, pooled
//                                      PER PIECE INDEX across repeated destructions (piece 3 always reuses
//                                      piece 3's own entity+body -- pieces are never geometrically
//                                      interchangeable the way uniform boxes are, so pooling here is
//                                      entity/body reuse for the SAME piece across destructions, not a
//                                      shared bucket across different pieces).
//   fracturedPieceCount?: number    -- REQUIRED when fracturedAsset is set: the number of baked pieces in
//                                      that GLB (read it from the baked <asset>.pieces.json sidecar's
//                                      pieceCount field -- this module deliberately does not read the
//                                      sidecar itself, since a Worker/no-fs client-authored caller may not
//                                      have fs access; pass the known-at-bake-time count explicitly).
//   respawnDelay?: number           -- seconds after destruction before the intact object respawns (default 0 = never respawn)
//   onDestroyed?: (ctx, debrisIds) => void  -- fires once destruction triggers, after debris spawn
//   onRespawn?: (ctx) => void       -- fires once the intact object respawns
// }
export function createDestructible(spec = {}, appCtx = null) {
  validateDestructibleSpec(spec)
  if (!appCtx) throw new TypeError('[destructible] appCtx is required')

  const health = spec.health ?? 100
  const impactThreshold = spec.impactThreshold ?? 0
  const fracturedAsset = spec.fracturedAsset ?? null
  const debrisCount = fracturedAsset ? spec.fracturedPieceCount : (spec.debrisCount ?? 8)
  const debrisLifetime = spec.debrisLifetime ?? 8
  const debrisSettleGrace = spec.debrisSettleGrace ?? 0.5
  const debrisFreezeAfter = spec.debrisFreezeAfter ?? 3
  const respawnDelay = spec.respawnDelay ?? 0
  const impulseFn = resolveDebrisImpulsePattern(spec.debrisImpulsePattern ?? 'outward-up')

  // captured once at build time -- the intact object's true home/look, independent of later parking.
  const _homePosition = [...appCtx.entity.position]
  const _homeScale = [...(appCtx.entity.scale || [1, 1, 1])]
  const _homeCustom = appCtx.entity.custom ? { ...appCtx.entity.custom } : null

  let _damage = 0
  let _destroyed = false
  let _respawnTimer = 0
  const _debrisIds = new Set()          // currently-active (visible, simulating) debris piece ids
  const _poolFree = []                  // parked/idle pool entity ids, ready for instant reuse (uniform-box mode: any slot is interchangeable)
  const _poolAll = new Set()            // every entity id this destructible has ever spawned (active + free)
  const _poolByKey = new Map()          // fractured-piece mode only: pieceIndex -> its permanently-assigned entity id (see _acquirePoolPiece's fixedSlotKey doc)
  // debrisId -> { age: seconds since spawn, remaining: seconds until despawn (null if debrisLifetime===0),
  //               lod: 'physical'|'frozen'|'static' } -- the lifetime LOD state machine driving each piece
  // down from a full dynamic Jolt body to a cheap frozen/static one as it ages, bounding server-side
  // per-tick physics cost for a destruction-heavy scene (a pile of debris that never got LOD'd down would
  // otherwise cost one full dynamic-body simulation step per piece, forever, until the despawn timer --
  // matching the collider-streamer-fresh-territory-tick-stall discipline of not letting an unbounded count
  // of active dynamic bodies accumulate). 'physical' -> 'frozen' (kinematic, in-place motion-type flip, no
  // destroy/recreate) once isAtRest() or debrisFreezeAfter elapses; 'frozen' -> 'static' immediately after
  // (a kinematic body still costs a broadphase entry + an explicit per-tick position write from JS if
  // anything moved it, which nothing does once frozen -- static is strictly cheaper and correct here since
  // a frozen debris piece never moves again under this state machine). Despawn now RELEASES the piece back
  // to the pool (_releasePoolPiece) rather than destroying the entity, matching the pooled/instanced spawn
  // discipline above -- a pool-aware despawn, not the flat world.destroy this row originally shipped with.
  const _debrisTimers = new Map()
  const _lastSeenSpeed = new Map() // nearby id (entity or player) -> last-sampled speed, for a crude closing-speed read

  function _intactHalfExtents() {
    const c = _homeCustom
    if (c && Number.isFinite(c.sx) && Number.isFinite(c.sy) && Number.isFinite(c.sz)) return [c.sx / 2, c.sy / 2, c.sz / 2]
    return [0.5, 0.5, 0.5]
  }

  const impactRadius = spec.impactRadius ?? (Math.max(..._intactHalfExtents()) * 1.5)

  function _pieceExtents() {
    const shape = spec.debrisShape
    if (shape && Number.isFinite(shape.hx) && Number.isFinite(shape.hy) && Number.isFinite(shape.hz)) return [shape.hx, shape.hy, shape.hz]
    const [hx, hy, hz] = _intactHalfExtents()
    // shrink each intact half-extent by cbrt(debrisCount) so total debris volume roughly matches the
    // intact object's volume regardless of how many pieces are requested.
    const div = Math.cbrt(debrisCount)
    return [hx / div, hy / div, hz / div]
  }

  // Pull one debris entity for reuse -- a parked pool slot if one is free, else spawns exactly one new
  // pooled entity (only reachable the first debrisCount times this destructible is ever destroyed; every
  // destruction after that finds the full pool already built and every acquire is a pool hit). config is
  // only applied to a FRESH spawn: a reused entity already carries the app+its Jolt body from its first
  // spawn, and apps/destructible-debris's shapeKey (size+mass keyed) guarantees a reused Jolt body already
  // matches this destructible's own hx/hy/hz/mass -- re-attaching the app on every reuse would re-run
  // setup() and cost exactly what pooling exists to avoid.
  //
  // fixedSlotKey (fractured-piece mode only): unlike uniform debris boxes, where ANY parked slot is
  // interchangeable (every box in the pool is geometrically identical, so a plain free-list pop is
  // correct), a fractured piece's shape is baked per-index -- piece 3's entity is permanently piece 3's
  // convex hull (set once at that entity's FIRST spawn, via apps/destructible-debris's fracturedAsset+
  // pieceIndex config, and never re-attached on reuse). Passing fixedSlotKey routes the acquire through a
  // per-key map (_poolByKey) instead of the shared free-list, so "acquire piece 3" always returns the SAME
  // entity id across every destruction of this destructible, never a different piece's slot.
  function _acquirePoolPiece(position, rotation, config, fixedSlotKey, model) {
    // model (fractured-piece mode only): spawnEntity reads config.model at TOP LEVEL, not from the
    // nested app `config` bag apps/destructible-debris's own ctx.config sees -- a real gap found live
    // while verifying this row (a spawned fractured-piece entity's convexFromModelAsync silently had
    // ent.model===null, so it never even reached the mesh-extraction try/catch, just fell through with
    // no collider at all). Threading fracturedAsset through as the entity's OWN model (in addition to
    // config.fracturedAsset, which the app still needs to know WHICH mesh index to extract) gives BOTH
    // the client render path (entity.model drives EntityLoader.js's GLB load) and
    // AppPhysics.addConvexFromModelAsync (reads ent.model, see AppContext.js's entity proxy) the asset
    // path they each independently need.
    const spawnCfg = { position, rotation, bodyType: 'dynamic', app: 'destructible-debris', config }
    if (model) spawnCfg.model = model
    let id
    if (fixedSlotKey != null) {
      id = _poolByKey.get(fixedSlotKey)
      if (id == null) {
        id = `${appCtx.entity.id}_debris_${fixedSlotKey}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        appCtx.world.spawnChild(id, spawnCfg)
        _poolByKey.set(fixedSlotKey, id)
        _poolAll.add(id)
        return id
      }
    } else {
      id = _poolFree.pop()
      if (id == null) {
        id = `${appCtx.entity.id}_debris_${_poolAll.size}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        appCtx.world.spawnChild(id, spawnCfg)
        _poolAll.add(id)
        return id
      }
    }
    // revive: unpark (real size, real position) -- setPosition also zeroes linear+angular velocity
    // (see AppPhysics.js's setPosition, extended this row) so no stale momentum survives into this life.
    appCtx.world.setPosition(id, position, rotation)
    const e = appCtx.world.getEntity(id)
    if (e) e.scale = [1, 1, 1]
    return id
  }

  // Return an active piece to the pool: park it (invisible, far below the play volume) AND deactivate its
  // Jolt body (ctx.world.setBodyActive(id, false) -- see AppRuntimePhysics.js's setEntityBodyActive) so it
  // stops simulating entirely while idle, instead of destroying the entity. Live-witnessed bug found+fixed
  // while building this: setPosition alone (World.js's setBodyPosition always activates) left a "parked"
  // piece free-falling forever at the park position -- 215m of drift measured over 2s of stepping before
  // setBodyActive(id,false) was added. The NEXT acquire is a cheap reuse (reposition+reactivate), not a
  // fresh spawn.
  //
  // fractured-piece mode does NOT push into _poolFree: fixed-slot pieces are already permanently tracked
  // by pieceIndex in _poolByKey (set once at first acquire, never re-assigned), and _acquirePoolPiece's
  // fixedSlotKey path looks the entity up there directly -- pushing it into the generic free-list too would
  // create a second, dead route to the same id that _acquirePoolPiece's fixed-slot branch never reads
  // (harmless-but-leaked memory, not a correctness bug, but real waste worth avoiding since it grows
  // unbounded across many destroy/respawn cycles).
  function _releasePoolPiece(id) {
    const e = appCtx.world.getEntity(id)
    if (e) { e.scale = [0, 0, 0]; appCtx.world.setPosition(id, [_PARK_OFFSET[0], _PARK_OFFSET[1], _PARK_OFFSET[2]]) }
    appCtx.world.setBodyActive(id, false)
    if (!fracturedAsset) _poolFree.push(id)
  }

  // Fractured-piece spawn: one entity per baked piece INDEX (not a generic pool-any-free-slot loop --
  // see _acquirePoolPiece's fixedSlotKey doc for why piece identity must be stable). Each piece's own
  // convex-hull geometry (extracted server-side by apps/destructible-debris from fracturedAsset's
  // meshIndex=pieceIndex node) already carries its correct local offset from the source model's own
  // origin -- scripts/fracture-glb.mjs never re-centers a cell to its own centroid, every piece's
  // vertices stay in the SOURCE model's local space -- so spawning every piece at the intact object's own
  // _homePosition (no per-piece jitter, unlike the uniform-box path) reconstructs the original shape
  // exactly, matching how the baked GLB's node transforms (all identity, see fracture-glb.mjs's
  // `node.setTranslation([0,0,0])`) assume the pieces are placed at their shared source origin.
  function _spawnFracturedDebris() {
    const shape = spec.debrisShape || {}
    const totalMass = shape.mass != null ? shape.mass : (_homeCustom?.mass ?? 50)
    const pieceMass = Math.max(0.1, totalMass / debrisCount)
    const color = shape.color ?? _homeCustom?.color ?? 0x8b4513
    const roughness = shape.roughness ?? _homeCustom?.roughness ?? 0.85
    const ids = []
    for (let i = 0; i < debrisCount; i++) {
      const id = _acquirePoolPiece(
        [..._homePosition],
        appCtx.entity.rotation,
        { fracturedAsset, pieceIndex: i, mass: pieceMass, color, roughness },
        i,
        fracturedAsset
      )
      appCtx.world.applyImpulse(id, impulseFn(i, debrisCount, Math.random))
      _debrisIds.add(id)
      _debrisTimers.set(id, { age: 0, remaining: debrisLifetime > 0 ? debrisLifetime : null, lod: 'physical' })
      ids.push(id)
    }
    return ids
  }

  function _spawnDebris() {
    if (fracturedAsset) return _spawnFracturedDebris()
    const [px, py, pz] = _homePosition
    const [hx, hy, hz] = _pieceExtents()
    const shape = spec.debrisShape || {}
    const totalMass = shape.mass != null ? shape.mass * debrisCount : (_homeCustom?.mass ?? 50)
    const pieceMass = Math.max(0.1, totalMass / debrisCount)
    const color = shape.color ?? _homeCustom?.color ?? 0x8b4513
    const roughness = shape.roughness ?? _homeCustom?.roughness ?? 0.85
    const ids = []
    for (let i = 0; i < debrisCount; i++) {
      // scatter pieces slightly within the intact object's footprint so they don't all spawn co-located
      const jx = jitter(hx * 0.5), jy = jitter(hy * 0.5), jz = jitter(hz * 0.5)
      const id = _acquirePoolPiece(
        [px + jx, py + jy, pz + jz],
        appCtx.entity.rotation,
        { hx, hy, hz, mass: pieceMass, color, roughness }
      )
      appCtx.world.applyImpulse(id, impulseFn(i, debrisCount, Math.random))
      _debrisIds.add(id)
      _debrisTimers.set(id, { age: 0, remaining: debrisLifetime > 0 ? debrisLifetime : null, lod: 'physical' })
      ids.push(id)
    }
    return ids
  }

  function _despawnAllDebris() {
    for (const id of _debrisIds) _releasePoolPiece(id)
    _debrisIds.clear()
    _debrisTimers.clear()
  }

  // Fully releases the pool (real entity destroy, not a park) -- for the owning app's teardown(ctx) only
  // (hot-reload, or the intact entity itself being destroyed), never called from the normal destroy/
  // respawn cycle. Matches apps/vehicle's teardown(ctx) discipline (release native resources BEFORE
  // setup() re-runs on hot-reload) -- without it a hot-reloaded destructible would orphan its old pool's
  // entities (and their pooled Jolt bodies) with nothing left holding a reference to release them.
  function drain() {
    for (const id of _poolAll) appCtx.world.destroy(id)
    _poolAll.clear(); _poolFree.length = 0; _poolByKey.clear()
    _debrisIds.clear(); _debrisTimers.clear()
  }

  // proximity + speed scan: anything (player or dynamic entity, debris pieces excluded) within
  // impactRadius of the intact object moving at/above impactThreshold counts as a destroying impact.
  // This is deliberately simple (raw speed, not true relative closing velocity) -- precise contact
  // normals/relative velocity would need real physics-engine contact callbacks, which this engine does
  // not expose to app code (see module header).
  function _scanForImpact() {
    const [ox, oy, oz] = appCtx.entity.position
    for (const p of appCtx.players.getAll()) {
      const pp = p.state?.position; if (!pp) continue
      const dx = pp[0] - ox, dy = pp[1] - oy, dz = pp[2] - oz
      if (dx * dx + dy * dy + dz * dz > impactRadius * impactRadius) continue
      const pv = p.state?.velocity
      if (!pv) continue
      // impact() is the single trigger: it recomputes speed and destroys (returning truthy) whenever
      // speed >= impactThreshold. Matches the entity loop below, which also uses impact() as the sole gate.
      if (destructible.impact(pv)) return
    }
    const nearbyIds = appCtx.world.nearby(appCtx.entity.position, impactRadius)
    for (const id of nearbyIds) {
      if (id === appCtx.entity.id || _debrisIds.has(id)) continue
      const e = appCtx.world.getEntity(id); if (!e || !e.velocity) continue
      if (destructible.impact(e.velocity)) return
    }
  }

  const destructible = {
    get destroyed() { return _destroyed },
    get damageTaken() { return _damage },
    get health() { return health },
    get debrisIds() { return [..._debrisIds] },
    // pooled/instanced debris spawn observability: how many debris entities this destructible has ever
    // spawned (poolSize, should plateau at debrisCount after the first destruction) vs how many are
    // currently parked/idle (poolFree) -- a repeated destroy/respawn stress test should show poolSize
    // stay constant across many destructions while poolFree/active cycle, proving reuse not reallocation.
    get debrisPoolSize() { return _poolAll.size },
    get debrisPoolFree() { return _poolFree.length },

    // Introspection for the lifetime LOD state machine -- {id, age, remaining, lod} per live debris piece,
    // 'lod' is 'physical'|'frozen'|'static'. Used by the row's own live-witness harness (below) and
    // available to any caller wanting to measure/tune the LOD (e.g. a debug HUD, the perf harness).
    get debrisLOD() { return [..._debrisTimers].map(([id, st]) => ({ id, age: st.age, remaining: st.remaining, lod: st.lod })) },

    // registers raw damage; triggers destruction once accumulated damage reaches health.
    damage(amount) {
      if (_destroyed || !(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _destroyed
      _damage += amount
      if (_damage >= health) destructible.destroy()
      return _destroyed
    },

    // registers a collision/proximity impact; converts impact speed into damage via impactThreshold (an
    // impact below impactThreshold is a no-op, matching the prototype's "on impact" trigger gated by
    // speed). velocity = [x,y,z] world-space velocity of the colliding/nearby body (e.g. onCollision's
    // evt.velocity, a player's state.velocity, or another entity's .velocity).
    impact(velocity) {
      if (_destroyed || impactThreshold <= 0 || !Array.isArray(velocity)) return _destroyed
      const speed = Math.hypot(velocity[0] || 0, velocity[1] || 0, velocity[2] || 0)
      if (speed < impactThreshold) return _destroyed
      return destructible.damage(health) // any qualifying impact destroys outright, matching the prototype's one-hit tower break
    },

    // force destruction regardless of accumulated damage (explicit trigger path).
    destroy() {
      if (_destroyed) return false
      _destroyed = true
      const ids = _spawnDebris()
      // park (collider can't interfere with play) + zero-scale (real hide primitive -- custom=null
      // would render EntityLoader's orange placeholder box instead of nothing); entity/app stays alive.
      appCtx.entity.position = [_homePosition[0] + _PARK_OFFSET[0], _homePosition[1] + _PARK_OFFSET[1], _homePosition[2] + _PARK_OFFSET[2]]
      appCtx.entity.scale = [0, 0, 0]
      _respawnTimer = respawnDelay > 0 ? respawnDelay : 0
      if (typeof spec.onDestroyed === 'function') spec.onDestroyed(appCtx, ids)
      return true
    },

    // rebuilds the intact object immediately (bypasses respawnDelay countdown).
    respawn() {
      if (!_destroyed) return false
      _despawnAllDebris()
      _destroyed = false
      _damage = 0
      _respawnTimer = 0
      appCtx.entity.position = [..._homePosition]
      appCtx.entity.scale = [..._homeScale]
      if (typeof spec.onRespawn === 'function') spec.onRespawn(appCtx)
      return true
    },

    reset() {
      _despawnAllDebris()
      _destroyed = false
      _damage = 0
      _respawnTimer = 0
      appCtx.entity.position = [..._homePosition]
      appCtx.entity.scale = [..._homeScale]
    },

    // drive the debris lifetime LOD state machine (physical -> frozen -> static -> despawn), respawn
    // countdown, and the proximity impact scan; call once per server tick from update(ctx, dt).
    tick(dt) {
      if (_debrisTimers.size) {
        for (const [id, st] of _debrisTimers) {
          st.age += dt
          if (st.remaining != null) {
            st.remaining -= dt
            if (st.remaining <= 0) {
              _releasePoolPiece(id)
              _debrisIds.delete(id)
              _debrisTimers.delete(id)
              continue
            }
          }
          // 'physical' -> 'frozen': once past the settle grace period, freeze the piece to kinematic the
          // moment it's actually at rest (real Jolt velocity/angular-velocity read), OR unconditionally
          // once debrisFreezeAfter elapses even if it never settles (a wedged/jittering piece must not
          // stay a full dynamic body forever -- see the debrisFreezeAfter spec comment). world.setMotionType
          // is the cross-entity primitive (this destructible doesn't own the debris entity's own ctx).
          if (st.lod === 'physical' && st.age >= debrisSettleGrace) {
            const forceFreeze = debrisFreezeAfter > 0 && st.age >= debrisFreezeAfter
            if (forceFreeze || appCtx.world.isAtRest(id)) {
              if (appCtx.world.setMotionType(id, 'kinematic')) st.lod = 'frozen'
            }
          }
          // 'frozen' -> 'static': immediately next tick after freezing. A kinematic body still occupies a
          // broadphase entry expecting position updates; nothing ever moves a frozen debris piece again
          // under this state machine, so static is strictly cheaper (no per-tick kinematic-integration
          // consideration) and correct -- kept as its own tick rather than folded into the freeze branch
          // above so a caller diffing st.lod sees the real two-step transition, matching the row's spec'd
          // physics-simulated -> kinematic/frozen -> static -> despawn sequence explicitly.
          else if (st.lod === 'frozen') {
            if (appCtx.world.setMotionType(id, 'static')) st.lod = 'static'
          }
        }
      }
      if (_destroyed) {
        if (respawnDelay > 0) {
          _respawnTimer -= dt
          if (_respawnTimer <= 0) destructible.respawn()
        }
        return
      }
      if (impactThreshold > 0) _scanForImpact()
    },

    // Fully releases the debris pool's entities (real destroy, not a park). Call from the owning app's
    // teardown(ctx) so a hot-reload doesn't orphan this destructible's pooled entities+bodies -- see
    // drain()'s own header comment above for why this is a separate path from the normal despawn cycle.
    drain
  }

  return destructible
}

export default createDestructible
