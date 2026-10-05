import * as THREE from 'three'
import { mat4, instancedBufferAttribute } from 'three/tsl'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const MATRIX_FLOATS = 16
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)

export function isWebGPUInstancingSupported(renderer) {
  return !!(renderer && renderer.isWebGPURenderer)
}

export function instanceMatrixNodeFor(object) {
  const interleaved = object.userData.instanceMatrixInterleaved
  if (!interleaved) throw new Error(`instanceMatrixNodeFor: ${object.name || object.type} was not built by createWebGPUInstancedMesh (no userData.instanceMatrixInterleaved)`)
  return mat4(...[0, 4, 8, 12].map((offset) => instancedBufferAttribute(interleaved, 'vec4', MATRIX_FLOATS, offset)))
}

export function createSlotRangeUploader(buffer, stride) {
  let lo = 0, hi = -1
  return function markSlotDirty(slot) {
    const ranges = buffer.updateRanges
    buffer.needsUpdate = true
    if (ranges.length === 0) { lo = slot; hi = slot; buffer.addUpdateRange(lo * stride, stride); return }
    if (slot >= lo && slot <= hi) return
    if (slot < lo) lo = slot; else hi = slot
    ranges[0].start = lo * stride
    ranges[0].count = (hi - lo + 1) * stride
  }
}

export function createWebGPUInstancedMesh(geometry, material, capacity, attributeSchema = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.frustumCulled = false
  mesh.count = 0
  const interleaved = new THREE.InstancedInterleavedBuffer(mesh.instanceMatrix.array, MATRIX_FLOATS, 1)
  mesh.userData.instanceMatrixInterleaved = interleaved
  const markMatricesDirty = createSlotRangeUploader(interleaved, MATRIX_FLOATS)

  const shadowMatrices = new Float32Array(capacity * 16)

  const attributeArrays = {}
  for (const name in attributeSchema) {
    const type = attributeSchema[name]
    const itemSize = ITEM_SIZE[type]
    if (!itemSize) throw new Error(`WebGPUInstancing: unsupported attribute type "${type}" for "${name}"`)
    const array = new Float32Array(capacity * itemSize)
    const attr = new THREE.InstancedBufferAttribute(array, itemSize)
    geometry.setAttribute(name, attr)
    attributeArrays[name] = { array, itemSize, attr, markSlotDirty: createSlotRangeUploader(attr, itemSize) }
  }

  const inUse = new Uint8Array(capacity)
  const recycledIds = []
  let neverUsedFrom = 0
  let highWatermark = 0
  let acquiredCount = 0

  function takeFreeId() {
    while (recycledIds.length) { const id = recycledIds.pop(); if (!inUse[id]) return id }
    return neverUsedFrom < capacity ? neverUsedFrom++ : -1
  }

  function acquireId() {
    const id = takeFreeId()
    if (id < 0) return -1
    inUse[id] = 1
    acquiredCount++
    if (id + 1 > highWatermark) highWatermark = id + 1
    mesh.count = highWatermark
    _zeroMatrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, _zeroMatrix)
    markMatricesDirty(id)
    return id
  }

  function releaseId(id) {
    _zeroMatrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, _zeroMatrix)
    markMatricesDirty(id)
    if (inUse[id]) { inUse[id] = 0; acquiredCount--; recycledIds.push(id) }
    while (highWatermark > 0 && !inUse[highWatermark - 1]) highWatermark--
    mesh.count = highWatermark
  }

  function setMatrixAt(id, matrix) {
    matrix.toArray(shadowMatrices, id * 16)
    mesh.setMatrixAt(id, matrix)
    markMatricesDirty(id)
  }

  function setVisibleAt(id, visible) {
    if (visible) mesh.instanceMatrix.array.set(shadowMatrices.subarray(id * 16, id * 16 + 16), id * 16)
    else mesh.setMatrixAt(id, _zeroMatrix)
    markMatricesDirty(id)
  }

  function setAttributeAt(id, name, value) {
    const rec = attributeArrays[name]
    if (!rec) throw new Error(`WebGPUInstancing: unknown attribute "${name}"`)
    const off = id * rec.itemSize
    if (rec.itemSize === 1) rec.array[off] = value
    else for (let i = 0; i < rec.itemSize; i++) rec.array[off + i] = value[i]
    rec.markSlotDirty(id)
  }

  function clear() {
    inUse.fill(0)
    recycledIds.length = 0
    neverUsedFrom = 0
    highWatermark = 0
    acquiredCount = 0
    mesh.count = 0
  }

  function dispose() {
    material.dispose()
  }

  return {
    mesh,
    shadowMatrices,
    acquireId,
    releaseId,
    setMatrixAt,
    setVisibleAt,
    setAttributeAt,
    clear,
    dispose,
    get capacity() { return capacity },
    get activeCount() { return acquiredCount }
  }
}

const _streamPos = new THREE.Vector3(), _streamQuat = new THREE.Quaternion(), _streamScale = new THREE.Vector3(1, 1, 1), _streamM4 = new THREE.Matrix4()

export function createStreamingInstancer(scene, geometry, material, initialCapacity, attributeSchema) {
  let capacity = initialCapacity
  let rec = createWebGPUInstancedMesh(geometry, material, capacity, attributeSchema)
  scene.add(rec.mesh)
  const freeIds = new Set()
  for (let i = 0; i < capacity; i++) freeIds.add(i)
  let highWatermark = 0
  const _matrixIds = new Set()
  const _regrowMatrix = new THREE.Matrix4()
  const _attrData = new Map()
  const _visibleData = new Map()
  const _entityProxy = {
    position: { set(x, y, z) { _streamPos.set(x, y, z) } },
    quaternion: { copy(q) { _streamQuat.copy(q) }, set(x, y, z, w) { _streamQuat.set(x, y, z, w) } },
    scale: { set(x, y, z) { _streamScale.set(x, y, z) } },
  }

  function _acquire() {
    if (freeIds.size === 0) return -1
    const id = freeIds.values().next().value
    freeIds.delete(id)
    if (id + 1 > highWatermark) highWatermark = id + 1
    return id
  }

  function _grow(minCapacity) {
    const newCapacity = Math.max(minCapacity, capacity * 2)
    const oldMesh = rec.mesh
    const oldRenderOrder = oldMesh.renderOrder
    const oldFrustumCulled = oldMesh.frustumCulled
    const oldMatrixAutoUpdate = oldMesh.matrixAutoUpdate
    const oldVisible = oldMesh.visible
    const oldMatrices = rec.shadowMatrices
    rec = createWebGPUInstancedMesh(geometry, material, newCapacity, attributeSchema)
    for (const id of _matrixIds) {
      rec.setMatrixAt(id, _regrowMatrix.fromArray(oldMatrices, id * 16))
      const attrs = _attrData.get(id)
      if (attrs) for (const name in attrs) rec.setAttributeAt(id, name, attrs[name])
      if (_visibleData.get(id) === false) rec.setVisibleAt(id, false)
    }
    rec.mesh.count = highWatermark
    for (let i = capacity; i < newCapacity; i++) freeIds.add(i)
    capacity = newCapacity
    rec.mesh.renderOrder = oldRenderOrder
    rec.mesh.frustumCulled = oldFrustumCulled
    rec.mesh.matrixAutoUpdate = oldMatrixAutoUpdate
    rec.mesh.visible = oldVisible
    scene.remove(oldMesh)
    scene.add(rec.mesh)
  }

  const adapter = {
    get capacity() { return capacity },
    get mesh() { return rec.mesh },
    get geometry() { return rec.mesh.geometry },
    set geometry(g) { rec.mesh.geometry = g },
    get material() { return rec.mesh.material },
    set material(m) { rec.mesh.material = m },
    get visible() { return rec.mesh.visible },
    set visible(v) { rec.mesh.visible = v },
    perObjectFrustumCulled: false,
    autoUpdate: true,
    get frustumCulled() { return rec.mesh.frustumCulled },
    set frustumCulled(v) { rec.mesh.frustumCulled = v },
    get renderOrder() { return rec.mesh.renderOrder },
    set renderOrder(v) { rec.mesh.renderOrder = v },
    get matrixAutoUpdate() { return rec.mesh.matrixAutoUpdate },
    set matrixAutoUpdate(v) { rec.mesh.matrixAutoUpdate = v },
    updateMatrix() { rec.mesh.updateMatrix() },
    addInstances(count, cb) {
      for (let i = 0; i < count; i++) {
        let id = _acquire()
        if (id < 0) { _grow(capacity + 1); id = _acquire() }
        _streamPos.set(0, 0, 0); _streamQuat.identity(); _streamScale.set(1, 1, 1)
        cb(_entityProxy, id)
        _streamM4.compose(_streamPos, _streamQuat, _streamScale)
        rec.setMatrixAt(id, _streamM4)
        if (id + 1 > rec.mesh.count) rec.mesh.count = id + 1
        _matrixIds.add(id)
        _visibleData.set(id, true)
      }
    },
    removeInstances(id) {
      rec.releaseId(id)
      freeIds.add(id)
      while (highWatermark > 0 && freeIds.has(highWatermark - 1)) highWatermark--
      rec.mesh.count = highWatermark
      _matrixIds.delete(id)
      _attrData.delete(id)
      _visibleData.delete(id)
    },
    setMatrixAt(id, matrix) {
      rec.setMatrixAt(id, matrix)
      _matrixIds.add(id)
    },
    setUniformAt(id, name, value) {
      rec.setAttributeAt(id, name, value)
      let attrs = _attrData.get(id)
      if (!attrs) { attrs = {}; _attrData.set(id, attrs) }
      attrs[name] = value
    },
    setVisibilityAt(id, visible) {
      rec.setVisibleAt(id, visible)
      _visibleData.set(id, visible)
    },
    resizeBuffers(minCapacity) { if (minCapacity > capacity) _grow(minCapacity) },
    dispose() { _matrixIds.clear(); _attrData.clear(); _visibleData.clear() },
  }
  return adapter
}
