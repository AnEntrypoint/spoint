import * as THREE from 'three'
import { SHADOW_CASTER_ONLY_LAYER } from './ShadowLayers.js'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3(1, 1, 1)
const _m4 = new THREE.Matrix4()
const LOD_REEVAL_MOVE_SQ = 0.5 * 0.5
const NO_MESH_TIER = -1
const LOD_CELL_M = 32
const CELL_COORD_BIAS = 1048576
const CELL_KEY_SPAN = 4194304
const FRUSTUM_OUT = 0, FRUSTUM_PART = 1, FRUSTUM_IN = 2
const MODE_FAR = 1, MODE_OUT = 2, MODE_TIER = 3
const MODE_KEY_SPAN = 1024

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

  const cells = new Map()
  const cellList = []
  let eyeEpoch = 0

  function cellKeyOf(x, z) {
    return (Math.floor(x / LOD_CELL_M) + CELL_COORD_BIAS) * CELL_KEY_SPAN + (Math.floor(z / LOD_CELL_M) + CELL_COORD_BIAS)
  }

  function joinCell(id, rec) {
    const m = rec.matrix, r = rec.bounds.radius
    const key = cellKeyOf(m[12], m[14])
    let cell = cells.get(key)
    if (cell === undefined) {
      cell = { key, ids: [], listIdx: cellList.length, x0: m[12], x1: m[12], y0: m[13], y1: m[13], z0: m[14], z1: m[14], maxR: r, appliedKey: 0, tierEpoch: -1 }
      cells.set(key, cell); cellList.push(cell)
    } else {
      if (m[12] < cell.x0) cell.x0 = m[12]; if (m[12] > cell.x1) cell.x1 = m[12]
      if (m[13] < cell.y0) cell.y0 = m[13]; if (m[13] > cell.y1) cell.y1 = m[13]
      if (m[14] < cell.z0) cell.z0 = m[14]; if (m[14] > cell.z1) cell.z1 = m[14]
      if (r > cell.maxR) cell.maxR = r
      cell.appliedKey = 0
    }
    rec.cell = cell; rec.cellSlot = cell.ids.length
    cell.ids.push(id)
  }

  function leaveCell(rec) {
    const cell = rec.cell, ids = cell.ids, last = ids.length - 1
    if (rec.cellSlot !== last) { const movedId = ids[last]; ids[rec.cellSlot] = movedId; recs[movedId].cellSlot = rec.cellSlot }
    ids.pop()
    rec.cell = null
    if (last === 0) {
      cells.delete(cell.key)
      const tail = cellList.pop()
      if (tail !== cell) { cellList[cell.listIdx] = tail; tail.listIdx = cell.listIdx }
    }
  }

  function invalidateCells() {
    for (let i = 0; i < cellList.length; i++) { cellList[i].appliedKey = 0; cellList[i].tierEpoch = -1 }
  }

  function frustumClass(frustum, cell) {
    const planes = frustum.planes, r = cell.maxR
    let allInside = true
    for (let p = 0; p < 6; p++) {
      const n = planes[p].normal, c = planes[p].constant
      const px = n.x > 0 ? cell.x1 + r : cell.x0 - r, py = n.y > 0 ? cell.y1 + r : cell.y0 - r, pz = n.z > 0 ? cell.z1 + r : cell.z0 - r
      if (n.x * px + n.y * py + n.z * pz + c < 0) return FRUSTUM_OUT
      if (allInside) {
        const qx = n.x > 0 ? cell.x0 - r : cell.x1 + r, qy = n.y > 0 ? cell.y0 - r : cell.y1 + r, qz = n.z > 0 ? cell.z0 - r : cell.z1 + r
        if (n.x * qx + n.y * qy + n.z * qz + c < 0) allInside = false
      }
    }
    return allInside ? FRUSTUM_IN : FRUSTUM_PART
  }

  function applyShadowWanted(id, rec, shadowWanted) {
    rec.shadowWanted = shadowWanted
    if (rec.visible) { if (shadowWanted) shadow.add(id, rec); else shadow.remove(id) }
  }

  function applyUniformCell(cell, key, mode, tier, shadowAll) {
    const ids = cell.ids
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], rec = recs[id]
      if (shadow && shadowAll !== rec.shadowWanted) applyShadowWanted(id, rec, shadowAll)
      if (mode === MODE_OUT) {
        if (!rec.viewCulled) { if (inView(rec) && rec.tier !== NO_MESH_TIER) tiers[rec.tier].remove(id); rec.viewCulled = true }
      } else if (tier !== rec.tier || rec.viewCulled) placeInTier(id, rec, tier, false)
    }
    cell.appliedKey = key
    cell.tierEpoch = mode === MODE_OUT ? -1 : eyeEpoch
  }

  function evaluateCell(cell, frustumState, moved, frustum) {
    const ids = cell.ids, refreshTier = moved || cell.tierEpoch !== eyeEpoch
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], rec = recs[id]
      let tier = rec.tier
      if (refreshTier) {
        const m = rec.matrix
        const dx = m[12] - lodEyeX, dy = m[13] - lodEyeY, dz = m[14] - lodEyeZ
        const dsq = dx * dx + dy * dy + dz * dz
        tier = tierFor(dsq)
        const shadowWanted = shadowDistSq >= 0 && dsq <= shadowDistSq
        if (shadow && shadowWanted !== rec.shadowWanted) applyShadowWanted(id, rec, shadowWanted)
      }
      const culled = tier === NO_MESH_TIER || frustumState === FRUSTUM_IN ? false : frustumState === FRUSTUM_OUT ? true : !frustum.intersectsSphere(rec.bounds)
      if (tier !== rec.tier || culled !== rec.viewCulled) placeInTier(id, rec, tier, culled)
    }
    cell.appliedKey = 0
    cell.tierEpoch = eyeEpoch
  }

  function updateLOD(cameraPos, frustum, viewChanged) {
    const ex = cameraPos.x - lodEyeX, ey = cameraPos.y - lodEyeY, ez = cameraPos.z - lodEyeZ
    const moved = lodStale || ex * ex + ey * ey + ez * ez >= LOD_REEVAL_MOVE_SQ
    if (!moved && !viewChanged) return
    if (moved) { lodEyeX = cameraPos.x; lodEyeY = cameraPos.y; lodEyeZ = cameraPos.z; lodStale = false; eyeEpoch++ }
    for (let c = 0; c < cellList.length; c++) {
      const cell = cellList[c]
      const gx = Math.max(cell.x0 - lodEyeX, 0, lodEyeX - cell.x1), gy = Math.max(cell.y0 - lodEyeY, 0, lodEyeY - cell.y1), gz = Math.max(cell.z0 - lodEyeZ, 0, lodEyeZ - cell.z1)
      const fx = Math.max(lodEyeX - cell.x0, cell.x1 - lodEyeX), fy = Math.max(lodEyeY - cell.y0, cell.y1 - lodEyeY), fz = Math.max(lodEyeZ - cell.z0, cell.z1 - lodEyeZ)
      const dminSq = gx * gx + gy * gy + gz * gz, dmaxSq = fx * fx + fy * fy + fz * fz
      const shadowAll = shadowDistSq >= 0 && dmaxSq <= shadowDistSq
      const shadowNone = shadowDistSq < 0 || dminSq > shadowDistSq
      const frustumState = frustum ? frustumClass(frustum, cell) : FRUSTUM_IN
      if (shadowAll || shadowNone) {
        const tierNear = tierFor(dminSq), tierFar = tierFor(dmaxSq)
        const shadowBit = shadowAll ? 1 : 0
        if (tierNear === NO_MESH_TIER) {
          const key = MODE_FAR * MODE_KEY_SPAN + shadowBit
          if (cell.appliedKey !== key) applyUniformCell(cell, key, MODE_FAR, NO_MESH_TIER, shadowAll)
          continue
        }
        if (frustumState === FRUSTUM_OUT && tierFar !== NO_MESH_TIER) {
          const key = MODE_OUT * MODE_KEY_SPAN + shadowBit
          if (cell.appliedKey !== key) applyUniformCell(cell, key, MODE_OUT, tierNear, shadowAll)
          continue
        }
        if (frustumState === FRUSTUM_IN && tierNear === tierFar) {
          const key = MODE_TIER * MODE_KEY_SPAN + tierNear * 2 + shadowBit
          if (cell.appliedKey !== key) applyUniformCell(cell, key, MODE_TIER, tierNear, shadowAll)
          continue
        }
      }
      evaluateCell(cell, frustumState, moved, frustum)
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
        joinCell(id, rec)
        liveCount++
        tiers[0].add(id, rec)
      }
      if (count > 0) lodStale = true
    },
    removeInstances(id) {
      const rec = recs[id]
      if (!rec) return
      if (rec.visible) hide(id, rec)
      leaveCell(rec)
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
      invalidateCells()
    },
    get lodTierCount() { return tiers.length },
    get shadowActiveCount() { return shadow ? shadow.size : 0 },
    get tierMeshes() { return tiers.map(t => t.mesh) },
    get shadowMesh() { return shadow ? shadow.mesh : null },
    dispose() { for (const p of pools) p.dispose(); recs.length = 0; cells.clear(); cellList.length = 0; liveCount = 0; freeIds.length = 0 },
  }
}
