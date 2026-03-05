export function applyMovement(state, input, movement, dt, cy, sy) {
  const maxSpeed = movement.maxSpeed, groundAccel = movement.groundAccel, airAccel = movement.airAccel, friction = movement.friction, stopSpeed = movement.stopSpeed, jumpImpulse = movement.jumpImpulse
  const vel = state.velocity; let vx = vel[0], vz = vel[2]; if (vx === 0 && vz === 0 && !input) return
  let wishX = 0, wishZ = 0, wishSpeed = 0, jumped = false
  if (input) {
    let fx = 0, fz = 0
    if (input.forward) fz += 1
    if (input.backward) fz -= 1
    if (input.left) fx -= 1
    if (input.right) fx += 1
    const flen = Math.sqrt(fx * fx + fz * fz)
    if (flen > 0) {
      fx /= flen; fz /= flen; const c = cy !== undefined ? cy : Math.cos(input.yaw || 0), s = sy !== undefined ? sy : Math.sin(input.yaw || 0)
      wishX = fz * s - fx * c; wishZ = fx * s + fz * c; const base = input.crouch ? maxSpeed * (movement.crouchSpeedMul || 0.4) : maxSpeed
      wishSpeed = input.sprint && !input.crouch ? (movement.sprintSpeed || maxSpeed * 1.75) : base
    }
    if (input.jump && state.onGround) {
      vel[1] = jumpImpulse
      state.onGround = false
      jumped = true
    }
  }

  const speed2 = vx * vx + vz * vz
  if (state.onGround && !jumped) {
    if (speed2 > 0.001) {
      const speed = Math.sqrt(speed2), control = speed < stopSpeed ? stopSpeed : speed, drop = control * friction * dt, scale = Math.max(0, speed - drop) / speed
      vx *= scale; vz *= scale
    } else { vx = 0; vz = 0; if (!input || wishSpeed === 0) { vel[0] = 0; vel[2] = 0; return } }
    if (wishSpeed > 0) { const cur = vx * wishX + vz * wishZ, add = wishSpeed - cur; if (add > 0) { const as = Math.min(add, groundAccel * wishSpeed * dt); vx += as * wishX; vz += as * wishZ } }
  } else if (wishSpeed > 0) { const cur = vx * wishX + vz * wishZ, add = wishSpeed - cur; if (add > 0) { const as = Math.min(add, airAccel * wishSpeed * dt); vx += as * wishX; vz += as * wishZ } }
  vel[0] = vx; vel[2] = vz
}

export const DEFAULT_MOVEMENT = {
  maxSpeed: 8.0,
  groundAccel: 10.0,
  airAccel: 1.0,
  friction: 6.0,
  stopSpeed: 2.0,
  jumpImpulse: 4.5
}
