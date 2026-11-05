import { rotate, readQuat } from '../shared/quat.js'
import { readVec3, cross } from '../shared/vec3.js'

export function beltVelocity({ surfaceVelocity = [0, 0, 0], surfaceQuaternion = [0, 0, 0, 1], contactPoint = [0, 0, 0], angularVelocity = [0, 0, 0] } = {}) {
  readVec3(surfaceVelocity, 'surfaceVelocity')
  readQuat(surfaceQuaternion, 'surfaceQuaternion')
  readVec3(contactPoint, 'contactPoint')
  readVec3(angularVelocity, 'angularVelocity')
  const linear = rotate(surfaceQuaternion, surfaceVelocity)
  const tangential = cross(angularVelocity, contactPoint)
  return [linear[0] + tangential[0], linear[1] + tangential[1], linear[2] + tangential[2]]
}

export function surfaceVelocityAt({ surfaceVelocity = [0, 0, 0], surfaceQuaternion = [0, 0, 0, 1], contactPoint = [0, 0, 0], angularVelocity = [0, 0, 0], relativeVelocity = [0, 0, 0] } = {}) {
  const belt = beltVelocity({ surfaceVelocity, surfaceQuaternion, contactPoint, angularVelocity })
  readVec3(relativeVelocity, 'relativeVelocity')
  return {
    belt,
    slip: [relativeVelocity[0] - belt[0], relativeVelocity[1] - belt[1], relativeVelocity[2] - belt[2]],
  }
}
