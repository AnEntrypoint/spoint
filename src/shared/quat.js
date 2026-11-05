function refusal(code, message) {
  const err = new TypeError(`[quat] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function readQuat(value, name = 'value') {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) throw refusal('quat-invalid', `${name} must be an array of four finite numbers`)
  return value
}

export function readVec3(value, name = 'value') {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw refusal('quat-vec-invalid', `${name} must be an array of three finite numbers`)
  return value
}

export function normalize(q) {
  readQuat(q, 'q')
  const len = Math.hypot(...q)
  if (len === 0) throw refusal('quat-zero-length', 'cannot normalize a zero quaternion')
  return q.map(c => c / len)
}

export function conjugate(q) {
  const [x, y, z, w] = readQuat(q, 'q')
  return [-x, -y, -z, w]
}

export function multiply(a, b) {
  const [ax, ay, az, aw] = readQuat(a, 'a')
  const [bx, by, bz, bw] = readQuat(b, 'b')
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function rotate(q, v) {
  const [qx, qy, qz, qw] = normalize(readQuat(q, 'q'))
  const [vx, vy, vz] = readVec3(v, 'v')
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ]
}

export function fromAxisAngle(axis, angle) {
  readVec3(axis, 'axis')
  if (!Number.isFinite(angle)) throw refusal('quat-angle-invalid', 'angle must be finite')
  const len = Math.hypot(...axis)
  if (len === 0) throw refusal('quat-axis-zero', 'axis must not be zero')
  const half = angle / 2
  const s = Math.sin(half) / len
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]
}
