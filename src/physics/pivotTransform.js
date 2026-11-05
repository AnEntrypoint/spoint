import { rotate, readQuat, fromAxisAngle } from '../shared/quat.js'
import { readVec3, cross } from '../shared/vec3.js'

function refusal(code, message) {
  const err = new TypeError(`[pivot] ${code}: ${message}`)
  err.reasonCode = code
  return err
}

export function pivotTransform({ position, pivot = [0, 0, 0], quaternion = [0, 0, 0, 1], scale = [1, 1, 1] } = {}) {
  readVec3(position, 'position')
  readVec3(pivot, 'pivot')
  readQuat(quaternion, 'quaternion')
  readVec3(scale, 'scale')
  const offset = [position[0] - pivot[0], position[1] - pivot[1], position[2] - pivot[2]]
  const scaled = [offset[0] * scale[0], offset[1] * scale[1], offset[2] * scale[2]]
  const turned = rotate(quaternion, scaled)
  return [pivot[0] + turned[0], pivot[1] + turned[1], pivot[2] + turned[2]]
}

export function hingeAngle({ openFraction, minAngleRad = 0, maxAngleRad = Math.PI / 2, axis = [0, 1, 0] } = {}) {
  if (!Number.isFinite(openFraction) || openFraction < 0 || openFraction > 1) throw refusal('pivot-open-invalid', 'openFraction must be a finite number in [0,1]')
  if (!Number.isFinite(minAngleRad) || !Number.isFinite(maxAngleRad) || maxAngleRad < minAngleRad) throw refusal('pivot-angle-invalid', 'angle bounds must be finite with max >= min')
  const angle = minAngleRad + (maxAngleRad - minAngleRad) * openFraction
  return { angleRad: angle, quaternion: fromAxisAngle(axis, angle) }
}

export function riderReleaseVelocity({ platformVelocity = [0, 0, 0], platformAngularVelocity = [0, 0, 0], riderOffset = [0, 0, 0] } = {}) {
  readVec3(platformVelocity, 'platformVelocity')
  readVec3(platformAngularVelocity, 'platformAngularVelocity')
  readVec3(riderOffset, 'riderOffset')
  const tangential = cross(platformAngularVelocity, riderOffset)
  return [platformVelocity[0] + tangential[0], platformVelocity[1] + tangential[1], platformVelocity[2] + tangential[2]]
}
