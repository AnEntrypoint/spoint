// createFluidBody(spec, appCtx) -- a per-object 2D SPH fluid-particle-emitter primitive, mirroring
// softbody.js's own shape exactly (spec-driven, appCtx-scoped, tick(dt)-driven, publish() into
// entity.custom over the existing generic wire path). Real implementation follow-on from
// sph-fluid-simulation-from-scratch-wasm-no-library-available (resolved -- see src/fluid/SPHSolver.js /
// src/fluid/as-src/sph.ts for the underlying real WASM WCSPH solver and its own live-witnessed physics).
//
// ARCHITECTURAL ISOLATION (matching softbody.js's own precedent): every createFluidBody() call gets its
// OWN independent SPHSolver instance -- SPHSolver.js already found+fixed a real cross-instance
// state-aliasing bug (two solvers sharing one WebAssembly.Instance silently aliased particle buffers) by
// caching only the compiled WebAssembly.Module and instantiating fresh per solver; this factory just
// calls `new SPHSolver().init(...)` once per fluid body, inheriting that isolation for free. A fluid body
// does not interact with jolt-physics or with any other fluid body's particles.
//
// 2D-ONLY (deliberate, matching the solver's own documented scope boundary -- see sph-fluid-3d-port):
// the solver simulates in an X/Y plane. This factory maps that plane onto WORLD X/Z (a horizontal pool/
// puddle on the ground, the most common "placeable fluid" use case) with a fixed world Y (spec.worldY,
// default the entity's own spawn Y) -- so `positions()`/the published wire buffer are real WORLD-SPACE
// [x,y,z] triples a client can drop straight into a mesh, even though the underlying solver only ever
// sees 2 free dimensions.
//
// EMITTER SEMANTICS (the real design decision this row's own PRD detail flagged as needed): unlike
// softbody's fixed NxM grid built once, a fluid source is more naturally an ONGOING emitter -- spawning
// new particles over time up to a hard cap, not a one-shot fixed count. spec.emitRate (particles/sec,
// default 0 = spawn spec.initialCount once and never again) drives this; SPHSolver's own MAX_PARTICLES=
// 4096 StaticArray capacity is the hard ceiling regardless of any per-instance spec.maxParticles (which
// can only lower it further, never raise it) -- addParticle returns -1 past the WASM-side cap, which this
// factory treats as "stop emitting", not a thrown error (a fluid source running into the ceiling is an
// expected steady-state, not a bug).
//
// SPHSolver.init() IS ASYNC (WASM instantiation) -- createFluidBody() itself stays SYNCHRONOUS (matching
// every other defineX(spec) factory's call convention), returning a handle immediately whose
// tick(dt)/positions() gracefully no-op/return-empty until the async init resolves, exactly like
// softbody.js's own `_ready` gate.
import { SPHSolver } from '../../src/fluid/SPHSolver.js'

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[fluid] spec must be an object')
  const s = spec || {}
  if (s.initialCount != null && (!Number.isInteger(s.initialCount) || s.initialCount < 0)) throw new TypeError('[fluid] initialCount must be a non-negative integer')
  if (s.maxParticles != null && (!Number.isInteger(s.maxParticles) || s.maxParticles < 1)) throw new TypeError('[fluid] maxParticles must be a positive integer')
  if (s.emitRate != null && (typeof s.emitRate !== 'number' || !Number.isFinite(s.emitRate) || s.emitRate < 0)) throw new TypeError('[fluid] emitRate must be a non-negative finite number')
  if (s.smoothingRadius != null && (typeof s.smoothingRadius !== 'number' || !Number.isFinite(s.smoothingRadius) || s.smoothingRadius <= 0)) throw new TypeError('[fluid] smoothingRadius must be a positive finite number')
  if (s.restDensity != null && (typeof s.restDensity !== 'number' || !Number.isFinite(s.restDensity) || s.restDensity <= 0)) throw new TypeError('[fluid] restDensity must be a positive finite number')
  if (s.gasConstant != null && (typeof s.gasConstant !== 'number' || !Number.isFinite(s.gasConstant) || s.gasConstant <= 0)) throw new TypeError('[fluid] gasConstant must be a positive finite number')
  if (s.viscosity != null && (typeof s.viscosity !== 'number' || !Number.isFinite(s.viscosity) || s.viscosity < 0)) throw new TypeError('[fluid] viscosity must be a non-negative finite number')
  if (s.gravity != null && (typeof s.gravity !== 'number' || !Number.isFinite(s.gravity))) throw new TypeError('[fluid] gravity must be a finite number (m/s^2 along world -Y, e.g. -9.81)')
  if (s.boundary != null) {
    const b = s.boundary
    if (typeof b !== 'object' || !['minX', 'minZ', 'maxX', 'maxZ'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]))) {
      throw new TypeError('[fluid] boundary must be {minX,minZ,maxX,maxZ} finite numbers')
    }
    if (b.maxX <= b.minX || b.maxZ <= b.minZ) throw new TypeError('[fluid] boundary must have maxX>minX and maxZ>minZ')
  }
  if (s.worldY != null && (typeof s.worldY !== 'number' || !Number.isFinite(s.worldY))) throw new TypeError('[fluid] worldY must be a finite number')
}

const SOLVER_MAX_PARTICLES = 4096 // mirrors src/fluid/as-src/sph.ts's compile-time StaticArray capacity

// spec = {
//   boundary?: {minX,minZ,maxX,maxZ}  -- world-space XZ footprint the fluid is contained in (default a
//                                         4x4m box centered on the entity's spawn XZ)
//   worldY?: number                   -- fixed world Y the 2D sim plane maps onto (default entity spawn Y)
//   initialCount?: number             -- particles spawned immediately at build (default 64)
//   emitRate?: number                 -- additional particles/sec spawned continuously after build, 0 =
//                                         one-shot (default 0)
//   maxParticles?: number             -- this instance's own cap, clamped to SOLVER_MAX_PARTICLES (default
//                                         SOLVER_MAX_PARTICLES)
//   smoothingRadius/restDensity/gasConstant/viscosity  -- passed straight through to SPHSolver.init()
//   gravity?: number                  -- world -Y gravity magnitude sign-flipped into the solver's own
//                                         gravityY config (default -9.81)
// }
//
// Returns a handle: { ready, particleCount, tick(dt), positions(), publish(), dispose() }
export function createFluidBody(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[fluid] appCtx is required')

  const origin = [...appCtx.entity.position]
  const worldY = spec.worldY ?? origin[1]
  const boundary = spec.boundary ?? { minX: origin[0] - 2, minZ: origin[2] - 2, maxX: origin[0] + 2, maxZ: origin[2] + 2 }
  const initialCount = spec.initialCount ?? 64
  const emitRate = spec.emitRate ?? 0
  const maxParticles = Math.min(spec.maxParticles ?? SOLVER_MAX_PARTICLES, SOLVER_MAX_PARTICLES)
  const smoothingRadius = spec.smoothingRadius ?? 0.5
  const restDensity = spec.restDensity ?? 1000.0
  const gasConstant = spec.gasConstant ?? 1000.0
  const viscosity = spec.viscosity ?? 3.5
  const gravityY = spec.gravity ?? -9.81

  let _solver = null
  let _ready = false
  let _disposed = false
  let _emitAccumulator = 0
  let _emitStopped = false // set once addParticle first returns -1 (cap reached) -- stop retrying every tick
  let _positions = new Float64Array(0) // world-space x,y,z, row-major; empty (not stale-3D) until ready

  // Seeds `count` particles on a roughly-square lattice inside the boundary's XZ footprint (mirroring the
  // solver's own live-witnessed dam-break-block seeding shape) so an initial/emitted batch starts as a
  // physically plausible packed cluster, not particles stacked at a single point (which would blow up the
  // Poly6 density kernel with a divide-by-near-zero neighbor distance on step 1).
  //
  // BOUNDARY-FIT CLAMP (real bug found+fixed by sph-fluid-particle-budget-and-perf-at-scale's own live
  // measurement): the requested lattice's own half-extent (cols/2 * spacing) can exceed the configured
  // boundary's half-size once initialCount/maxParticles is set high relative to a small boundary -- e.g.
  // the shipped apps/fluid-source default (boundarySize=4, smoothingRadius=0.5) only has physical room for
  // ~180 particles on this spacing before an UNCLAMPED lattice starts placing particles OUTSIDE the
  // solver's own configured min/max box. The solver's addParticle has no bounds-check against its own
  // boundary (only MAX_PARTICLES capacity is enforced), so an out-of-bounds seed silently destabilizes:
  // live-reproduced as a deterministic, reproducible NaN-position particle subset within ~20 steps (not a
  // rare edge case -- 300 particles in the shipped default box produced 32/300 NaN every run). Fix: if the
  // requested lattice would overflow, shrink `spacing` (never the particle count -- count is the caller's
  // explicit request) so the WHOLE lattice fits inside the boundary with a small inset margin, packing
  // tighter rather than spilling out. This trades a denser-than-configured smoothingRadius-relative spacing
  // for a guaranteed-stable seed; it does not change smoothingRadius/restDensity/gasConstant themselves.
  function _seed(count) {
    if (count <= 0) return
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
    const boundHalfX = (boundary.maxX - boundary.minX) / 2
    const boundHalfZ = (boundary.maxZ - boundary.minZ) / 2
    const margin = 0.9 // keep the lattice edge slightly inside the box, not flush against it
    const idealSpacing = smoothingRadius * 0.6
    const maxSpacingForFit = (Math.min(boundHalfX, boundHalfZ) * 2 * margin) / cols
    const spacing = Math.min(idealSpacing, maxSpacingForFit > 0 ? maxSpacingForFit : idealSpacing)
    const cx = (boundary.minX + boundary.maxX) / 2
    const cz = (boundary.minZ + boundary.maxZ) / 2
    let placed = 0
    for (let row = 0; placed < count; row++) {
      for (let col = 0; col < cols && placed < count; col++) {
        const x = cx + (col - cols / 2) * spacing
        const z = cz + (row - cols / 2) * spacing
        const r = _solver.addParticle(x, z, 0, 0)
        placed++
        if (r < 0) { _emitStopped = true; return } // hit SOLVER_MAX_PARTICLES mid-seed
      }
    }
  }

  async function _build() {
    _solver = new SPHSolver()
    await _solver.init({
      smoothingRadius, restDensity, gasConstant, viscosity,
      gravityY,
      minX: boundary.minX, minY: boundary.minZ, maxX: boundary.maxX, maxY: boundary.maxZ,
    })
    if (_disposed) return // disposed while init was in flight
    _seed(Math.min(initialCount, maxParticles))
    _ready = true
    _refreshPositions()
  }

  _build()

  function _refreshPositions() {
    if (!_solver) return
    const flat = _solver.snapshotPositions() // [x0,y0, x1,y1, ...] in the solver's own 2D plane
    const n = flat.length / 2
    const out = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      out[i * 3] = flat[i * 2]       // solver X -> world X
      out[i * 3 + 1] = worldY        // fixed world Y plane
      out[i * 3 + 2] = flat[i * 2 + 1] // solver Y -> world Z
    }
    _positions = out
  }

  // tick(dt): steps the isolated SPH solver forward, emits new particles per emitRate (budget-capped by
  // maxParticles, hard-capped by the solver's own MAX_PARTICLES), and refreshes the readable positions
  // buffer. No-ops silently until the async WASM init/build completes, matching softbody.js's own gate.
  function tick(dt) {
    if (!_ready || _disposed || !_solver) return
    if (emitRate > 0 && !_emitStopped && _solver.particleCount < maxParticles) {
      _emitAccumulator += emitRate * dt
      const toEmit = Math.floor(_emitAccumulator)
      if (toEmit > 0) {
        _emitAccumulator -= toEmit
        const room = maxParticles - _solver.particleCount
        _seed(Math.min(toEmit, room))
      }
    }
    _solver.step(dt)
    _refreshPositions()
  }

  // World-space [x,y,z, ...] row-major particle positions -- safe to call at any time (returns an empty
  // buffer before the async build completes, matching the "no stale/wrong-shape data" discipline).
  function positions() { return _positions }

  // Publish the current particle cloud into entity.custom.fluid, the same generic delta-encoded
  // custom-field wire path every other custom-carrying entity already rides (SnapshotEncoder.js's _customV
  // dirty-detection, msgpackr-serialized, zero new protocol surface -- see softbody.js's own publish() for
  // the identical precedent this mirrors). Only actually assigns (bumping _customV) when the particle
  // COUNT changed (an emitter growing) or positions moved past a small epsilon since the last publish, so
  // a settled/at-rest pool with a saturated emitter does not spam a wire write every tick forever.
  let _lastPublished = null
  const PUBLISH_EPS = 0.0008 // meters; below this, treat the cloud as visually unchanged since last publish
  function publish() {
    if (!_ready) return false
    if (_lastPublished && _lastPublished.length === _positions.length) {
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
      // smoothingRadius travels on the wire (sph-fluid-client-render-metaball-surface-evaluation): the
      // client-side metaball/marching-squares surface reconstruction (client/core/FluidSurface.js) needs
      // this exact value to shape its scalar-field kernel consistently with the physics that produced
      // these positions -- without it, a client would have to guess/default, silently mismatching any
      // entity whose spec.smoothingRadius differs from that default (fluid-source's own editorProps expose
      // a 0.1-2 range, so this is a real, reachable case, not a hypothetical). One extra scalar per publish.
      fluid: { particleCount: _positions.length / 3, positions: Array.from(_positions), smoothingRadius }
    }
    return true
  }

  // No native WASM handle to free (unlike softbody's rapier World -- WebAssembly.Instance/Memory are
  // garbage-collected JS objects, not manually-freed native resources), but dispose() still exists for
  // API parity with softbody.js and to make future teardown-needing state (e.g. a pooled solver) a
  // non-breaking addition; it stops tick()/emission from doing further work post-teardown.
  function dispose() {
    if (_disposed) return
    _disposed = true
    _solver = null
  }
  if (typeof appCtx._registerDisposer === 'function') appCtx._registerDisposer(dispose)

  return {
    get ready() { return _ready },
    get particleCount() { return _positions.length / 3 },
    tick,
    positions,
    publish,
    dispose
  }
}

export default createFluidBody
