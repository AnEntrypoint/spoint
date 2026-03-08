import * as THREE from 'three'

const _mat4 = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _zeroScale = new THREE.Matrix4().makeScale(0, 0, 0)

const _registry = new Map()
const _entityMap = new Map()

let _scene = null

export function initInstanceManager(scene) {
  _scene = scene
}

function _materialKey(mat) {
  const color = mat.color ? mat.color.getHexString() : '0'
  const mapId = mat.map?.uuid || ''
  const normalId = mat.normalMap?.uuid || ''
  const r = mat.roughness ?? 1
  const m = mat.metalness ?? 0
  const em = mat.emissive ? mat.emissive.getHexString() : '0'
  return `${color}|${mapId}|${normalId}|${r}|${m}|${em}`
}

function _geometryKey(modelUrl, meshIndex) {
  return `${modelUrl}::${meshIndex}`
}

function _getOrCreateBucket(geoKey, geometry, material) {
  if (_registry.has(geoKey)) return _registry.get(geoKey)
  const capacity = 64
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.count = 0
  mesh.frustumCulled = false
  _scene.add(mesh)
  const bucket = { mesh, capacity, freeSlots: [], count: 0, geometry, material }
  _registry.set(geoKey, bucket)
  return bucket
}

function _growBucket(bucket) {
  const newCapacity = bucket.capacity * 2
  const newMesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, newCapacity)
  newMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  newMesh.frustumCulled = false
  for (let i = 0; i < bucket.capacity; i++) {
    bucket.mesh.getMatrixAt(i, _mat4)
    newMesh.setMatrixAt(i, _mat4)
  }
  newMesh.count = bucket.mesh.count
  newMesh.instanceMatrix.needsUpdate = true
  _scene.remove(bucket.mesh)
  _scene.add(newMesh)
  bucket.mesh = newMesh
  bucket.capacity = newCapacity
}

export function tryAddInstance(entityId, modelUrl, meshIndex, geometry, material, position, quaternion, scale) {
  if (!_scene) return { instanced: false }
  const geoKey = _geometryKey(modelUrl, meshIndex) + '::' + _materialKey(material)
  const bucket = _getOrCreateBucket(geoKey, geometry, material)

  let slot
  if (bucket.freeSlots.length > 0) {
    slot = bucket.freeSlots.pop()
  } else {
    if (bucket.count >= bucket.capacity) _growBucket(bucket)
    slot = bucket.count
    bucket.count++
    bucket.mesh.count = bucket.count
  }

  _pos.set(position.x, position.y, position.z)
  _quat.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  const s = scale || _scale
  _mat4.compose(_pos, _quat, s)
  bucket.mesh.setMatrixAt(slot, _mat4)
  bucket.mesh.instanceMatrix.needsUpdate = true

  const existing = _entityMap.get(entityId)
  if (!existing) _entityMap.set(entityId, [])
  _entityMap.get(entityId).push({ geoKey, slot })

  return { instanced: true }
}

export function removeInstance(entityId) {
  const entries = _entityMap.get(entityId)
  if (!entries) return
  for (const { geoKey, slot } of entries) {
    const bucket = _registry.get(geoKey)
    if (!bucket) continue
    bucket.mesh.setMatrixAt(slot, _zeroScale)
    bucket.mesh.instanceMatrix.needsUpdate = true
    bucket.freeSlots.push(slot)
  }
  _entityMap.delete(entityId)
}

export function isInstanced(entityId) {
  return _entityMap.has(entityId)
}

export function dispose() {
  for (const [, bucket] of _registry) {
    _scene?.remove(bucket.mesh)
    bucket.mesh.dispose()
  }
  _registry.clear()
  _entityMap.clear()
}
