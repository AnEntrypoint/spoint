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
      const frame = appCtx._runtime?._physics?._planetFrame
      const radius = Number.isFinite(frame?.radius) && frame.radius > 0 ? frame.radius : Infinity
      const curvatureSagitta = (pos[0] * pos[0] + pos[2] * pos[2]) / (2 * radius)
      const waterlineY = seaLevel - curvatureSagitta
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
