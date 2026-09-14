import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

const ROW_FLOATS = 10
const GROW_FACTOR = 1.6
const NEVER_EVALUATED_DIST_SQ = -1

export function createStaticInstanceStore(opts = {}) {
  let _capacity = Math.max(64, opts.initialCapacity || 1024)
  let _transforms = new Float32Array(_capacity * ROW_FLOATS)
  let _bucketId = new Int32Array(_capacity)
  let _lodTier = new Uint8Array(_capacity)
  let _lastDistSq = new Float32Array(_capacity).fill(NEVER_EVALUATED_DIST_SQ)
  let _active = new Uint8Array(_capacity)
  let _count = 0
  const _freeList = []
  const _entityToSlot = new Map()
  const _slotToEntity = new Map()

  const _buckets = new Map()
  let _nextBucketId = 1
  const _bucketKeyToId = new Map()

  const _tmpMat4 = new THREE.Matrix4()
  const _tmpInvMat4 = new THREE.Matrix4()
  const _tmpPos = new THREE.Vector3()
  const _tmpQuat = new THREE.Quaternion()
  const _tmpScale = new THREE.Vector3()
  const _tmpRay = new THREE.Ray()

  function _grow(minCapacity) {
    let newCap = _capacity
    while (newCap < minCapacity) newCap = Math.ceil(newCap * GROW_FACTOR)
    const nt = new Float32Array(newCap * ROW_FLOATS); nt.set(_transforms); _transforms = nt
    const nb = new Int32Array(newCap); nb.set(_bucketId); _bucketId = nb
    const nl = new Uint8Array(newCap); nl.set(_lodTier); _lodTier = nl
    const nd = new Float32Array(newCap).fill(NEVER_EVALUATED_DIST_SQ); nd.set(_lastDistSq); _lastDistSq = nd
    const na = new Uint8Array(newCap); na.set(_active); _active = na
    _capacity = newCap
  }

  function registerBucket(bucketKey, geometry) {
    let id = _bucketKeyToId.get(bucketKey)
    if (id != null) return id
    id = _nextBucketId++
    _bucketKeyToId.set(bucketKey, id)
    _buckets.set(id, { geometry, bvh: null, bvhPending: false, key: bucketKey })
    return id
  }

  function _ensureBvh(bucket) {
    if (bucket.bvh || bucket.bvhPending) return
    if (!bucket.geometry.getAttribute('position')) return
    bucket.bvhPending = true
    try { bucket.bvh = new MeshBVH(bucket.geometry) } catch (e) { }
    bucket.bvhPending = false
  }

  function addInstance(entityId, bucketKey, geometry, position, quaternion, scale) {
    if (_entityToSlot.has(entityId)) return entityId
    const bucketId = registerBucket(bucketKey, geometry)
    let slot
    if (_freeList.length > 0) slot = _freeList.pop()
    else { slot = _count++; if (_count > _capacity) _grow(_count) }
    const o = slot * ROW_FLOATS
    _transforms[o] = position[0]; _transforms[o+1] = position[1]; _transforms[o+2] = position[2]
    if (quaternion) { _transforms[o+3] = quaternion[0]; _transforms[o+4] = quaternion[1]; _transforms[o+5] = quaternion[2]; _transforms[o+6] = quaternion[3] }
    else { _transforms[o+3] = 0; _transforms[o+4] = 0; _transforms[o+5] = 0; _transforms[o+6] = 1 }
    const s = scale || [1, 1, 1]
    _transforms[o+7] = s[0]; _transforms[o+8] = s[1]; _transforms[o+9] = s[2]
    _bucketId[slot] = bucketId
    _lodTier[slot] = 0
    _lastDistSq[slot] = NEVER_EVALUATED_DIST_SQ
    _active[slot] = 1
    _entityToSlot.set(entityId, slot)
    _slotToEntity.set(slot, entityId)
    return entityId
  }

  function removeInstance(entityId) {
    const slot = _entityToSlot.get(entityId)
    if (slot == null) return false
    _active[slot] = 0
    _entityToSlot.delete(entityId)
    _slotToEntity.delete(slot)
    _freeList.push(slot)
    return true
  }

  function has(entityId) { return _entityToSlot.has(entityId) }

  function getTransform(entityId, outMatrix) {
    const slot = _entityToSlot.get(entityId)
    if (slot == null || !_active[slot]) return null
    const o = slot * ROW_FLOATS
    _tmpPos.set(_transforms[o], _transforms[o+1], _transforms[o+2])
    _tmpQuat.set(_transforms[o+3], _transforms[o+4], _transforms[o+5], _transforms[o+6])
    _tmpScale.set(_transforms[o+7], _transforms[o+8], _transforms[o+9])
    const m = outMatrix || new THREE.Matrix4()
    return m.compose(_tmpPos, _tmpQuat, _tmpScale)
  }

  function updateLod(entityId, cameraX, cameraY, cameraZ, tiers) {
    const slot = _entityToSlot.get(entityId)
    if (slot == null || !_active[slot]) return -1
    const o = slot * ROW_FLOATS
    const dx = _transforms[o] - cameraX, dy = _transforms[o+1] - cameraY, dz = _transforms[o+2] - cameraZ
    const d2 = dx*dx + dy*dy + dz*dz
    _lastDistSq[slot] = d2
    if (tiers && tiers.length) {
      let tier = tiers.length - 1
      for (let i = 0; i < tiers.length; i++) { if (d2 <= tiers[i] * tiers[i]) { tier = i; break } }
      _lodTier[slot] = tier
    }
    return d2
  }

  function getLodTier(entityId) {
    const slot = _entityToSlot.get(entityId)
    return slot == null ? -1 : _lodTier[slot]
  }

  const _worldSphere = new THREE.Sphere()
  function raycastFirst(ray, near = 0, far = Infinity) {
    let best = null, bestDist = far
    for (let slot = 0; slot < _count; slot++) {
      if (!_active[slot]) continue
      const bucket = _buckets.get(_bucketId[slot])
      if (!bucket) continue
      _ensureBvh(bucket)
      if (!bucket.bvh) continue
      const o = slot * ROW_FLOATS
      _tmpPos.set(_transforms[o], _transforms[o+1], _transforms[o+2])
      _tmpQuat.set(_transforms[o+3], _transforms[o+4], _transforms[o+5], _transforms[o+6])
      _tmpScale.set(_transforms[o+7], _transforms[o+8], _transforms[o+9])
      _tmpMat4.compose(_tmpPos, _tmpQuat, _tmpScale)
      if (bucket.geometry.boundingSphere) {
        _worldSphere.copy(bucket.geometry.boundingSphere).applyMatrix4(_tmpMat4)
        if (!ray.intersectsSphere(_worldSphere)) continue
      }
      _tmpInvMat4.copy(_tmpMat4).invert()
      _tmpRay.copy(ray).applyMatrix4(_tmpInvMat4)
      const hit = bucket.bvh.raycastFirst(_tmpRay, THREE.DoubleSide, near, far)
      if (hit && hit.distance < bestDist) {
        hit.point.applyMatrix4(_tmpMat4)
        hit.distance = ray.origin.distanceTo(hit.point)
        if (hit.distance < bestDist) { bestDist = hit.distance; best = { ...hit, entityId: _slotToEntity.get(slot), slot } }
      }
    }
    return best
  }

  function dispose() {
    for (const bucket of _buckets.values()) { if (bucket.bvh) bucket.bvh = null }
    _buckets.clear(); _bucketKeyToId.clear()
    _entityToSlot.clear(); _slotToEntity.clear()
    _freeList.length = 0; _count = 0
  }

  return {
    registerBucket, addInstance, removeInstance, has,
    getTransform, updateLod, getLodTier, raycastFirst, dispose,
    get count() { return _count - _freeList.length },
    get capacity() { return _capacity },
    get transforms() { return _transforms },
    get bucketIds() { return _bucketId },
    get lodTiers() { return _lodTier },
    get activeFlags() { return _active },
    get slotCount() { return _count },
    get buckets() { return _buckets },
  }
}
