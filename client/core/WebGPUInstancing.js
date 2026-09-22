import * as THREE from 'three'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)

export function isWebGPUInstancingSupported(renderer) {
  return !!(renderer && renderer.isWebGPURenderer)
}

export function createWebGPUInstancedMesh(geometry, material, capacity, attributeSchema = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.frustumCulled = false
  mesh.count = 0
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  const shadowMatrices = new Float32Array(capacity * 16)

  const attributeArrays = {}
  for (const name in attributeSchema) {
    const type = attributeSchema[name]
    const itemSize = ITEM_SIZE[type]
    if (!itemSize) throw new Error(`WebGPUInstancing: unsupported attribute type "${type}" for "${name}"`)
    const array = new Float32Array(capacity * itemSize)
    const attr = new THREE.InstancedBufferAttribute(array, itemSize)
    attr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute(name, attr)
    attributeArrays[name] = { array, itemSize, attr }
  }

  const freeIds = []
  for (let i = capacity - 1; i >= 0; i--) freeIds.push(i)
  let highWatermark = 0

  function acquireId() {
    if (freeIds.length === 0) return -1
    const id = freeIds.pop()
    if (id + 1 > highWatermark) highWatermark = id + 1
    mesh.count = highWatermark
    _zeroMatrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, _zeroMatrix)
    mesh.instanceMatrix.needsUpdate = true
    return id
  }

  function releaseId(id) {
    _zeroMatrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, _zeroMatrix)
    mesh.instanceMatrix.needsUpdate = true
    freeIds.push(id)
  }

  function setMatrixAt(id, matrix) {
    matrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, matrix)
    mesh.instanceMatrix.needsUpdate = true
  }

  function setVisibleAt(id, visible) {
    if (visible) mesh.instanceMatrix.array.set(shadowMatrices.subarray(id * 16, id * 16 + 16), id * 16)
    else mesh.setMatrixAt(id, _zeroMatrix)
    mesh.instanceMatrix.needsUpdate = true
  }

  function setAttributeAt(id, name, value) {
    const rec = attributeArrays[name]
    if (!rec) throw new Error(`WebGPUInstancing: unknown attribute "${name}"`)
    const off = id * rec.itemSize
    if (rec.itemSize === 1) rec.array[off] = value
    else for (let i = 0; i < rec.itemSize; i++) rec.array[off + i] = value[i]
    rec.attr.needsUpdate = true
  }

  function clear() {
    freeIds.length = 0
    for (let i = capacity - 1; i >= 0; i--) freeIds.push(i)
    highWatermark = 0
    mesh.count = 0
  }

  function dispose() {
    material.dispose()
  }

  return {
    mesh,
    acquireId,
    releaseId,
    setMatrixAt,
    setVisibleAt,
    setAttributeAt,
    clear,
    dispose,
    get capacity() { return capacity },
    get activeCount() { return highWatermark - freeIds.length }
  }
}
