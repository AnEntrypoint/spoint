import { parseDefineSpec, DEFINE_SPEC_SCHEMAS } from './specBoundary.js'

export function defineBuoyancy(spec = {}, appCtx = null) {
  spec = parseDefineSpec('defineBuoyancy', spec, DEFINE_SPEC_SCHEMAS.buoyancy)
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
      const waterlineY = appCtx.seaLevel
      if (waterlineY == null || !(dt > 0)) { _lastSubmersionFrac = 0; return }
      const y = appCtx.entity.position[1]
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
