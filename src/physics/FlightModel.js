const DEFAULTS = Object.freeze({
  airDensity: 1.225,
  wingArea: 10,
  liftSlope: 4.5,
  maxLiftCoeff: 1.4,
  parasiteDrag: 0.03,
  inducedDragFactor: 0.04,
  thrust: 0,
  stallSpeed: 0,
})

export function rotateByQuat(q, v) {
  const [qx, qy, qz, qw] = q
  const [vx, vy, vz] = v
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

export function flightForces({ velocity, rotation }, opts = {}) {
  const p = { ...DEFAULTS, ...opts }
  const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
  const forward = rotateByQuat(rotation, [0, 0, 1])
  const up = rotateByQuat(rotation, [0, 1, 0])
  const qDyn = 0.5 * p.airDensity * speed * speed
  const inv = speed > 0 ? 1 / speed : 0
  const vHat = [velocity[0] * inv, velocity[1] * inv, velocity[2] * inv]
  const cosAoa = Math.min(1, Math.max(-1, forward[0] * vHat[0] + forward[1] * vHat[1] + forward[2] * vHat[2]))
  const aoa = Math.acos(cosAoa)
  const aoaSign = Math.sign(up[0] * vHat[0] + up[1] * vHat[1] + up[2] * vHat[2]) || 1
  const liftCoeff = Math.min(p.maxLiftCoeff, p.liftSlope * Math.sin(aoa)) * -aoaSign
  const liftMagnitude = liftCoeff * qDyn * p.wingArea
  const liftDir = [up[0] - vHat[0] * (up[0] * vHat[0] + up[1] * vHat[1] + up[2] * vHat[2]),
    up[1] - vHat[1] * (up[0] * vHat[0] + up[1] * vHat[1] + up[2] * vHat[2]),
    up[2] - vHat[2] * (up[0] * vHat[0] + up[1] * vHat[1] + up[2] * vHat[2])]
  const liftLen = Math.hypot(liftDir[0], liftDir[1], liftDir[2]) || 1
  const cd = p.parasiteDrag + p.inducedDragFactor * liftCoeff * liftCoeff
  const dragMagnitude = cd * qDyn * p.wingArea
  const thrustMagnitude = p.thrust
  const force = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    force[i] = (liftDir[i] / liftLen) * liftMagnitude
      - vHat[i] * dragMagnitude
      + forward[i] * thrustMagnitude
  }
  return { force, speed, aoa, liftCoeff, stalled: speed < p.stallSpeed }
}
