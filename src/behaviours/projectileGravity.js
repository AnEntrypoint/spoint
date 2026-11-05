import { readVec3 } from '../shared/vec3.js'

function refusal(code, message) {
  const err = new TypeError(`[projectile-gravity] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function stepProjectile({ position, velocity, gravity = -9.81, dt } = {}) {
  readVec3(position, 'position')
  readVec3(velocity, 'velocity')
  if (!Number.isFinite(gravity)) throw refusal('projectile-gravity-invalid', 'gravity must be finite')
  if (!Number.isFinite(dt) || dt <= 0) throw refusal('projectile-dt-invalid', 'dt must be a positive finite number')
  const half = 0.5 * gravity * dt * dt
  const nextVelocity = [velocity[0], velocity[1] + gravity * dt, velocity[2]]
  const nextPosition = [position[0] + velocity[0] * dt, position[1] + velocity[1] * dt + half, position[2] + velocity[2] * dt]
  return { position: nextPosition, velocity: nextVelocity }
}

export function sweepProjectileGravity({ from, velocity, gravity = -9.81, dt, steps = 4, raycast = null } = {}) {
  readVec3(from, 'from')
  readVec3(velocity, 'velocity')
  if (!Number.isInteger(steps) || steps < 1) throw refusal('projectile-steps-invalid', 'steps must be a positive integer')
  if (raycast !== null && typeof raycast !== 'function') throw refusal('projectile-raycast-invalid', 'raycast must be a function or null')
  const slice = dt / steps
  let state = { position: from.slice(), velocity: velocity.slice() }
  const points = [state.position.slice()]
  for (let i = 0; i < steps; i++) {
    const next = stepProjectile({ position: state.position, velocity: state.velocity, gravity, dt: slice })
    if (raycast) {
      const hit = raycast(state.position, next.position)
      if (hit) return { ok: true, hit, position: next.position, velocity: next.velocity, points }
    }
    state = next
    points.push(state.position.slice())
  }
  return { ok: true, hit: null, position: state.position, velocity: state.velocity, points }
}
