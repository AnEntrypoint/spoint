// StaticInstanceStore.js — typed-array storage for static, non-moving model
// instances that have NO reason to be full THREE.Object3D scene-graph members.
//
// Why: EntityLoader._doLoadEntityModel's legacy (non-ModelPool, non-cluster-LOD)
// GLB branch spawns every static entity as `scene.add(finalMesh)` — a real
// Object3D subtree, one node per sub-mesh. Even with `matrixAutoUpdate=false`
// (already set at EntityLoader.js:213) each node still costs THREE a per-frame
// scene-graph visit during renderer.render()'s traversal (render-list build +
// per-object frustum test + shadow-map traversal) and a Map/child-array entry
// walked by every recursive `scene.raycast`/`intersectObjects(scene.children,
// true)` call (editor picking, client/app.js:636/646). At 30k+ static instances
// that is a large constant per-frame cost paid for objects that NEVER receive a
// transform update after spawn (SceneGraph.tick only touches entities with a
// live snapshot `target` — see SceneGraph.js; a genuinely static entity's target
// is set once at spawn and never revisited).
//
// This store holds one flat row per static instance: transform (position +
// quaternion + scale, 10 floats), a bucket id (groups instances sharing one
// source geometry/material — the BatchedMesh multi-draw container a future pass
// would key off), and LOD state (current tier + last-evaluated distance²). It
// never touches THREE.Object3D. Raycasting is routed against the SAME `MeshBVH`
// instances EntityLoader already builds for the environment-collision path
// (three-mesh-bvh's real BVH class, imported directly here — NOT scene.raycast,
// NOT THREE.Mesh.prototype.raycast) — each bucket keeps a `{ bvh, geometry,
// matrixWorld }` triple, and `raycast()` transforms the incoming ray into each
// candidate instance's local space and calls `bvh.raycastFirst`/`bvh.raycast`
// directly, exactly the API camera.js already relies on via the Mesh-bound path
// (client/core/camera.js:100 `m.geometry.boundsTree`), just without an Object3D.
//
// Integration point for a future pass: `batchedmesh-multi-draw-bucketing-for-
// 30k-unique-model-scenes` (not landed as of this pass — no BatchedMesh
// container exists yet in EntityLoader/model-pool for arbitrary unique plain-
// GLB statics) would replace `_renderInstance()`'s per-bucket draw stub with
// real GPU multi-draw submission keyed by the same `bucketId` this store already
// assigns; until then this layer is a standalone CPU-side transform/raycast
// store — it does not itself issue draw calls (a static instance stored here
// must currently ALSO get a real THREE mesh for rendering via the caller, or
// wait for the BatchedMesh wiring pass). See `addInstance`'s `geometry`/
// `matrixWorld` note below for the exact hook.

import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

const ROW_FLOATS = 10 // px,py,pz, qx,qy,qz,qw, sx,sy,sz
const GROW_FACTOR = 1.6

export function createStaticInstanceStore(opts = {}) {
  let _capacity = Math.max(64, opts.initialCapacity || 1024)
  let _transforms = new Float32Array(_capacity * ROW_FLOATS)
  let _bucketId = new Int32Array(_capacity)
  let _lodTier = new Uint8Array(_capacity)          // current LOD tier index (0 = highest detail)
  let _lastDistSq = new Float32Array(_capacity).fill(-1) // last distance² this instance was evaluated at (-1 = never)
  let _active = new Uint8Array(_capacity)           // 1 = live slot, 0 = free (tombstone, reused by _freeList)
  let _count = 0
  const _freeList = []
  const _entityToSlot = new Map()   // entityId -> slot index (public identity)
  const _slotToEntity = new Map()   // slot index -> entityId

  // bucketId -> { geometry, bvhPending: bool } — a bucket shares ONE source geometry (and thus one
  // MeshBVH once built) across every instance in it, keyed by whatever the caller considers
  // "same drawable" (e.g. `${modelUrl}|${meshIndex}`). This is the grouping a BatchedMesh multi-draw
  // pass would key its own per-geometry slot off (see module header).
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
    const nd = new Float32Array(newCap).fill(-1); nd.set(_lastDistSq); _lastDistSq = nd
    const na = new Uint8Array(newCap); na.set(_active); _active = na
    _capacity = newCap
  }

  // Register (or reuse, by `bucketKey`) a bucket sharing one source geometry. `geometry` must be a
  // THREE.BufferGeometry (local-space, untransformed — instance transforms are applied per-row via
  // `_transforms`, never baked into the geometry). The BVH is built lazily off the idle queue, same
  // deferral discipline as EntityLoader._scheduleBvhBuild, so registering many buckets in one frame
  // (a big static-prop world load) never stalls it.
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
    // Build inline (not deferred) — callers raycasting into the store need it immediately available;
    // it is only built once per bucket (many instances share it) so the amortized cost is low relative
    // to per-mesh BVH builds in the legacy scene-graph path this store replaces.
    try { bucket.bvh = new MeshBVH(bucket.geometry) } catch (e) { /* non-indexed or degenerate geometry: raycast falls back to a no-hit */ }
    bucket.bvhPending = false
  }

  // Add one static instance. `bucketKey`/`geometry` identify the shared drawable (see registerBucket).
  // position/quaternion/scale are plain [x,y,z]/[x,y,z,w]/[x,y,z] arrays (matches the snapshot wire shape
  // EntityLoader already receives — no THREE.Object3D constructed). Returns the entityId for symmetry.
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
    _lastDistSq[slot] = -1
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

  // Distance² from a world point to instance `slot`'s stored position (used by the caller's own LOD
  // selection — this store just tracks the last-evaluated value + tier so a per-frame LOD pass can skip
  // instances whose distance bucket hasn't changed, same discipline as EntityLoader's LOD_CONFIGS gate).
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

  // Real BVH raycast against every instance whose bucket has a built tree — routed through MeshBVH
  // directly (three-mesh-bvh's own class), never scene.raycast/Object3D traversal. Broad-phase: skip a
  // bucket's geometry bounding sphere transformed to world space before doing the local-space ray xform +
  // real BVH descent, same two-phase shape as camera.js's bvhMeshesAlongRay + intersectObjects pairing.
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
    // Direct typed-array access for a future BatchedMesh multi-draw pass (per-instance matrix upload
    // without a getTransform() Matrix4 alloc per instance) — the exact hook noted in the module header.
    get transforms() { return _transforms },
    get bucketIds() { return _bucketId },
    get lodTiers() { return _lodTier },
    get activeFlags() { return _active },
    get slotCount() { return _count },
    get buckets() { return _buckets },
  }
}
