// overrides: optional per-player shallow-merge on top of the base movement config (e.g. a buff-stack
// multiplier writing {maxSpeed, jumpImpulse}) -- omitted/null is a no-op, identical to the 4-arg call.
export function applyMovement(state, input, movement, dt, overrides = null) {
  const m = overrides ? { ...movement, ...overrides } : movement
  const { maxSpeed, groundAccel, airAccel, friction, stopSpeed, jumpImpulse } = m
  const coyoteWindow = m.coyoteTime ?? 0.12
  const bufferWindow = m.jumpBuffer ?? 0.12
  let vx = state.velocity[0], vz = state.velocity[2]
  let wishX = 0, wishZ = 0, wishSpeed = 0, jumped = false

  if (state.onGround) state.coyoteRemaining = coyoteWindow
  else state.coyoteRemaining = Math.max(0, (state.coyoteRemaining || 0) - dt)
  state.bufferRemaining = Math.max(0, (state.bufferRemaining || 0) - dt)

  // Slide: pressing crouch while sprinting+moving fast on the ground triggers a short, decaying
  // speed-boosted low-profile state (reuses the existing crouch collider shrink -- state.crouch/
  // st.crouch already drives PhysicsIntegration.setCrouch regardless of WHY crouch is true, so no new
  // collider path is needed). Purely state-carried in `state.slideRemaining`/`state.sliding` so this
  // stays a pure function with no new physics/Jolt surface. Ends on timer expiry, crouch release, or
  // leaving the ground (matches soft-land/coyote conventions already in this file).
  const slideDuration = m.slideDuration ?? 0.6
  const slideMinSpeed = m.slideMinSpeed ?? (maxSpeed * 1.1)
  const slideSpeedMul = m.slideSpeedMul ?? 1.15
  const slideDecayMul = m.slideDecayMul ?? 0.35
  state.slideRemaining = Math.max(0, (state.slideRemaining || 0) - dt)
  let forceCrouch = false

  if (input) {
    let fx = 0, fz = 0
    const hasAnalog = input.analogForward !== undefined || input.analogRight !== undefined
    if (hasAnalog) { fz = input.analogForward || 0; fx = input.analogRight || 0 }
    else { if (input.forward) fz += 1; if (input.backward) fz -= 1; if (input.left) fx -= 1; if (input.right) fx += 1 }
    const rawLen = Math.sqrt(fx * fx + fz * fz)
    if (rawLen > 0) { fx /= rawLen; fz /= rawLen }
    const yaw = input.yaw || 0
    const cy = Math.cos(yaw), sy = Math.sin(yaw)
    wishX = fz * sy - fx * cy
    wishZ = fx * sy + fz * cy

    const groundSpeedNow = Math.sqrt(vx * vx + vz * vz)
    const crouchEdge = !!input.crouch && !state._crouchHeld
    if (crouchEdge && state.onGround && groundSpeedNow >= slideMinSpeed) {
      state.slideRemaining = slideDuration
    }
    state._crouchHeld = !!input.crouch
    state.sliding = state.slideRemaining > 0 && state.onGround && !!input.crouch
    if (!input.crouch) state.slideRemaining = 0
    if (state.sliding) forceCrouch = true

    const baseSpeed = (input.crouch || state.sliding) ? maxSpeed * (m.crouchSpeedMul || 0.4) : maxSpeed
    const speedMul = hasAnalog ? Math.min(1, rawLen) : 1
    wishSpeed = rawLen > 0 ? (input.sprint && !input.crouch ? (m.sprintSpeed || maxSpeed * 1.75) : baseSpeed) * speedMul : 0

    if (state.sliding) {
      // Decay the pre-slide horizontal speed toward slideDecayMul*maxSpeed over slideDuration, giving a
      // real momentum-preserving slide rather than an instant clamp -- boosted at entry (slideSpeedMul),
      // floors to a walk-crouch-speed baseline as the timer runs out.
      const t = 1 - (state.slideRemaining / slideDuration)
      const targetMul = slideSpeedMul + (slideDecayMul - slideSpeedMul) * Math.min(1, t)
      const targetSpeed = maxSpeed * targetMul
      const curSpeed = groundSpeedNow
      if (curSpeed > 0.01) {
        const scale = targetSpeed / curSpeed
        vx *= scale; vz *= scale
      } else if (rawLen > 0) {
        vx = wishX * targetSpeed; vz = wishZ * targetSpeed
      }
      wishSpeed = 0 // slide owns velocity directly this tick; skip the normal accel step below
    }

    const jumpEdge = !!input.jump && !state._jumpHeld
    state._jumpHeld = !!input.jump
    if (jumpEdge && !state.onGround && state.coyoteRemaining <= 0) state.bufferRemaining = bufferWindow
    const tryJump = (jumpEdge && (state.onGround || state.coyoteRemaining > 0)) || (state.onGround && state.bufferRemaining > 0)
    if (tryJump) {
      state.velocity[1] = jumpImpulse
      state.onGround = false
      state.coyoteRemaining = 0
      state.bufferRemaining = 0
      jumped = true
    }
  } else {
    state._jumpHeld = false
  }

  if (state.onGround && !jumped && !state.sliding) {
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
  } else if (!state.onGround && !jumped) {
    // Airborne-only: sliding-on-ground must NEVER fall into this branch (it applies the airSpeedCap
    // clamp, which previously clamped a slide's boosted >maxSpeed velocity right back down to maxSpeed,
    // silently erasing slideSpeedMul's boost every tick -- caught live via exec_js/node witness during
    // this row's verification, see sprint-slide-mechanic-movement-js PRD row).
    if (wishSpeed > 0) {
      const airCap = m.airMaxSpeed ?? wishSpeed
      const cur = vx * wishX + vz * wishZ
      let add = airCap - cur
      if (add > 0) {
        let as = airAccel * airCap * dt
        if (as > add) as = add
        vx += as * wishX; vz += as * wishZ
      }
    }
    const airSpeedCap = m.airSpeedCap ?? maxSpeed
    const horizSpeed = Math.sqrt(vx * vx + vz * vz)
    if (horizSpeed > airSpeedCap) { const s = airSpeedCap / horizSpeed; vx *= s; vz *= s }
  }

  // Leaving the ground (fell off an edge, jumped) or losing crouch/timer cancels the slide next tick's
  // check naturally via `state.onGround`/`state.slideRemaining`, but zero it explicitly here too so a
  // caller reading state.sliding this same tick (post-jump) sees the correct up-to-date value.
  if (!state.onGround) state.sliding = false

  state.velocity[0] = vx
  state.velocity[2] = vz
  return { wishX, wishZ, wishSpeed, jumped, sliding: !!state.sliding, forceCrouch }
}

export const DEFAULT_MOVEMENT = {
  maxSpeed: 7.0,
  groundAccel: 150.0,
  airAccel: 15.0,
  friction: 10.0,
  stopSpeed: 2.0,
  jumpImpulse: 5.5,
  slideDuration: 0.6,
  slideSpeedMul: 1.15,
  slideDecayMul: 0.35
}
