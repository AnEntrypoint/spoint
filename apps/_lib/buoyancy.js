// defineBuoyancy(spec, appCtx) -> a per-tick Archimedes-style upward force + submerged linear drag for
// any dynamic physics entity, gated on the real per-world sea level (ctx.seaLevel, AppContext.js --
// frame.offsetY - frame.anchorHeight, the SAME constant client/core/UnderwaterTint.js splices into the
// underwater fog-tint shader; not a re-derived/new constant, and null on a world with no terrain/frame
// streaming, in which case buoyancy.tick(dt) is a no-op).
//
// Model: the entity is treated as a vertical capsule of half-height `halfHeight` centred on
// entity.position[1] (a box/sphere/capsule collider are all reasonably approximated this way for a simple
// Archimedes force -- a precise per-shape submerged-volume integral is out of scope, see module footer).
// submersionFrac = clamp((seaLevel - (y - halfHeight)) / (2*halfHeight), 0, 1) -- 0 fully above water,
// 1 fully submerged, linear in between as the collider crosses the surface. The upward force scales with
// submersionFrac * buoyantForce (buoyantForce defaults to entity mass * |gravity| * floatFactor, so a
// floatFactor of 1 exactly cancels gravity once fully submerged -- neutral buoyancy at floatFactor=1,
// floats up if >1, sinks (slower, still drag-damped) if <1). ctx.physics.addForce is Jolt AddImpulse
// under the hood (see AppPhysics.js), i.e. a per-tick VELOCITY step, not a continuous force -- so the
// force magnitude here is already pre-scaled by dt to read as "force" in the physically-intuitive sense
// (impulse = force * dt), matching the existing addForce call sites' convention (e.g. weapon.js knockback).
//
// Drag: submerged entities get their horizontal+vertical velocity damped each tick (velocity *= (1 -
// linearDrag*submersionFrac*dt), clamped >=0) so movement genuinely feels different underwater (a thrown
// object decelerates fast, doesn't just float at whatever speed it entered the water) -- distinct from
// Jolt's own linearDamping (constant, not submersion-gated) already exposed via ctx.physics.setLinearDamping.
//
// Call buoyancy.tick(dt) once per server tick from the owning app's update(ctx, dt) -- this object reads
// ctx.entity.position + ctx.physics.getVelocity/addForce each tick, it does not register a runtime-level
// watch (matches destructible.js/pickup.js's tick(dt) convention).
//
// OUT OF SCOPE (explicit, this row is buoyancy alone): no vehicle-hull/boat-specific handling (righting
// moment, hull drag coefficients), no pre-fractured destructible-in-water interaction, no raycast audio
// occlusion under the water surface. A precise per-collider-shape submerged-volume integral (vs. the
// vertical-capsule approximation here) is also out of scope -- the approximation is accurate enough for
// "does this feel like water" and matches the box-shard-style simplification destructible.js already
// documents as its own precedent for this codebase.

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[buoyancy] spec must be an object')
  const s = spec || {}
  if (s.halfHeight != null && (typeof s.halfHeight !== 'number' || !Number.isFinite(s.halfHeight) || s.halfHeight <= 0)) {
    throw new TypeError('[buoyancy] halfHeight must be a positive finite number')
  }
  if (s.floatFactor != null && (typeof s.floatFactor !== 'number' || !Number.isFinite(s.floatFactor) || s.floatFactor < 0)) {
    throw new TypeError('[buoyancy] floatFactor must be a non-negative finite number')
  }
  if (s.linearDrag != null && (typeof s.linearDrag !== 'number' || !Number.isFinite(s.linearDrag) || s.linearDrag < 0)) {
    throw new TypeError('[buoyancy] linearDrag must be a non-negative finite number')
  }
  if (s.buoyantForce != null && (typeof s.buoyantForce !== 'number' || !Number.isFinite(s.buoyantForce) || s.buoyantForce < 0)) {
    throw new TypeError('[buoyancy] buoyantForce must be a non-negative finite number')
  }
}

// spec = {
//   halfHeight?: number     -- vertical half-extent of the submersion-test capsule (default 0.5, matches
//                              the destructible.js/box-dynamic default half-extent)
//   floatFactor?: number    -- multiplier on (mass*|gravity|) for the fully-submerged upward force; 1 =
//                              neutral buoyancy, >1 floats, <1 sinks slower than in air (default 1.2, a
//                              mild net-positive float so a resting object visibly bobs back up)
//   buoyantForce?: number   -- explicit fully-submerged upward force (N), overrides floatFactor entirely
//   linearDrag?: number     -- submerged velocity damping coefficient, 1/s (default 2.0)
// }
export function defineBuoyancy(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[buoyancy] appCtx is required')

  const halfHeight = spec.halfHeight ?? 0.5
  const floatFactor = spec.floatFactor ?? 1.2
  const linearDrag = spec.linearDrag ?? 2.0
  const explicitForce = spec.buoyantForce ?? null

  let _lastSubmersionFrac = 0

  const buoyancy = {
    get submersionFrac() { return _lastSubmersionFrac },
    get submerged() { return _lastSubmersionFrac > 0 },

    tick(dt) {
      const seaLevel = appCtx.seaLevel
      if (seaLevel == null || !(dt > 0)) { _lastSubmersionFrac = 0; return }
      const pos = appCtx.entity.position
      if (!pos) { _lastSubmersionFrac = 0; return }
      // Curvature sagitta (see UnderwaterTint.js / PhysicsIntegration._submersionFrac): the water surface
      // is a sphere of radius frame.radius, so the effective waterline drops d^2/(2R) with horizontal
      // distance from the anchor -- without this the entity floats at a different height than the
      // rendered shoreline away from the spawn anchor.
      const frame = appCtx._runtime?._physics?._planetFrame
      const radius = Number.isFinite(frame?.radius) && frame.radius > 0 ? frame.radius : Infinity
      const waterlineY = seaLevel - (pos[0] * pos[0] + pos[2] * pos[2]) / (2 * radius)
      const y = pos[1]
      const bottomY = y - halfHeight
      const span = 2 * halfHeight
      const submersionFrac = Math.max(0, Math.min(1, (waterlineY - bottomY) / span))
      _lastSubmersionFrac = submersionFrac
      if (submersionFrac <= 0) return

      const gravityY = Math.abs((appCtx.world.gravity && appCtx.world.gravity[1]) || 9.81)
      const mass = appCtx.entity.custom?.mass ?? 1
      const fullForce = explicitForce != null ? explicitForce : mass * gravityY * floatFactor
      const upward = fullForce * submersionFrac * dt
      if (upward > 0) appCtx.physics.addForce([0, upward, 0])

      if (linearDrag > 0) {
        const v = appCtx.physics.getVelocity()
        const damp = Math.max(0, 1 - linearDrag * submersionFrac * dt)
        appCtx.physics.setVelocity([v[0] * damp, v[1] * damp, v[2] * damp])
      }
    }
  }

  return buoyancy
}

export default defineBuoyancy
