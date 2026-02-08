export function applyMovement(state, input, movement, dt) {
  const { maxSpeed, groundAccel, airAccel, friction, stopSpeed, jumpImpulse } = movement
  let vx = state.velocity[0], vz = state.velocity[2]
  let wishX = 0, wishZ = 0, wishSpeed = 0, jumped = false

  if (input) {
    let fx = 0, fz = 0
    if (input.forward) fz += 1
    if (input.backward) fz -= 1
    if (input.left) fx -= 1
    if (input.right) fx += 1
    const flen = Math.sqrt(fx * fx + fz * fz)
    if (flen > 0) { fx /= flen; fz /= flen }
    const yaw = input.yaw || 0
    const cy = Math.cos(yaw), sy = Math.sin(yaw)
    wishX = fz * sy - fx * cy
    wishZ = fx * sy + fz * cy
    wishSpeed = flen > 0 ? (input.sprint ? (movement.sprintSpeed || maxSpeed * 2.0) : maxSpeed) : 0
    if (input.jump && state.onGround) {
      state.velocity[1] = jumpImpulse
      state.onGround = false
      jumped = true
    }
  }

  if (state.onGround && !jumped) {
    const speed = Math.sqrt(vx * vx + vz * vz)
    if (speed > 0.1) {
      const control = speed < stopSpeed ? stopSpeed : speed
      const drop = control * friction * dt
      let newSpeed = speed - drop
      if (newSpeed < 0) newSpeed = 0
      const scale = newSpeed / speed
      vx *= scale; vz *= scale
    } else { vx = 0; vz = 0 }
    if (wishSpeed > 0) {
      const cur = vx * wishX + vz * wishZ
      let add = wishSpeed - cur
      if (add > 0) {
        let as = groundAccel * wishSpeed * dt
        if (as > add) as = add
        vx += as * wishX; vz += as * wishZ
      }
    }
  } else {
    if (wishSpeed > 0) {
      const cur = vx * wishX + vz * wishZ
      let add = wishSpeed - cur
      if (add > 0) {
        let as = airAccel * wishSpeed * dt
        if (as > add) as = add
        vx += as * wishX; vz += as * wishZ
      }
    }
  }

  state.velocity[0] = vx
  state.velocity[2] = vz
  return { wishX, wishZ, wishSpeed, jumped }
}

export const DEFAULT_MOVEMENT = {
  maxSpeed: 8.0,
  groundAccel: 10.0,
  airAccel: 1.0,
  friction: 6.0,
  stopSpeed: 2.0,
  jumpImpulse: 4.5
}
