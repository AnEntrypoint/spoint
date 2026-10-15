const POSITION_STILL_EPS_SQ = 0.05 * 0.05
const ROTATION_STILL_COS = 0.999985

export function setInstancedCullAuto(mesh, auto) {
  if (!mesh) return
  mesh.autoUpdate = auto
  const levels = mesh.LODinfo && mesh.LODinfo.objects
  if (levels) for (const level of levels) level.autoUpdate = auto
}

// A BatchedMesh has no "keep the last list" mode, so freezing it means `perObjectFrustumCulled`:
// with it false, BatchedMesh.onBeforeRender returns early and the standing multi-draw list is
// reused. That flag is also an INPUT to the recompute (cull or do not cull), and three marks the
// batch stale only on instance mutations -- addInstance, deleteInstance, setVisibleAt -- never on a
// change of culling mode. So flipping it alone leaves the count computed under the previous mode
// standing, and three then issues that many draws for the rest of the run: at the tps-game spawn
// the culling pass left 0 and 67 active, visible rocks drew nothing. Invalidate with the flip so
// the standing count belongs to the mode now in force. One recompute per transition, not per frame.
export function setBatchedMeshCullAuto(mesh, auto) {
  if (!mesh) return
  mesh.perObjectFrustumCulled = auto
  mesh._visibilityChanged = true
}

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

// --- hot swap -----
// An edit here is accepted by this module: every export is re-assigned to the freshly imported copy,
// so importers already holding the live binding read the edited code without a page reload.
const _hotSwapExports = (next) => {
  setInstancedCullAuto = next.setInstancedCullAuto
  setBatchedMeshCullAuto = next.setBatchedMeshCullAuto
  createCullFreeze = next.createCullFreeze
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapExports)
