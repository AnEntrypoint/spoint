import { applyMovement } from './movement.js'

export let GROUND_FOLLOW_STEP_M = 0.35
const MIN_WALKABLE_NORMAL_Y = 0.5

export function verticalVelocity(vy, wasGrounded, gravityY, dt) {
  return wasGrounded ? (vy > 0 ? vy : 0) : vy + gravityY * dt
}

function slopeRise(n, dx, dz) {
  if (!n || !(n[1] >= MIN_WALKABLE_NORMAL_Y)) return 0
  return -(n[0] * dx + n[2] * dz) / n[1]
}

export let WALL_HEIGHT_REACH_M = 1.5
export let WALL_UNPROVEN_REACH_M = 0.3

function slideAlongWalls(p, walls, extentM) {
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i]
    const t = w.nx * p[2] - w.nz * p[0]
    const reach = Math.min(extentM, WALL_UNPROVEN_REACH_M + w.tMax - w.tMin)
    if (t < w.tMin - reach || t > w.tMax + reach) continue
    if (Math.abs(p[1] - w.ay) > WALL_HEIGHT_REACH_M) continue
    const s = w.nx * p[0] + w.nz * p[2] - w.d
    if (s >= 0) continue
    p[0] -= w.nx * s; p[2] -= w.nz * s
  }
}

function projectOutOfWedge(v, wedgeNormal) {
  const nx = wedgeNormal ? wedgeNormal[0] : 0
  const nz = wedgeNormal ? wedgeNormal[1] : 0
  const into = v[0] * nx + v[2] * nz
  if (into < 0) { v[0] -= nx * into; v[2] -= nz * into }
}

function stepCollider(state, input, dt, env, wasGrounded) {
  if (!env.wedged) { env.collider.step(state, input, dt, env.gravityY, wasGrounded); return }
  const v = state.velocity, vx = v[0], vz = v[2]
  projectOutOfWedge(v, env.wedgeNormal)
  env.collider.step(state, input, dt, env.gravityY, wasGrounded)
  v[0] = vx; v[2] = vz
}

export function predictCharacterStep(state, input, movement, dt, env) {
  const wasGrounded = !!state.onGround
  const result = applyMovement(state, input, movement, dt)
  if (env.collider) { stepCollider(state, input, dt, env, wasGrounded); return result }
  if (input) { state._physCrouch = !!input.crouch; state._crouchDy = 0 }
  const v = state.velocity, p = state.position
  const vy = verticalVelocity(v[1], wasGrounded, env.gravityY, dt)
  v[1] = vy
  let mx = v[0], mz = v[2]
  if (env.wedged) {
    const nx = env.wedgeNormal ? env.wedgeNormal[0] : 0
    const nz = env.wedgeNormal ? env.wedgeNormal[1] : 0
    const into = mx * nx + mz * nz
    if (into < 0) { mx -= nx * into; mz -= nz * into }
  }
  const dx = mx * dt, dz = mz * dt
  p[0] += dx; p[2] += dz
  p[1] += vy * dt
  if (env.walls) slideAlongWalls(p, env.walls, env.wallExtentM)
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

const _hotSwapCharacterStep = (next) => {
  GROUND_FOLLOW_STEP_M = next.GROUND_FOLLOW_STEP_M
  verticalVelocity = next.verticalVelocity
  WALL_HEIGHT_REACH_M = next.WALL_HEIGHT_REACH_M
  WALL_UNPROVEN_REACH_M = next.WALL_UNPROVEN_REACH_M
  predictCharacterStep = next.predictCharacterStep
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapCharacterStep)
