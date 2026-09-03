// createSoftbodyCloth(spec, appCtx) -- a per-object NxM particle-grid cloth/rope primitive, mirroring
// destructible.js's own shape (spec-driven, appCtx-scoped, tick(dt)-driven). Real implementation
// follow-on from the soft-body-fluid-simulation-pbd-or-sph-via-wasm-for-destructible feasibility probe
// (resolved): that probe proved a mass-spring particle grid built from @dimforge/rapier3d-compat's joint
// primitives (RAPIER has no dedicated volumetric soft-body solver, only RigidBody+ImpulseJoint building
// blocks) sags physically plausibly under gravity while pinned points stay exactly fixed, at ~0.226ms/
// step for 36 particles + 60 springs.
//
// ARCHITECTURAL ISOLATION (matching the probe's own finding): every createSoftbodyCloth() call gets its
// OWN independent RAPIER.World instance, fully separate from this project's PRIMARY jolt-physics World
// (src/physics/World.js) that every other ctx.physics/ctx.world call routes through. No shared state, no
// cross-talk -- a softbody cloth does not collide with, or get collided with by, the rest of the game's
// physics; it is a self-contained visual/physical simulation driven purely by its own spec (gravity,
// pin points, wind) and read out as a stream of world-space particle positions. This is a deliberate
// scope boundary carried over from the probe: adding a SECOND full WASM physics engine as a live
// gameplay dependency alongside jolt-physics is a real architectural commitment (bundle size, dual-WASM
// memory, a second class of the exact embind/shared-buffer hazards already found+fixed twice in
// jolt-physics this project cycle -- see AGENTS.md's jolt-get{angularvelocity,positionrotation}-shared-
// buffer-double-destroy) -- keeping it fully isolated per-instance (never a shared/pooled World) is what
// makes that commitment safe to make incrementally, one softbody-bearing app at a time, without touching
// the primary physics engine's own lifecycle at all.
//
// RAPIER.init() IS ASYNC (WASM instantiation) -- createSoftbodyCloth() itself stays SYNCHRONOUS (matching
// every other defineX(spec) factory's call convention, see AppContext.js), returning a handle immediately
// whose tick(dt)/positions() gracefully no-op/return-null until the async init resolves. A single
// module-level RAPIER import promise is shared across every instance (WASM module instantiation itself
// is safe to share -- it is the World, RigidBody, and Joint instances that stay per-cloth-instance
// isolated, matching the probe's finding that per-instance World isolation is what matters, not avoiding
// the one-time WASM module load).
//
// WIRE / CLIENT RENDER PATH (deliberately NOT built this slice -- see the sibling PRD row this row's own
// detail named as still-needed): particle positions are published into entity.custom.softbody each tick
// they change (a flat number[] of x,y,z per row-major particle, plus cols/rows/spacing so a client CAN
// reconstruct a deformed mesh from it). entity.custom already rides the generic delta-encoded/dirty-
// detected wire path (SnapshotEncoder.js's _customV-driven dirty check, msgpackr-serialized whatever
// plain JS value is present) with ZERO new wire-protocol surface -- exactly the transport
// apps/vehicle's static custom.wheels publish and apps/destructible-debris's custom.mesh='fracturedPiece'
// use today. What is genuinely NOT yet built (needs its own slice, filed as a sibling row): a
// client/EntityLoader.js render path that takes custom.softbody and rewrites a real BufferGeometry's
// per-vertex positions from it each snapshot, instead of the GLB-model-driven mesh path every other
// entity type uses -- this is a real, distinct piece of client rendering work, not a corner this file
// cuts silently.
//
// PARTICLE-COUNT BUDGET (also flagged by this row's own detail as unmeasured beyond one 36-particle
// probe): see the stress-measurement section of this file's live verification for real multi-instance
// numbers at 36/100/225 particles, informing (not yet enforcing) a real per-world particle budget.

let _RAPIER = null
let _rapierInitPromise = null

async function _ensureRapier() {
  if (_RAPIER) return _RAPIER
  if (!_rapierInitPromise) {
    _rapierInitPromise = import('@dimforge/rapier3d-compat').then(async (mod) => {
      const RAPIER = mod.default || mod
      await RAPIER.init()
      _RAPIER = RAPIER
      return RAPIER
    })
  }
  return _rapierInitPromise
}

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[softbody] spec must be an object')
  const s = spec || {}
  if (s.cols != null && (!Number.isInteger(s.cols) || s.cols < 2)) throw new TypeError('[softbody] cols must be an integer >= 2')
  if (s.rows != null && (!Number.isInteger(s.rows) || s.rows < 2)) throw new TypeError('[softbody] rows must be an integer >= 2')
  if (s.spacing != null && (typeof s.spacing !== 'number' || !Number.isFinite(s.spacing) || s.spacing <= 0)) throw new TypeError('[softbody] spacing must be a positive finite number')
  if (s.mass != null && (typeof s.mass !== 'number' || !Number.isFinite(s.mass) || s.mass <= 0)) throw new TypeError('[softbody] mass must be a positive finite number (total cloth mass, split across particles)')
  if (s.stiffness != null && (typeof s.stiffness !== 'number' || !Number.isFinite(s.stiffness) || s.stiffness <= 0)) throw new TypeError('[softbody] stiffness must be a positive finite number')
  if (s.damping != null && (typeof s.damping !== 'number' || !Number.isFinite(s.damping) || s.damping < 0)) throw new TypeError('[softbody] damping must be a non-negative finite number')
  if (s.gravity != null && !(Array.isArray(s.gravity) && s.gravity.length === 3 && s.gravity.every(Number.isFinite))) throw new TypeError('[softbody] gravity must be a [x,y,z] array of finite numbers')
  if (s.pins != null && !Array.isArray(s.pins) && s.pins !== 'top-corners' && s.pins !== 'top-row') throw new TypeError('[softbody] pins must be an array of [col,row] pairs (or the string "top-corners"/"top-row")')
  if (s.wind != null && !(Array.isArray(s.wind) && s.wind.length === 3 && s.wind.every(Number.isFinite))) throw new TypeError('[softbody] wind must be a [x,y,z] force-per-particle array')
  if (s.substeps != null && (!Number.isInteger(s.substeps) || s.substeps < 1)) throw new TypeError('[softbody] substeps must be a positive integer')
}

// Resolves the pins spec into a Set of "col,row" keys. Accepts an explicit [[col,row],...] array or the
// two common presets a cloth/banner/flag needs: "top-corners" (just the two top corners, a flag-like
// drape) or "top-row" (the entire top edge pinned, a curtain/banner).
function _resolvePins(pins, cols, rows) {
  const out = new Set()
  if (pins == null || pins === 'top-corners') {
    out.add(`0,0`); out.add(`${cols - 1},0`)
    return out
  }
  if (pins === 'top-row') {
    for (let c = 0; c < cols; c++) out.add(`${c},0`)
    return out
  }
  if (Array.isArray(pins)) {
    for (const p of pins) {
      if (!Array.isArray(p) || p.length !== 2) continue
      out.add(`${p[0]},${p[1]}`)
    }
    return out
  }
  return out
}

// spec = {
//   cols?: number             -- particle grid columns (default 6)
//   rows?: number             -- particle grid rows (default 6)
//   spacing?: number          -- rest distance (m) between adjacent particles (default 0.3)
//   mass?: number             -- TOTAL cloth mass (kg), split evenly across every non-pinned particle (default 2)
//   stiffness?: number        -- spring stiffness passed to RAPIER.JointData.spring (default 200)
//   damping?: number          -- spring damping passed to RAPIER.JointData.spring (default 4)
//   gravity?: [x,y,z]         -- this cloth's OWN isolated world gravity (default [0,-9.81,0])
//   pins?: 'top-corners'|'top-row'|[[col,row],...] -- which grid points are fixed anchors (default 'top-corners')
//   wind?: [x,y,z]            -- constant per-particle force (N), applied every tick via addForce (default null)
//   bendSprings?: boolean     -- also add skip-one-neighbor diagonal/bend springs for stiffer, less floppy
//                                cloth (default true)
//   substeps?: number         -- physics substeps per tick(dt) call, for stability at larger dt (default 1)
// }
//
// Returns a handle: { tick(dt), positions(), pinnedKeys, ready, particleCount, setPin(col,row,pinned), dispose() }
export function createSoftbodyCloth(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[softbody] appCtx is required')

  const cols = spec.cols ?? 6
  const rows = spec.rows ?? 6
  const spacing = spec.spacing ?? 0.3
  const totalMass = spec.mass ?? 2
  const stiffness = spec.stiffness ?? 200
  const damping = spec.damping ?? 4
  const gravity = spec.gravity ?? [0, -9.81, 0]
  const wind = spec.wind ?? null
  const bendSprings = spec.bendSprings !== false
  const substeps = spec.substeps ?? 1
  const pinKeys = _resolvePins(spec.pins, cols, rows)

  const particleCount = cols * rows
  const nonPinnedCount = particleCount - pinKeys.size
  const perParticleMass = Math.max(0.01, totalMass / Math.max(1, nonPinnedCount))

  const _origin = [...appCtx.entity.position]
  const _positions = new Float64Array(particleCount * 3) // row-major x,y,z; readable even before RAPIER finishes initializing (all zero -> filled at build)
  let _ready = false
  let _disposed = false
  let _world = null
  const _bodies = [] // row-major RigidBody handles, index = row*cols+col

  function _idx(col, row) { return row * cols + col }

  async function _build() {
    const RAPIER = await _ensureRapier()
    if (_disposed) return // disposed while init was in flight
    _world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] })

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const key = `${col},${row}`
        const px = _origin[0] + col * spacing
        const py = _origin[1] - row * spacing // grid hangs downward from its origin by default
        const pz = _origin[2]
        const pinned = pinKeys.has(key)
        const desc = pinned ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()
        desc.setTranslation(px, py, pz)
        const body = _world.createRigidBody(desc)
        // Every particle gets a real collider (mass properties), pinned or not -- a fixed() body's own
        // motion is unaffected by having one (fixed bodies never move regardless of mass), but this is
        // what makes setPin() reversible in BOTH directions. Live-witnessed real bug found+fixed while
        // verifying this row: a fixed() body built with NO collider, later flipped to Dynamic via
        // setBodyType(), has zero mass properties and never falls under gravity even though isFixed()
        // correctly reports false and the joint/spring network is otherwise wired -- a genuinely inert,
        // massless dynamic body. Attaching the collider unconditionally at build time (instead of only
        // for the initially-non-pinned branch) closes that gap.
        const cd = RAPIER.ColliderDesc.ball(Math.max(0.02, spacing * 0.15)).setDensity(1).setMass(perParticleMass)
        _world.createCollider(cd, body)
        _bodies[_idx(col, row)] = body
        const i3 = _idx(col, row) * 3
        _positions[i3] = px; _positions[i3 + 1] = py; _positions[i3 + 2] = pz
      }
    }

    const structural = ([c1, r1], [c2, r2]) => {
      const bA = _bodies[_idx(c1, r1)], bB = _bodies[_idx(c2, r2)]
      const dx = (c2 - c1) * spacing, dy = (r1 - r2) * spacing, dz = 0
      const restLen = Math.hypot(dx, dy, dz)
      const params = RAPIER.JointData.spring(restLen, stiffness, damping, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
      _world.createImpulseJoint(params, bA, bB, true)
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (col + 1 < cols) structural([col, row], [col + 1, row])       // structural (horizontal)
        if (row + 1 < rows) structural([col, row], [col, row + 1])       // structural (vertical)
        if (bendSprings) {
          if (col + 2 < cols) structural([col, row], [col + 2, row])     // bend (horizontal skip-one)
          if (row + 2 < rows) structural([col, row], [col, row + 2])     // bend (vertical skip-one)
        }
      }
    }

    _ready = true
  }

  _build()

  // tick(dt): steps the isolated rapier World forward (with substeps for stability) and refreshes the
  // readable _positions buffer. No-ops silently until the async WASM init/build completes -- a caller
  // driving this from update(ctx,dt) every server tick simply sees zero movement for the few ticks
  // RAPIER.init() takes, then real simulated motion from then on.
  function tick(dt) {
    if (!_ready || _disposed || !_world) return
    const subDt = dt / substeps
    for (let s = 0; s < substeps; s++) {
      if (wind) {
        for (let i = 0; i < _bodies.length; i++) {
          const b = _bodies[i]
          if (b.isFixed()) continue
          b.resetForces(true)
          b.addForce({ x: wind[0], y: wind[1], z: wind[2] }, true)
        }
      }
      _world.timestep = subDt
      _world.step()
    }
    for (let i = 0; i < _bodies.length; i++) {
      const t = _bodies[i].translation()
      const i3 = i * 3
      _positions[i3] = t.x; _positions[i3 + 1] = t.y; _positions[i3 + 2] = t.z
    }
  }

  // Flat row-major [x0,y0,z0, x1,y1,z1, ...] world-space particle positions -- safe to call at any time
  // (returns the last-known buffer, all-at-spawn-position before the async build completes).
  function positions() { return _positions }

  // Publish the current particle positions into entity.custom.softbody, the same generic delta-encoded
  // custom-field wire path every other custom-carrying entity already rides (SnapshotEncoder.js's
  // _customV dirty-detection, zero new protocol surface). Only actually assigns (and so only bumps
  // _customV) when the positions have genuinely moved past a small epsilon since the last publish, so an
  // at-rest cloth (fully settled, e.g. all pins with no wind) does not spam a wire write every tick
  // forever -- matches destructible.js's own "don't re-encode a stable prop" discipline.
  let _lastPublished = null
  const PUBLISH_EPS = 0.0008 // meters; below this, treat the shape as visually unchanged since last publish
  function publish() {
    if (!_ready) return false
    if (_lastPublished) {
      let maxDelta = 0
      for (let i = 0; i < _positions.length; i++) {
        const d = Math.abs(_positions[i] - _lastPublished[i])
        if (d > maxDelta) maxDelta = d
      }
      if (maxDelta < PUBLISH_EPS) return false
    }
    _lastPublished = Float64Array.from(_positions)
    appCtx.entity.custom = {
      ...(appCtx.entity.custom || {}),
      softbody: { cols, rows, spacing, positions: Array.from(_positions) }
    }
    return true
  }

  // Toggle a single grid point's pin state at runtime (e.g. "cut the rope" -- unpin a corner mid-game).
  // Rebuilding a RigidBody's type in place (setBodyType) is cheaper and simpler than a full world rebuild.
  function setPin(col, row, pinned) {
    if (!_ready) return false
    const b = _bodies[_idx(col, row)]
    if (!b) return false
    b.setBodyType(pinned ? _RAPIER.RigidBodyType.Fixed : _RAPIER.RigidBodyType.Dynamic, true)
    const key = `${col},${row}`
    if (pinned) pinKeys.add(key); else pinKeys.delete(key)
    return true
  }

  // Releases this cloth's isolated RAPIER.World (and every body/joint in it) -- register via
  // appCtx._registerDisposer so it fires on detachApp/hot-reload/destroyEntity, matching health.js's and
  // steering.js's own ComponentPool-slot-release precedent for a defineX() factory's cleanup hook.
  function dispose() {
    if (_disposed) return
    _disposed = true
    if (_world) { _world.free(); _world = null }
    _bodies.length = 0
  }
  if (typeof appCtx._registerDisposer === 'function') appCtx._registerDisposer(dispose)

  return {
    get ready() { return _ready },
    get particleCount() { return particleCount },
    get pinnedKeys() { return new Set(pinKeys) },
    tick,
    positions,
    publish,
    setPin,
    dispose
  }
}

export default createSoftbodyCloth
