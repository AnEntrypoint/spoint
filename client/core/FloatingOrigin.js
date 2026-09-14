import * as THREE from 'three'

export const REBASE_THRESHOLD_M = 8000

export function createFloatingOrigin(scene, camera) {
  const _shift = new THREE.Vector3(0, 0, 0)
  const _authCam = new THREE.Vector3(0, 0, 0)
  let _initialized = false
  let _rebaseCount = 0
  let _lastDelta = new THREE.Vector3(0, 0, 0)
  const _listeners = new Set()

  function update(authoritativeX, authoritativeY, authoritativeZ) {
    _authCam.set(authoritativeX, authoritativeY, authoritativeZ)
    if (!_initialized) {
      _initialized = true
      _lastDelta.set(0, 0, 0)
      return false
    }
    const rx = authoritativeX - _shift.x, ry = authoritativeY - _shift.y, rz = authoritativeZ - _shift.z
    const d2 = rx * rx + ry * ry + rz * rz
    if (d2 < REBASE_THRESHOLD_M * REBASE_THRESHOLD_M) { _lastDelta.set(0, 0, 0); return false }
    const deltaX = rx, deltaY = ry, deltaZ = rz
    _shift.set(authoritativeX, authoritativeY, authoritativeZ)
    camera.position.set(0, 0, 0)
    _translateChildren(scene, camera, -deltaX, -deltaY, -deltaZ)
    _lastDelta.set(-deltaX, -deltaY, -deltaZ)
    _rebaseCount++
    for (const fn of _listeners) { try { fn(-deltaX, -deltaY, -deltaZ, _shift) } catch (_) {} }
    return true
  }

  function onRebase(fn) { _listeners.add(fn); return () => _listeners.delete(fn) }

  function toAuthoritative(renderPos, out) {
    const o = out || new THREE.Vector3()
    o.x = renderPos.x + _shift.x; o.y = renderPos.y + _shift.y; o.z = renderPos.z + _shift.z
    return o
  }

  function toRender(authPos, out) {
    const o = out || new THREE.Vector3()
    o.x = authPos.x - _shift.x; o.y = authPos.y - _shift.y; o.z = authPos.z - _shift.z
    return o
  }

  return {
    update, onRebase, toAuthoritative, toRender,
    getShift: () => _shift,
    getAuthoritativeCamera: () => _authCam,
    getRebaseCount: () => _rebaseCount,
    getLastDelta: () => _lastDelta,
  }
}

function _translateChildren(scene, camera, dx, dy, dz) {
  for (const child of scene.children) {
    if (child === camera) continue
    child.position.x += dx; child.position.y += dy; child.position.z += dz
  }
}
