// createFluid3DBody(spec, appCtx) -- a per-object 3D SPH fluid-particle-emitter primitive, mirroring
// fluid.js's own spec-driven/appCtx-scoped/emitter shape, but built on SPHSolver3D (src/fluid/SPHSolver3D.js
// / src/fluid/as-src/sph3d.ts) instead of the 2D SPHSolver. Real implementation follow-on from
// sph-fluid-3d-port (resolved -- the standalone verified 3D solver, no gameplay wiring yet).
//
// GENUINE 3D VOLUME (the actual point of this file vs. the already-shipped 2D fluid.js): the 2D solver
// maps its XY plane onto world X/Z with a FIXED world Y, so every published particle's Y coordinate is
// identical -- a "puddle at a fixed height", not a real volume. This factory instead configures
// SPHSolver3D's own minX/minY/minZ/maxX/maxY/maxZ boundary box directly in WORLD space (no plane mapping,
// no fixed-Y trick) so particles genuinely fall, spread, and settle with a real varying Y per particle --
// a pool/tank/waterfall with actual vertical structure. SPHSolver3D.snapshotPositions() ALREADY returns
// flat [x,y,z] world-space triples (verified by reading src/fluid/SPHSolver3D.js directly, not assumed),
// so the wire shape below is BYTE-IDENTICAL to fluid.js's own entity.custom.fluid.positions shape -- zero
// new protocol surface, per this row's own sibling PRD note that this may already be wire-compatible.
//
// ARCHITECTURAL ISOLATION (matching fluid.js's own precedent, which itself matches softbody.js's): every
// createFluid3DBody() call gets its OWN independent SPHSolver3D instance -- SPHSolver3D inherits the
// SPHSolver.js cross-instance aliasing-safety fix for free (compiled WebAssembly.Module cached, a fresh
// WebAssembly.Instance per solver) by construction, not by re-discovering the bug.
//
// EMITTER SEMANTICS: identical to fluid.js -- spec.emitRate (particles/sec, default 0 = spawn
// spec.initialCount once) drives ongoing spawning up to a hard cap. SPHSolver3D's own MAX_PARTICLES=4096
// StaticArray capacity (mirrored from sph3d.ts, same as the 2D solver's) is the hard ceiling regardless of
// any per-instance spec.maxParticles; addParticle returns -1 past the cap, treated as "stop emitting".
//
// SPHSolver3D.init() IS ASYNC (WASM instantiation) -- createFluid3DBody() itself stays SYNCHRONOUS
// (matching every other defineX(spec) factory's call convention), returning a handle immediately whose
// tick(dt)/positions() gracefully no-op/return-empty until the async init resolves.
import { SPHSolver3D } from '../../src/fluid/SPHSolver3D.js'

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[fluid3d] spec must be an object')
  const s = spec || {}
  if (s.initialCount != null && (!Number.isInteger(s.initialCount) || s.initialCount < 0)) throw new TypeError('[fluid3d] initialCount must be a non-negative integer')
  if (s.maxParticles != null && (!Number.isInteger(s.maxParticles) || s.maxParticles < 1)) throw new TypeError('[fluid3d] maxParticles must be a positive integer')
  if (s.emitRate != null && (typeof s.emitRate !== 'number' || !Number.isFinite(s.emitRate) || s.emitRate < 0)) throw new TypeError('[fluid3d] emitRate must be a non-negative finite number')
  if (s.smoothingRadius != null && (typeof s.smoothingRadius !== 'number' || !Number.isFinite(s.smoothingRadius) || s.smoothingRadius <= 0)) throw new TypeError('[fluid3d] smoothingRadius must be a positive finite number')
  if (s.restDensity != null && (typeof s.restDensity !== 'number' || !Number.isFinite(s.restDensity) || s.restDensity <= 0)) throw new TypeError('[fluid3d] restDensity must be a positive finite number')
  if (s.gasConstant != null && (typeof s.gasConstant !== 'number' || !Number.isFinite(s.gasConstant) || s.gasConstant <= 0)) throw new TypeError('[fluid3d] gasConstant must be a positive finite number')
  if (s.viscosity != null && (typeof s.viscosity !== 'number' || !Number.isFinite(s.viscosity) || s.viscosity < 0)) throw new TypeError('[fluid3d] viscosity must be a non-negative finite number')
  if (s.gravity != null && (typeof s.gravity !== 'number' || !Number.isFinite(s.gravity))) throw new TypeError('[fluid3d] gravity must be a finite number (m/s^2 along world -Y, e.g. -9.81)')
  if (s.boundary != null) {
    const b = s.boundary
    if (typeof b !== 'object' || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]))) {
      throw new TypeError('[fluid3d] boundary must be {minX,minY,minZ,maxX,maxY,maxZ} finite numbers')
    }
    if (b.maxX <= b.minX || b.maxY <= b.minY || b.maxZ <= b.minZ) throw new TypeError('[fluid3d] boundary must have maxX>minX, maxY>minY and maxZ>minZ')
  }
}

const SOLVER_MAX_PARTICLES = 4096 // mirrors src/fluid/as-src/sph3d.ts's compile-time StaticArray capacity

// spec = {
//   boundary?: {minX,minY,minZ,maxX,maxY,maxZ}  -- world-space box the fluid is contained in (default a
//                                                   3x3x3m box centered on the entity's spawn position)
//   initialCount?: number             -- particles spawned immediately at build (default 64)
//   emitRate?: number                 -- additional particles/sec spawned continuously after build, 0 =
//                                         one-shot (default 0)
//   maxParticles?: number             -- this instance's own cap, clamped to SOLVER_MAX_PARTICLES (default
//                                         SOLVER_MAX_PARTICLES)
//   smoothingRadius/restDensity/gasConstant/viscosity  -- passed straight through to SPHSolver3D.init()
//   gravity?: number                  -- world -Y gravity magnitude sign-flipped into the solver's own
//                                         gravityY config (default -9.81)
// }
//
// Returns a handle: { ready, particleCount, tick(dt), positions(), publish(), dispose() }
export function createFluid3DBody(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[fluid3d] appCtx is required')

  const origin = [...appCtx.entity.position]
  const half = 1.5 // default 3x3x3m box, matching fluid.js's own 4x4 XZ default order of magnitude
  const boundary = spec.boundary ?? {
    minX: origin[0] - half, minY: origin[1], minZ: origin[2] - half,
    maxX: origin[0] + half, maxY: origin[1] + half * 2 * 3, maxZ: origin[2] + half
  }
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
  let _positions = new Float64Array(0) // world-space x,y,z, row-major; empty until ready

  // Seeds `count` particles on a roughly-cubic lattice near the TOP of the boundary box (a dam-break/drop
  // shape, matching the solver's own live-witnessed dam-break seeding), so an initial/emitted batch starts
  // as a physically plausible packed cluster with real headroom to fall, not stacked at a single point
  // (which would blow up the Poly6 density kernel with a divide-by-near-zero neighbor distance on step 1).
  //
  // BOUNDARY-FIT CLAMP (real bug found+fixed by sph-fluid-particle-budget-and-perf-at-scale's own live
  // measurement, same class as the 2D fluid.js fix this mirrors): the existing `y < boundary.minY` check
  // already stops seeding once a shallow box runs out of vertical room, but per-LAYER X/Z placement had no
  // equivalent check against boundary.minX/maxX/minZ/maxZ -- a wide+shallow or narrow+tall box combination
  // (both reachable via apps/fluid3d-source's own editorProp ranges, e.g. boundaryWidth=1/boundaryHeight=1
  // at initialCount>=250) let per-layer X/Z lattice cells fall outside the configured box while the Y-guard
  // was still satisfied, live-reproduced as 33-39 NaN-position particles out of a real seed. Fix: clamp
  // `spacing` (same choice as fluid.js's 2D fix -- shrink packing, never drop the caller's requested count)
  // so the per-layer X/Z half-extent (side/2 * spacing) always fits inside the boundary's own X/Z half-size
  // with a small inset margin.
  function _seed(count) {
    if (count <= 0) return
    const side = Math.max(1, Math.ceil(Math.cbrt(count)))
    const boundHalfX = (boundary.maxX - boundary.minX) / 2
    const boundHalfZ = (boundary.maxZ - boundary.minZ) / 2
    const margin = 0.9
    const idealSpacing = smoothingRadius * 0.6
    const maxSpacingForFit = (Math.min(boundHalfX, boundHalfZ) * 2 * margin) / side
    const spacing = Math.min(idealSpacing, maxSpacingForFit > 0 ? maxSpacingForFit : idealSpacing)
    const cx = (boundary.minX + boundary.maxX) / 2
    const cz = (boundary.minZ + boundary.maxZ) / 2
    const topY = boundary.maxY - spacing // start one spacing below the ceiling, real room to fall
    let placed = 0
    for (let layer = 0; placed < count; layer++) {
      for (let row = 0; row < side && placed < count; row++) {
        for (let col = 0; col < side && placed < count; col++) {
          const x = cx + (col - side / 2) * spacing
          const y = topY - layer * spacing
          const z = cz + (row - side / 2) * spacing
          if (y < boundary.minY) { _emitStopped = true; return } // box too shallow for the requested count
          const r = _solver.addParticle(x, y, z, 0, 0, 0)
          placed++
          if (r < 0) { _emitStopped = true; return } // hit SOLVER_MAX_PARTICLES mid-seed
        }
      }
    }
  }

  async function _build() {
    _solver = new SPHSolver3D()
    await _solver.init({
      smoothingRadius, restDensity, gasConstant, viscosity,
      gravityY,
      minX: boundary.minX, minY: boundary.minY, minZ: boundary.minZ,
      maxX: boundary.maxX, maxY: boundary.maxY, maxZ: boundary.maxZ,
    })
    if (_disposed) return // disposed while init was in flight
    _seed(Math.min(initialCount, maxParticles))
    _ready = true
    _refreshPositions()
  }

  _build()

  function _refreshPositions() {
    if (!_solver) return
    // SPHSolver3D.snapshotPositions() already returns flat WORLD-space [x0,y0,z0, x1,y1,z1, ...] triples
    // -- no plane-mapping/axis-remap needed, unlike the 2D wrapper's own X/worldY/Z reconstruction.
    _positions = _solver.snapshotPositions()
  }

  // tick(dt): steps the isolated SPH solver forward, emits new particles per emitRate (budget-capped by
  // maxParticles, hard-capped by the solver's own MAX_PARTICLES), and refreshes the readable positions
  // buffer. No-ops silently until the async WASM init/build completes, matching fluid.js's own gate.
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

  // Publish the current particle cloud into entity.custom.fluid -- SAME field name and SAME wire shape
  // {particleCount, positions:[x,y,z,...]} as the 2D fluid.js's own publish(), per this row's own sibling
  // PRD note verifying wire-compatibility rather than assuming it: EntityLoader.js's _buildFluidMesh/
  // _rewriteFluidMesh read custom.fluid generically and subtract originPos from ALL THREE axes already
  // (not just X/Z), so a real varying-Y cloud needs zero client-side branch -- this is the exact fact
  // sph-fluid-3d-client-render-verification exists to confirm live, not assume from reading source alone.
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
      fluid: { particleCount: _positions.length / 3, positions: Array.from(_positions) }
    }
    return true
  }

  // No native WASM handle to free (WebAssembly.Instance/Memory are garbage-collected JS objects, not
  // manually-freed native resources), but dispose() still exists for API parity with fluid.js/softbody.js.
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

export default createFluid3DBody
