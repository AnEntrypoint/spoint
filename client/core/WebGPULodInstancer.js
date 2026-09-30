import * as THREE from 'three'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3(1, 1, 1)
const _m4 = new THREE.Matrix4()

function createDensePool(scene, geometry, material, capacity, attributeSchema, props, shadowOnly) {
  const ids = []
  const slotOf = new Map()
  let mesh = null, attrs = null, cap = 0
  let shadowDrawPending = false

  function build(newCap) {
    const next = new THREE.InstancedMesh(geometry, material, newCap)
    next.count = 0
    const nextAttrs = {}
    for (const name in attributeSchema) {
      const itemSize = ITEM_SIZE[attributeSchema[name]]
      if (!itemSize) throw new Error(`WebGPULodInstancer: unsupported attribute type "${attributeSchema[name]}" for "${name}"`)
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(newCap * itemSize), itemSize)
      geometry.setAttribute(name, attr)
      nextAttrs[name] = attr
    }
    if (mesh) {
      next.instanceMatrix.array.set(mesh.instanceMatrix.array.subarray(0, ids.length * 16))
      for (const name in nextAttrs) nextAttrs[name].array.set(attrs[name].array.subarray(0, ids.length * nextAttrs[name].itemSize))
      scene.remove(mesh)
      mesh.dispose()
    }
    mesh = next; attrs = nextAttrs; cap = newCap
    applyProps()
    if (shadowOnly) {
      mesh.castShadow = true
      mesh.onBeforeShadow = () => { mesh.count = ids.length; shadowDrawPending = true }
      mesh.onBeforeRender = () => { if (shadowDrawPending) shadowDrawPending = false; else mesh.count = 0 }
    } else {
      mesh.count = ids.length
    }
    scene.add(mesh)
  }

  function applyProps() {
    if (!mesh) return
    mesh.frustumCulled = false
    mesh.renderOrder = props.renderOrder
    mesh.visible = props.visible
    mesh.matrixAutoUpdate = props.matrixAutoUpdate
    mesh.updateMatrix()
  }

  function markDirty() {
    mesh.instanceMatrix.needsUpdate = true
    for (const name in attrs) attrs[name].needsUpdate = true
    if (!shadowOnly) mesh.count = ids.length
  }

  function writeSlot(slot, rec) {
    mesh.instanceMatrix.array.set(rec.matrix, slot * 16)
    for (const name in attrs) {
      const a = attrs[name], v = rec.attrs[name]
      if (v == null) continue
      if (a.itemSize === 1) a.array[slot] = v
      else for (let i = 0; i < a.itemSize; i++) a.array[slot * a.itemSize + i] = v[i]
    }
  }

  function add(id, rec) {
    if (slotOf.has(id)) return
    if (ids.length >= cap) build(cap * 2)
    const slot = ids.length
    ids.push(id); slotOf.set(id, slot)
    writeSlot(slot, rec)
    markDirty()
  }

  function remove(id) {
    const slot = slotOf.get(id)
    if (slot === undefined) return
    const last = ids.length - 1
    if (slot !== last) {
      const movedId = ids[last]
      mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16)
      for (const name in attrs) { const s = attrs[name].itemSize; attrs[name].array.copyWithin(slot * s, last * s, last * s + s) }
      ids[slot] = movedId; slotOf.set(movedId, slot)
    }
    ids.pop(); slotOf.delete(id)
    markDirty()
  }

  function setAttr(id, name, value) {
    const slot = slotOf.get(id), a = attrs[name]
    if (slot === undefined || !a) return
    if (a.itemSize === 1) a.array[slot] = value
    else for (let i = 0; i < a.itemSize; i++) a.array[slot * a.itemSize + i] = value[i]
    a.needsUpdate = true
  }

  function dispose() { scene.remove(mesh); mesh.dispose() }

  build(Math.max(1, capacity))
  return { add, remove, setAttr, applyProps, dispose, get mesh() { return mesh }, get size() { return ids.length }, get capacity() { return cap } }
}

export function createWebGPULodInstancer(scene, levels, capacity, attributeSchema = {}, opts = {}) {
  if (!Array.isArray(levels) || levels.length === 0) throw new Error('WebGPULodInstancer: at least one LOD level is required')
  const hysteresis = Number.isFinite(opts.hysteresis) ? opts.hysteresis : 0
  const shadowDistSq = Number.isFinite(opts.shadowDistance) ? opts.shadowDistance * opts.shadowDistance : -1
  const thresholdsSq = levels.map(lv => { const d = Number.isFinite(lv.distance) ? lv.distance : 0; const t = d - d * hysteresis; return t * t })
  const props = { renderOrder: 0, visible: true, matrixAutoUpdate: true }
  const tiers = levels.map(lv => createDensePool(scene, lv.geometry, lv.material, capacity, attributeSchema, props, false))
  const shadow = opts.shadowGeometry ? createDensePool(scene, opts.shadowGeometry, opts.shadowMaterial || levels[0].material, capacity, attributeSchema, props, true) : null
  const pools = shadow ? [...tiers, shadow] : tiers
  const instances = new Map()
  const freeIds = []
  let nextId = 0

  function tierFor(dsq) {
    for (let i = thresholdsSq.length - 1; i > 0; i--) if (dsq >= thresholdsSq[i]) return i
    return 0
  }

  function show(id, rec) {
    tiers[rec.tier].add(id, rec)
    if (shadow && rec.shadowWanted) shadow.add(id, rec)
  }

  function hide(id, rec) {
    tiers[rec.tier].remove(id)
    if (shadow) shadow.remove(id)
  }

  const proxy = {
    id: -1,
    position: { set(x, y, z) { _pos.set(x, y, z) } },
    quaternion: { copy(q) { _quat.copy(q) } },
    scale: { set(x, y, z) { _scale.set(x, y, z) }, setScalar(s) { _scale.set(s, s, s) } },
  }

  function updateLOD(cameraPos) {
    for (const [id, rec] of instances) {
      const m = rec.matrix
      const dx = m[12] - cameraPos.x, dy = m[13] - cameraPos.y, dz = m[14] - cameraPos.z
      const dsq = dx * dx + dy * dy + dz * dz
      const tier = tierFor(dsq)
      const shadowWanted = shadowDistSq >= 0 && dsq <= shadowDistSq
      if (tier !== rec.tier) {
        if (rec.visible) { tiers[rec.tier].remove(id); tiers[tier].add(id, rec) }
        rec.tier = tier
      }
      if (shadow && shadowWanted !== rec.shadowWanted) {
        rec.shadowWanted = shadowWanted
        if (rec.visible) { if (shadowWanted) shadow.add(id, rec); else shadow.remove(id) }
      }
    }
  }

  return {
    get capacity() { return tiers[0].capacity },
    get mesh() { return tiers[0].mesh },
    get geometry() { return tiers[0].mesh.geometry },
    get material() { return levels[0].material },
    get count() { return instances.size },
    perObjectFrustumCulled: false,
    autoUpdate: true,
    get visible() { return props.visible },
    set visible(v) { props.visible = v; for (const p of pools) p.applyProps() },
    get frustumCulled() { return false },
    set frustumCulled(v) {},
    get renderOrder() { return props.renderOrder },
    set renderOrder(v) { props.renderOrder = v; for (const p of pools) p.applyProps() },
    get matrixAutoUpdate() { return props.matrixAutoUpdate },
    set matrixAutoUpdate(v) { props.matrixAutoUpdate = v; for (const p of pools) p.applyProps() },
    updateMatrix() { for (const p of pools) p.mesh.updateMatrix() },
    addInstances(count, cb) {
      for (let i = 0; i < count; i++) {
        const id = freeIds.length ? freeIds.pop() : nextId++
        _pos.set(0, 0, 0); _quat.identity(); _scale.set(1, 1, 1)
        proxy.id = id
        cb(proxy)
        _m4.compose(_pos, _quat, _scale)
        const rec = { matrix: Float32Array.from(_m4.elements), attrs: {}, tier: 0, shadowWanted: false, visible: true }
        instances.set(id, rec)
        tiers[0].add(id, rec)
      }
    },
    removeInstances(id) {
      const rec = instances.get(id)
      if (!rec) return
      if (rec.visible) hide(id, rec)
      instances.delete(id)
      freeIds.push(id)
    },
    setUniformAt(id, name, value) {
      const rec = instances.get(id)
      if (!rec) return
      rec.attrs[name] = typeof value === 'number' ? value : Array.from(value)
      if (!rec.visible) return
      tiers[rec.tier].setAttr(id, name, value)
      if (shadow && rec.shadowWanted) shadow.setAttr(id, name, value)
    },
    setVisibilityAt(id, visible) {
      const rec = instances.get(id)
      if (!rec || rec.visible === visible) return
      rec.visible = visible
      if (visible) show(id, rec); else hide(id, rec)
    },
    resizeBuffers() {},
    updateLOD,
    get lodTierCount() { return tiers.length },
    get shadowActiveCount() { return shadow ? shadow.size : 0 },
    get tierMeshes() { return tiers.map(t => t.mesh) },
    get shadowMesh() { return shadow ? shadow.mesh : null },
    dispose() { for (const p of pools) p.dispose(); instances.clear(); freeIds.length = 0 },
  }
}
