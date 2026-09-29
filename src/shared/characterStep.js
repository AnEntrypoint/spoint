import { applyMovement } from './movement.js'

export const GROUND_FOLLOW_STEP_M = 0.35
const MIN_WALKABLE_NORMAL_Y = 0.5

export function verticalVelocity(vy, wasGrounded, gravityY, dt) {
  return wasGrounded ? (vy > 0 ? vy : 0) : vy + gravityY * dt
}

function slopeRise(n, dx, dz) {
  if (!n || !(n[1] >= MIN_WALKABLE_NORMAL_Y)) return 0
  return -(n[0] * dx + n[2] * dz) / n[1]
}

export function predictCharacterStep(state, input, movement, dt, env) {
  const wasGrounded = !!state.onGround
  const result = applyMovement(state, input, movement, dt)
  const v = state.velocity, p = state.position
  const vy = verticalVelocity(v[1], wasGrounded, env.gravityY, dt)
  v[1] = vy
  const dx = env.wedged ? 0 : v[0] * dt, dz = env.wedged ? 0 : v[2] * dt
  p[0] += dx; p[2] += dz
  p[1] += vy * dt
  const sampled = env.ground ? env.ground(p[0], p[2], p[1]) : null
  const rise = wasGrounded && !result.jumped ? slopeRise(env.groundNormal, dx, dz) : 0
  const floor = Number.isFinite(sampled) ? sampled : (Number.isFinite(state.groundY) ? state.groundY + rise : NaN)
  if (Number.isFinite(floor)) {
    const stillGrounded = wasGrounded && !result.jumped && vy <= 0 && p[1] - floor <= GROUND_FOLLOW_STEP_M
    const landed = !wasGrounded && vy <= 0 && p[1] <= floor
    if (stillGrounded || landed) { p[1] = floor; v[1] = 0; state.onGround = true }
    else state.onGround = false
  } else state.onGround = wasGrounded && !result.jumped
  if (state.onGround) state.groundY = p[1]
  return result
}
