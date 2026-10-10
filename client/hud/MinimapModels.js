import * as THREE from 'three'

const BOUNDS_RECHECK_MS = 1000
const MAX_FOOTPRINTS = 512
const CORNERS_PER_FOOTPRINT = 4

const _inv = new THREE.Matrix4(), _toRoot = new THREE.Matrix4(), _box = new THREE.Box3(), _v = new THREE.Vector3()

function localFootprint(root, out) {
  root.updateWorldMatrix(true, true)
  _inv.copy(root.matrixWorld).invert()
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, meshes = 0
  root.traverse(o => {
    const g = o.geometry
    if (!g || !(o.isMesh || o.isInstancedMesh || o.isBatchedMesh)) return
    const spread = (o.isInstancedMesh || o.isBatchedMesh) && typeof o.computeBoundingBox === 'function'
    if (spread) o.computeBoundingBox()
    else if (!g.boundingBox) g.computeBoundingBox()
    const bounds = spread ? o.boundingBox : g.boundingBox
    if (!bounds) return
    _box.copy(bounds)
    if (!Number.isFinite(_box.min.x) || !Number.isFinite(_box.max.x)) return
    _toRoot.multiplyMatrices(_inv, o.matrixWorld)
    meshes++
    for (let c = 0; c < 8; c++) {
      _v.set(c & 1 ? _box.max.x : _box.min.x, c & 2 ? _box.max.y : _box.min.y, c & 4 ? _box.max.z : _box.min.z).applyMatrix4(_toRoot)
      if (_v.x < minX) minX = _v.x; if (_v.x > maxX) maxX = _v.x
      if (_v.z < minZ) minZ = _v.z; if (_v.z > maxZ) maxZ = _v.z
    }
  })
  if (!meshes) return 0
  out[0] = minX; out[1] = minZ; out[2] = maxX; out[3] = maxZ
  return meshes
}

export function createModelFootprints() {
  const entries = new Map()
  const corners = new Float64Array(MAX_FOOTPRINTS * CORNERS_PER_FOOTPRINT * 2)
  const cornersAtLastCollect = new Float64Array(corners.length)
  const seen = new Set()
  let count = 0, countAtLastCollect = 0

  function entryFor(id, root, now) {
    let e = entries.get(id)
    if (!e) { e = { root: null, bounds: new Float64Array(4), meshes: 0, checkedAt: 0 }; entries.set(id, e) }
    if (e.root !== root || now - e.checkedAt > BOUNDS_RECHECK_MS) {
      e.checkedAt = e.root !== root ? now - Math.random() * BOUNDS_RECHECK_MS : now
      e.root = root
      e.meshes = localFootprint(root, e.bounds)
    }
    return e
  }

  let shiftX = 0, shiftZ = 0, nowMs = 0

  function visit(root, id) {
    if (!root || !root.userData || !root.userData.modelUrl || count >= MAX_FOOTPRINTS) return
    seen.add(id)
    const e = entryFor(id, root, nowMs)
    if (!e.meshes) return
    const m = root.matrixWorld.elements, b = e.bounds, o = count * CORNERS_PER_FOOTPRINT * 2
    for (let c = 0; c < CORNERS_PER_FOOTPRINT; c++) {
      const lx = c === 1 || c === 2 ? b[2] : b[0], lz = c >= 2 ? b[3] : b[1]
      const x = m[0] * lx + m[8] * lz + m[12] + shiftX, z = m[2] * lx + m[10] * lz + m[14] + shiftZ
      corners[o + c * 2] = x; corners[o + c * 2 + 1] = z
    }
    count++
  }

  function forgetUnseen(e, id) { if (!seen.has(id)) entries.delete(id) }

  function cornersMoved() {
    const used = count * CORNERS_PER_FOOTPRINT * 2
    let moved = count !== countAtLastCollect
    for (let i = 0; i < used && !moved; i++) moved = corners[i] !== cornersAtLastCollect[i]
    cornersAtLastCollect.set(corners.subarray(0, used))
    countAtLastCollect = count
    return moved
  }

  function collect(entityMeshes, shift, now) {
    count = 0; nowMs = now
    shiftX = shift ? shift.x : 0; shiftZ = shift ? shift.z : 0
    seen.clear()
    if (entityMeshes) entityMeshes.forEach(visit)
    entries.forEach(forgetUnseen)
    return cornersMoved()
  }

  return { collect, corners, get count() { return count } }
}
