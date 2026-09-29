const POSITION_STILL_EPS_SQ = 0.05 * 0.05
const ROTATION_STILL_COS = 0.999985

export function createCullFreeze(applyAutoUpdate) {
  let frozen = false
  let x = NaN, y = NaN, z = NaN, qx = 0, qy = 0, qz = 0, qw = NaN
  const own = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

  function poseOf(camera, pose) {
    if (pose) return pose
    if (!camera) return null
    camera.updateWorldMatrix(true, false)
    const e = camera.matrixWorld.elements, q = camera.quaternion
    own.x = e[12]; own.y = e[13]; own.z = e[14]
    own.qx = q.x; own.qy = q.y; own.qz = q.z; own.qw = q.w
    return own
  }

  function step(camera, pose, forceLive) {
    const p = poseOf(camera, pose)
    if (!p) return frozen
    const dx = p.x - x, dy = p.y - y, dz = p.z - z
    const positionStill = dx * dx + dy * dy + dz * dz < POSITION_STILL_EPS_SQ
    const rotationStill = Math.abs(p.qx * qx + p.qy * qy + p.qz * qz + p.qw * qw) >= ROTATION_STILL_COS
    const wantFrozen = positionStill && rotationStill && !forceLive
    if (!wantFrozen) { x = p.x; y = p.y; z = p.z; qx = p.qx; qy = p.qy; qz = p.qz; qw = p.qw }
    if (wantFrozen !== frozen) { frozen = wantFrozen; applyAutoUpdate(!wantFrozen) }
    return frozen
  }

  return { step, get frozen() { return frozen } }
}
