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

  const freeIds = []
  for (let i = capacity_ - 1; i >= 0; i--) freeIds.push(i)
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
    if (freeIds.length === 0) return -1
    const id = freeIds.pop()
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
    for (let i = newCap - 1; i >= capacity_; i--) freeIds.unshift(i)
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
    get count() { return capacity_ - freeIds.length },
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
      freeIds.push(id)
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
