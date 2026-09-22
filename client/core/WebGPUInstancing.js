import * as THREE from 'three'
import { storage, instanceIndex } from 'three/tsl'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0)

export function isWebGPUInstancingSupported(renderer) {
  return !!(renderer && renderer.isWebGPURenderer)
}

export function instanceMatrixNodeFor(object) {
  const im = object.instanceMatrix
  return storage(im, 'mat4', Math.max(im.count, 1)).element(instanceIndex)
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

  const freeIds = new Set()
  for (let i = 0; i < capacity; i++) freeIds.add(i)
  let highWatermark = 0

  function acquireId() {
    if (freeIds.size === 0) return -1
    const id = freeIds.values().next().value
    freeIds.delete(id)
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
    freeIds.add(id)
    while (highWatermark > 0 && freeIds.has(highWatermark - 1)) {
      freeIds.delete(highWatermark - 1)
      highWatermark--
    }
    mesh.count = highWatermark
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
    freeIds.clear()
    for (let i = 0; i < capacity; i++) freeIds.add(i)
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
    get activeCount() { return highWatermark - freeIds.size }
  }
}

const _lodPos = new THREE.Vector3(), _lodQuat = new THREE.Quaternion(), _lodScale = new THREE.Vector3(1, 1, 1), _lodM4 = new THREE.Matrix4()
const _lodInstancePos = new THREE.Vector3()

export function createWebGPULodInstancer(scene, levels, capacity, attributeSchema = {}, opts = {}) {
  if (!Array.isArray(levels) || levels.length === 0) throw new Error('WebGPUInstancing: createWebGPULodInstancer requires at least one LOD level')
  const hysteresis = Number.isFinite(opts.hysteresis) ? opts.hysteresis : 0
  const shadowDistSq = Number.isFinite(opts.shadowDistance) ? opts.shadowDistance * opts.shadowDistance : -1
  const thresholdsSq = levels.map(lv => { const d = Number.isFinite(lv.distance) ? lv.distance : 0; const t = d - d * hysteresis; return t * t })

  function _zeroAllSlots(rec, cap) {
    const zero = new Float32Array(16)
    new THREE.Matrix4().makeScale(0, 0, 0).toArray(zero)
    const arr = rec.mesh.instanceMatrix.array
    for (let i = 0; i < cap; i++) arr.set(zero, i * 16)
    rec.mesh.instanceMatrix.needsUpdate = true
  }

  function buildTiers(cap) {
    const tiers = levels.map(lv => createWebGPUInstancedMesh(lv.geometry, lv.material, cap, attributeSchema))
    for (const t of tiers) { scene.add(t.mesh); t.mesh.frustumCulled = false; _zeroAllSlots(t, cap) }
    let shadow = null
    if (opts.shadowGeometry) {
      shadow = createWebGPUInstancedMesh(opts.shadowGeometry, opts.shadowMaterial || levels[0].material, cap, attributeSchema)
      shadow.mesh.castShadow = true
      shadow.mesh.frustumCulled = false
      _zeroAllSlots(shadow, cap)
      shadow.lodActiveCount = 0
      let _pendingShadowDraw = false
      shadow.mesh.onBeforeShadow = () => { shadow.mesh.count = shadow.lodActiveCount; _pendingShadowDraw = true }
      shadow.mesh.onBeforeRender = () => {
        if (_pendingShadowDraw) _pendingShadowDraw = false
        else shadow.mesh.count = 0
      }
      scene.add(shadow.mesh)
    }
    return { tiers, shadow }
  }

  let capacity_ = capacity
  let { tiers, shadow } = buildTiers(capacity_)

  const freeIds = new Set()
  for (let i = 0; i < capacity_; i++) freeIds.add(i)
  let highWatermark = 0
  const matrixData = new Map()
  const attrData = new Map()
  const visibleData = new Map()
  const tierOf = new Map()
  const inShadow = new Map()

  function allMeshes() { return shadow ? [...tiers.map(t => t.mesh), shadow.mesh] : tiers.map(t => t.mesh) }

  function setCounts() {
    for (const t of tiers) t.mesh.count = highWatermark
    if (shadow) shadow.mesh.count = highWatermark
  }

  function acquire() {
    if (freeIds.size === 0) return -1
    const id = freeIds.values().next().value
    freeIds.delete(id)
    if (id + 1 > highWatermark) { highWatermark = id + 1; setCounts() }
    return id
  }

  function grow(minCapacity) {
    const newCap = Math.max(minCapacity, capacity_ * 2)
    const old = { tiers, shadow }
    const built = buildTiers(newCap)
    tiers = built.tiers; shadow = built.shadow
    for (const [id, m] of matrixData) {
      const t = tierOf.get(id) || 0
      tiers[t].setMatrixAt(id, m)
      const attrs = attrData.get(id)
      if (attrs) for (const name in attrs) { for (const tier of tiers) tier.setAttributeAt(id, name, attrs[name]); if (shadow) shadow.setAttributeAt(id, name, attrs[name]) }
      if (shadow && inShadow.get(id)) shadow.setMatrixAt(id, m)
      if (visibleData.get(id) === false) { tiers[t].setVisibleAt(id, false); if (shadow) shadow.setVisibleAt(id, false) }
    }
    for (let i = capacity_; i < newCap; i++) freeIds.add(i)
    capacity_ = newCap
    for (const t of old.tiers) { scene.remove(t.mesh); t.dispose() }
    if (old.shadow) { scene.remove(old.shadow.mesh); old.shadow.dispose() }
    setCounts()
  }

  function activateTier(id, tierIdx) {
    const cur = tierOf.get(id)
    if (cur === tierIdx) return
    const m = matrixData.get(id)
    if (cur != null && cur !== tierIdx) tiers[cur].setVisibleAt(id, false)
    if (visibleData.get(id) !== false) tiers[tierIdx].setMatrixAt(id, m)
    tierOf.set(id, tierIdx)
  }

  function setShadowActive(id, active) {
    if (!shadow) return
    const cur = !!inShadow.get(id)
    if (cur === active) return
    const m = matrixData.get(id)
    if (active) { if (visibleData.get(id) !== false) shadow.setMatrixAt(id, m); shadow.lodActiveCount = (shadow.lodActiveCount || 0) + 1 }
    else { shadow.setVisibleAt(id, false); shadow.lodActiveCount = Math.max(0, (shadow.lodActiveCount || 0) - 1) }
    inShadow.set(id, active)
  }

  function updateLOD(cameraPos) {
    for (const [id, m] of matrixData) {
      _lodInstancePos.setFromMatrixPosition(m)
      const dsq = _lodInstancePos.distanceToSquared(cameraPos)
      let tierIdx = 0
      for (let i = thresholdsSq.length - 1; i > 0; i--) { if (dsq >= thresholdsSq[i]) { tierIdx = i; break } }
      activateTier(id, tierIdx)
      if (shadow) setShadowActive(id, shadowDistSq >= 0 && dsq <= shadowDistSq)
    }
  }

  function _makeEntity(id) {
    return {
      id,
      position: { set(x, y, z) { _lodPos.set(x, y, z) } },
      quaternion: { copy(q) { _lodQuat.copy(q) } },
      scale: { set(x, y, z) { _lodScale.set(x, y, z) }, setScalar(s) { _lodScale.set(s, s, s) } },
      get visible() { return visibleData.get(id) !== false },
      set visible(v) {
        visibleData.set(id, v)
        const cur = tierOf.get(id)
        if (cur != null) tiers[cur].setVisibleAt(id, v)
        if (shadow && inShadow.get(id)) shadow.setVisibleAt(id, v)
      },
    }
  }

  const adapter = {
    get capacity() { return capacity_ },
    get mesh() { return tiers[0].mesh },
    get geometry() { return tiers[0].mesh.geometry },
    get material() { return levels[0].material },
    get count() { return capacity_ - freeIds.size },
    perObjectFrustumCulled: false,
    autoUpdate: true,
    get visible() { return tiers[0].mesh.visible },
    set visible(v) { for (const m of allMeshes()) m.visible = v },
    get frustumCulled() { return tiers[0].mesh.frustumCulled },
    set frustumCulled(v) { for (const m of allMeshes()) m.frustumCulled = v },
    get renderOrder() { return tiers[0].mesh.renderOrder },
    set renderOrder(v) { for (const m of allMeshes()) m.renderOrder = v },
    get matrixAutoUpdate() { return tiers[0].mesh.matrixAutoUpdate },
    set matrixAutoUpdate(v) { for (const m of allMeshes()) m.matrixAutoUpdate = v },
    updateMatrix() { for (const m of allMeshes()) m.updateMatrix() },
    addInstances(count, cb) {
      for (let i = 0; i < count; i++) {
        let id = acquire()
        if (id < 0) { grow(capacity_ + 1); id = acquire() }
        _lodPos.set(0, 0, 0); _lodQuat.identity(); _lodScale.set(1, 1, 1)
        cb(_makeEntity(id))
        _lodM4.compose(_lodPos, _lodQuat, _lodScale)
        matrixData.set(id, _lodM4.clone())
        visibleData.set(id, true)
        tierOf.set(id, 0)
        tiers[0].setMatrixAt(id, _lodM4)
        inShadow.set(id, false)
      }
    },
    removeInstances(id) {
      const t = tierOf.get(id)
      if (t != null) tiers[t].releaseId(id); else tiers[0].releaseId(id)
      if (shadow && inShadow.get(id)) shadow.releaseId(id)
      freeIds.add(id)
      while (highWatermark > 0 && freeIds.has(highWatermark - 1)) {
        freeIds.delete(highWatermark - 1)
        highWatermark--
      }
      setCounts()
      matrixData.delete(id); attrData.delete(id); visibleData.delete(id); tierOf.delete(id); inShadow.delete(id)
    },
    setUniformAt(id, name, value) {
      for (const t of tiers) t.setAttributeAt(id, name, value)
      if (shadow) shadow.setAttributeAt(id, name, value)
      let attrs = attrData.get(id)
      if (!attrs) { attrs = {}; attrData.set(id, attrs) }
      attrs[name] = value
    },
    setVisibilityAt(id, visible) {
      visibleData.set(id, visible)
      const cur = tierOf.get(id)
      if (cur != null) tiers[cur].setVisibleAt(id, visible)
      if (shadow && inShadow.get(id)) shadow.setVisibleAt(id, visible)
    },
    resizeBuffers(minCapacity) { if (minCapacity > capacity_) grow(minCapacity) },
    updateLOD,
    get lodTierCount() { return tiers.length },
    get shadowActiveCount() { return shadow ? (shadow.lodActiveCount || 0) : 0 },
    get tierMeshes() { return tiers.map(t => t.mesh) },
    get shadowMesh() { return shadow ? shadow.mesh : null },
    dispose() {
      for (const t of tiers) { scene.remove(t.mesh); t.dispose() }
      if (shadow) { scene.remove(shadow.mesh); shadow.dispose() }
      matrixData.clear(); attrData.clear(); visibleData.clear(); tierOf.clear(); inShadow.clear()
    },
  }
  return adapter
}

const _streamPos = new THREE.Vector3(), _streamQuat = new THREE.Quaternion(), _streamScale = new THREE.Vector3(1, 1, 1), _streamM4 = new THREE.Matrix4()

export function createStreamingInstancer(scene, geometry, material, initialCapacity, attributeSchema) {
  let capacity = initialCapacity
  let rec = createWebGPUInstancedMesh(geometry, material, capacity, attributeSchema)
  scene.add(rec.mesh)
  const freeIds = new Set()
  for (let i = 0; i < capacity; i++) freeIds.add(i)
  let highWatermark = 0
  const _matrixData = new Map()
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
    rec = createWebGPUInstancedMesh(geometry, material, newCapacity, attributeSchema)
    for (const [id, m] of _matrixData) {
      rec.setMatrixAt(id, m)
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
        _matrixData.set(id, _streamM4.clone())
        _visibleData.set(id, true)
      }
    },
    removeInstances(id) {
      rec.releaseId(id)
      freeIds.add(id)
      while (highWatermark > 0 && freeIds.has(highWatermark - 1)) {
        freeIds.delete(highWatermark - 1)
        highWatermark--
      }
      rec.mesh.count = highWatermark
      _matrixData.delete(id)
      _attrData.delete(id)
      _visibleData.delete(id)
    },
    setMatrixAt(id, matrix) {
      rec.setMatrixAt(id, matrix)
      _matrixData.set(id, matrix.clone())
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
    dispose() { _matrixData.clear(); _attrData.clear(); _visibleData.clear() },
  }
  return adapter
}
