import * as THREE from 'three'
import { SHADOW_CASTER_ONLY_LAYER } from './ShadowLayers.js'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3(1, 1, 1)
const _m4 = new THREE.Matrix4()
const LOD_REEVAL_MOVE_SQ = 0.5 * 0.5
const NO_MESH_TIER = -1
const SPAN_STRIDE = 7

function createDensePool(scene, geometry, material, capacity, attributeSchema, props, shadowOnly) {
  const ids = []
  const slotOf = new Map()
  let mesh = null, attrs = null, cap = 0
  let dirtyLo = 0, dirtyHi = -1, uploadedSinceMark = true

  function setDirtyRange(attr, itemSize, n, newWindow) {
    const ranges = attr.updateRanges
    if (newWindow || ranges.length === 0) { attr.clearUpdateRanges(); attr.addUpdateRange(dirtyLo * itemSize, n * itemSize) }
    else { ranges[0].start = dirtyLo * itemSize; ranges[0].count = n * itemSize }
    attr.needsUpdate = true
  }

  function markSlotDirty(slot) {
    const newWindow = uploadedSinceMark
    if (newWindow) { dirtyLo = slot; dirtyHi = slot; uploadedSinceMark = false }
    else { if (slot < dirtyLo) dirtyLo = slot; if (slot > dirtyHi) dirtyHi = slot }
    const n = dirtyHi - dirtyLo + 1
    setDirtyRange(mesh.instanceMatrix, 16, n, newWindow)
    for (const name in attrs) setDirtyRange(attrs[name], attrs[name].itemSize, n, newWindow)
    mesh.count = ids.length
    mesh.visible = props.visible && ids.length > 0
  }

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
    uploadedSinceMark = true
    applyProps()
    mesh.count = ids.length
    if (shadowOnly) {
      mesh.castShadow = true
      mesh.layers.set(SHADOW_CASTER_ONLY_LAYER)
      mesh.onBeforeShadow = () => { uploadedSinceMark = true }
    } else {
      mesh.onBeforeRender = () => { uploadedSinceMark = true }
    }
    scene.add(mesh)
  }

  function applyProps() {
    if (!mesh) return
    mesh.frustumCulled = false
    mesh.renderOrder = props.renderOrder
    mesh.visible = props.visible && ids.length > 0
    mesh.matrixAutoUpdate = props.matrixAutoUpdate
    mesh.updateMatrix()
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
    markSlotDirty(slot)
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
    markSlotDirty(slot)
  }

  function setAttr(id, name, value) {
    const slot = slotOf.get(id), a = attrs[name]
    if (slot === undefined || !a) return
    if (a.itemSize === 1) a.array[slot] = value
    else for (let i = 0; i < a.itemSize; i++) a.array[slot * a.itemSize + i] = value[i]
    markSlotDirty(slot)
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
  const recs = []
  const freeIds = []
  let liveCount = 0

  let meshFarSq = Infinity

  function tierFor(dsq) {
    if (dsq >= meshFarSq) return NO_MESH_TIER
    for (let i = thresholdsSq.length - 1; i > 0; i--) if (dsq >= thresholdsSq[i]) return i
    return 0
  }

  function addToTier(tier, id, rec) { if (tier !== NO_MESH_TIER) tiers[tier].add(id, rec) }
  function removeFromTier(tier, id) { if (tier !== NO_MESH_TIER) tiers[tier].remove(id) }

  const inView = (rec) => rec.visible && !rec.viewCulled

  function show(id, rec) {
    if (!rec.viewCulled) addToTier(rec.tier, id, rec)
    if (shadow && rec.shadowWanted) shadow.add(id, rec)
  }

  function hide(id, rec) {
    removeFromTier(rec.tier, id)
    if (shadow) shadow.remove(id)
  }

  const proxy = {
    id: -1,
    position: { set(x, y, z) { _pos.set(x, y, z) } },
    quaternion: { copy(q) { _quat.copy(q) } },
    scale: { set(x, y, z) { _scale.set(x, y, z) }, setScalar(s) { _scale.set(s, s, s) } },
  }

  let lodEyeX = 0, lodEyeY = 0, lodEyeZ = 0, lodStale = true
  const baseGeometry = levels[0].geometry
  if (!baseGeometry.boundingSphere) baseGeometry.computeBoundingSphere()
  const levelBounds = baseGeometry.boundingSphere

  function placeInTier(id, rec, tier, culled) {
    const wasDrawn = inView(rec) && rec.tier !== NO_MESH_TIER
    const nowDrawn = rec.visible && !culled && tier !== NO_MESH_TIER
    if (wasDrawn && (!nowDrawn || tier !== rec.tier)) tiers[rec.tier].remove(id)
    const addNow = nowDrawn && (!wasDrawn || tier !== rec.tier)
    rec.tier = tier; rec.viewCulled = culled
    if (addNow) tiers[tier].add(id, rec)
  }

  const planeBuf = new Float64Array(24)
  let spans = new Float32Array(0), liveFlags = new Uint8Array(0)

  function ensureSpanCapacity(n) {
    if (liveFlags.length >= n) return
    const cap = Math.max(n, liveFlags.length * 2, 64)
    const nextSpans = new Float32Array(cap * SPAN_STRIDE); nextSpans.set(spans); spans = nextSpans
    const nextLive = new Uint8Array(cap); nextLive.set(liveFlags); liveFlags = nextLive
  }

  function storeSpan(id, rec) {
    ensureSpanCapacity(id + 1)
    const m = rec.matrix, c = rec.bounds.center, o = id * SPAN_STRIDE
    spans[o] = m[12]; spans[o + 1] = m[13]; spans[o + 2] = m[14]
    spans[o + 3] = c.x; spans[o + 4] = c.y; spans[o + 5] = c.z; spans[o + 6] = rec.bounds.radius
    liveFlags[id] = 1
  }

  function applyShadowWanted(id, rec, shadowWanted) {
    rec.shadowWanted = shadowWanted
    if (rec.visible) { if (shadowWanted) shadow.add(id, rec); else shadow.remove(id) }
  }

  function updateLOD(cameraPos, frustum, viewChanged) {
    const ex = cameraPos.x - lodEyeX, ey = cameraPos.y - lodEyeY, ez = cameraPos.z - lodEyeZ
    const moved = lodStale || ex * ex + ey * ey + ez * ez >= LOD_REEVAL_MOVE_SQ
    if (!moved && !viewChanged) return
    if (moved) { lodEyeX = cameraPos.x; lodEyeY = cameraPos.y; lodEyeZ = cameraPos.z; lodStale = false }
    if (frustum) for (let p = 0, o = 0; p < 6; p++, o += 4) { const pl = frustum.planes[p]; planeBuf[o] = pl.normal.x; planeBuf[o + 1] = pl.normal.y; planeBuf[o + 2] = pl.normal.z; planeBuf[o + 3] = pl.constant }
    for (let id = 0; id < recs.length; id++) {
      const rec = recs[id]
      if (rec === null) continue
      const o = id * SPAN_STRIDE
      let tier = rec.tier
      if (moved) {
        const dx = spans[o] - lodEyeX, dy = spans[o + 1] - lodEyeY, dz = spans[o + 2] - lodEyeZ
        const dsq = dx * dx + dy * dy + dz * dz
        tier = tierFor(dsq)
        const shadowWanted = shadowDistSq >= 0 && dsq <= shadowDistSq
        if (shadow && shadowWanted !== rec.shadowWanted) applyShadowWanted(id, rec, shadowWanted)
      }
      let culled = false
      if (frustum && tier !== NO_MESH_TIER) {
        const bx = spans[o + 3], by = spans[o + 4], bz = spans[o + 5], nr = -spans[o + 6]
        for (let q = 0; q < 24; q += 4) if (planeBuf[q] * bx + planeBuf[q + 1] * by + planeBuf[q + 2] * bz + planeBuf[q + 3] < nr) { culled = true; break }
      }
      if (tier !== rec.tier || culled !== rec.viewCulled) placeInTier(id, rec, tier, culled)
    }
  }

  return {
    get capacity() { return tiers[0].capacity },
    get mesh() { return tiers[0].mesh },
    get geometry() { return tiers[0].mesh.geometry },
    get material() { return levels[0].material },
    get count() { return liveCount },
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
        const id = freeIds.length ? freeIds.pop() : recs.length
        _pos.set(0, 0, 0); _quat.identity(); _scale.set(1, 1, 1)
        proxy.id = id
        cb(proxy)
        _m4.compose(_pos, _quat, _scale)
        const rec = { matrix: Float32Array.from(_m4.elements), attrs: {}, tier: 0, shadowWanted: false, visible: true, viewCulled: false, bounds: new THREE.Sphere().copy(levelBounds).applyMatrix4(_m4) }
        recs[id] = rec
        storeSpan(id, rec)
        liveCount++
        tiers[0].add(id, rec)
      }
      if (count > 0) lodStale = true
    },
    removeInstances(id) {
      const rec = recs[id]
      if (!rec) return
      if (rec.visible) hide(id, rec)
      liveFlags[id] = 0
      recs[id] = null
      liveCount--
      freeIds.push(id)
    },
    setUniformAt(id, name, value) {
      const rec = recs[id]
      if (!rec) return
      rec.attrs[name] = typeof value === 'number' ? value : Array.from(value)
      if (!rec.visible) return
      if (!rec.viewCulled && rec.tier !== NO_MESH_TIER) tiers[rec.tier].setAttr(id, name, value)
      if (shadow && rec.shadowWanted) shadow.setAttr(id, name, value)
    },
    setVisibilityAt(id, visible) {
      const rec = recs[id]
      if (!rec || rec.visible === visible) return
      rec.visible = visible
      if (visible) show(id, rec); else hide(id, rec)
    },
    resizeBuffers() {},
    updateLOD,
    setMeshFarDistance(d) {
      if (!(d > 0)) throw new RangeError(`WebGPULodInstancer.setMeshFarDistance: distance must be positive, got ${d}`)
      meshFarSq = d * d
      lodStale = true
    },
    get lodTierCount() { return tiers.length },
    get shadowActiveCount() { return shadow ? shadow.size : 0 },
    get tierMeshes() { return tiers.map(t => t.mesh) },
    get shadowMesh() { return shadow ? shadow.mesh : null },
    dispose() { for (const p of pools) p.dispose(); recs.length = 0; liveFlags.fill(0); liveCount = 0; freeIds.length = 0 },
  }
}
