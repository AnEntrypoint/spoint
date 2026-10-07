import * as THREE from 'three'
import { SHADOW_CASTER_ONLY_LAYER } from './ShadowLayers.js'

const ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 }
const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scale = new THREE.Vector3(1, 1, 1)
const _m4 = new THREE.Matrix4()
const LOD_REEVAL_MOVE_SQ = 0.5 * 0.5
const NO_MESH_TIER = -1
const SPAN_STRIDE = 7

const MAX_CELLS = 4096
const GRID_MIN_INSTANCES = 32
const GRID_MIN_OCCUPANCY = 2
const GRID_MIN_PENDING_REBUILD = 64
const GRID_PENDING_REBUILD_DIV = 8
const CELL_SIZE = 24
const TARGET_CELL_OCCUPANCY = 4
const CELL_OUT = 0, CELL_IN = 1, CELL_PART = 2
const MODE_NOT_DRAWN = 0, MODE_UNIFORM = 1, MODE_MIXED = 2
const SHADOW_NONE = 0, SHADOW_ALL = 1, SHADOW_MIXED = 2
const APPLIED_INVALID = 255

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
  return { add, remove, setAttr, applyProps, dispose, get mesh() { return mesh }, get size() { return ids.length }, get capacity() { return cap }, get ids() { return ids } }
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
  let meshFarDist = Infinity
  const sweepStats = { updateCalls: 0, recordsWalked: 0, planeTests: 0, cellsTested: 0, cellsSkipped: 0, rebuilds: 0, rebuildRecords: 0 }

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

  const grid = {
    dirty: true,
    usable: false,
    cells: 0,
    order: new Int32Array(0),
    start: new Int32Array(0),
    cursor: new Int32Array(0),
    counts: new Int32Array(0),
    posMin: new Float32Array(0),
    posMax: new Float32Array(0),
    cenMin: new Float32Array(0),
    cenMax: new Float32Array(0),
    maxR: new Float32Array(0),
    minR: new Float32Array(0),
    state: new Uint8Array(0),
    mask: new Uint8Array(0),
    mode: new Uint8Array(0),
    tier: new Int8Array(0),
    shadowMode: new Uint8Array(0),
    cellOf: new Int32Array(0),
    stamp: new Int32Array(0),
    active: new Int32Array(0),
    nextActive: new Int32Array(0),
    activeCount: 0,
    now: 0,
    minX: 0,
    minZ: 0,
    invCell: 1,
    nx: 0,
    nz: 0,
    spanX: 0,
    spanZ: 0,
    maxRadiusAll: 0,
    pending: new Int32Array(0),
    pendingCount: 0,
    builtLive: 0,
    removedSinceBuild: 0,
  }

  function ensurePendingCapacity(n) {
    if (grid.pending.length >= n) return
    const cap = Math.max(n, grid.pending.length * 2, 64)
    const next = new Int32Array(cap)
    next.set(grid.pending)
    grid.pending = next
  }

  function enqueuePending(id) {
    ensurePendingCapacity(grid.pendingCount + 1)
    grid.pending[grid.pendingCount++] = id
  }

  function gridNeedsRebuild() {
    if (grid.dirty) return true
    const cap = Math.max(GRID_MIN_PENDING_REBUILD, grid.builtLive / GRID_PENDING_REBUILD_DIV)
    return grid.pendingCount >= cap || grid.removedSinceBuild >= cap
  }

  function ensureGridCapacity(cells, live) {
    if (grid.posMin.length < cells * 3) {
      grid.posMin = new Float32Array(cells * 3)
      grid.posMax = new Float32Array(cells * 3)
      grid.cenMin = new Float32Array(cells * 3)
      grid.cenMax = new Float32Array(cells * 3)
      grid.maxR = new Float32Array(cells)
      grid.minR = new Float32Array(cells)
      grid.state = new Uint8Array(cells)
      grid.mask = new Uint8Array(cells)
      grid.mode = new Uint8Array(cells)
      grid.tier = new Int8Array(cells)
      grid.shadowMode = new Uint8Array(cells)
    }
    if (grid.start.length < cells + 1) {
      grid.start = new Int32Array(cells + 1)
      grid.cursor = new Int32Array(cells + 1)
      grid.counts = new Int32Array(cells + 1)
      grid.stamp = new Int32Array(cells)
      grid.active = new Int32Array(cells)
      grid.nextActive = new Int32Array(cells)
    }
    if (grid.order.length < live) grid.order = new Int32Array(Math.max(live, 64))
    if (grid.cellOf.length < recs.length) {
      grid.cellOf = new Int32Array(Math.max(recs.length, grid.cellOf.length * 2, 64))
      grid.cellOf.fill(-1)
    }
  }

  function rebuildGrid() {
    grid.dirty = false
    grid.pendingCount = 0
    grid.removedSinceBuild = 0
    sweepStats.rebuilds++
    const n = recs.length
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, live = 0
    for (let id = 0; id < n; id++) {
      if (recs[id] === null) continue
      sweepStats.rebuildRecords++
      const o = id * SPAN_STRIDE
      const x = spans[o], z = spans[o + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
      live++
    }
    if (live < GRID_MIN_INSTANCES) { grid.builtLive = live; grid.usable = false; grid.cells = 0; return }
    const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ)
    const densityCell = Math.sqrt((spanX * spanZ) / Math.max(1, live / TARGET_CELL_OCCUPANCY))
    const cellCap = Math.max(CELL_SIZE, Math.min(spanX, spanZ) / 3)
    let cellSize = Math.min(Math.max(CELL_SIZE, densityCell), cellCap)
    let nx = 0, nz = 0
    for (let i = 0; i < 12; i++) {
      nx = Math.floor(spanX / cellSize) + 1
      nz = Math.floor(spanZ / cellSize) + 1
      if (nx * nz <= MAX_CELLS) break
      cellSize *= 2
    }
    const cells = nx * nz
    if (live / cells < GRID_MIN_OCCUPANCY) { grid.builtLive = live; grid.usable = false; grid.cells = 0; return }
    ensureGridCapacity(cells, live)
    grid.builtLive = live
    const counts = grid.counts
    counts.fill(0, 0, cells + 1)
    grid.cellOf.fill(-1, 0, n)
    for (let id = 0; id < n; id++) {
      if (recs[id] === null) continue
      sweepStats.rebuildRecords++
      const o = id * SPAN_STRIDE
      const ix = Math.floor((spans[o] - minX) / cellSize)
      const iz = Math.floor((spans[o + 2] - minZ) / cellSize)
      const c = iz * nx + ix
      grid.cellOf[id] = c
      counts[c + 1]++
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c]
    grid.start.set(counts.subarray(0, cells + 1))
    grid.cursor.set(grid.start.subarray(0, cells + 1))
    const order = grid.order
    for (let id = 0; id < n; id++) {
      if (recs[id] === null) continue
      sweepStats.rebuildRecords++
      order[grid.cursor[grid.cellOf[id]]++] = id
    }
    const posMin = grid.posMin, posMax = grid.posMax, cenMin = grid.cenMin, cenMax = grid.cenMax, maxR = grid.maxR, minR = grid.minR
    for (let c = 0; c < cells; c++) {
      const b = c * 3
      posMin[b] = Infinity; posMin[b + 1] = Infinity; posMin[b + 2] = Infinity
      posMax[b] = -Infinity; posMax[b + 1] = -Infinity; posMax[b + 2] = -Infinity
      cenMin[b] = Infinity; cenMin[b + 1] = Infinity; cenMin[b + 2] = Infinity
      cenMax[b] = -Infinity; cenMax[b + 1] = -Infinity; cenMax[b + 2] = -Infinity
      maxR[c] = 0; minR[c] = Infinity
    }
    for (let i = 0; i < live; i++) {
      sweepStats.rebuildRecords++
      const id = order[i], o = id * SPAN_STRIDE
      const c = grid.cellOf[id], b = c * 3
      const x = spans[o], y = spans[o + 1], z = spans[o + 2]
      if (x < posMin[b]) posMin[b] = x
      if (y < posMin[b + 1]) posMin[b + 1] = y
      if (z < posMin[b + 2]) posMin[b + 2] = z
      if (x > posMax[b]) posMax[b] = x
      if (y > posMax[b + 1]) posMax[b + 1] = y
      if (z > posMax[b + 2]) posMax[b + 2] = z
      const cx = spans[o + 3], cy = spans[o + 4], cz = spans[o + 5]
      if (cx < cenMin[b]) cenMin[b] = cx
      if (cy < cenMin[b + 1]) cenMin[b + 1] = cy
      if (cz < cenMin[b + 2]) cenMin[b + 2] = cz
      if (cx > cenMax[b]) cenMax[b] = cx
      if (cy > cenMax[b + 1]) cenMax[b + 1] = cy
      if (cz > cenMax[b + 2]) cenMax[b + 2] = cz
      if (spans[o + 6] > maxR[c]) maxR[c] = spans[o + 6]
      if (spans[o + 6] < minR[c]) minR[c] = spans[o + 6]
    }
    grid.mode.fill(APPLIED_INVALID, 0, cells)
    grid.stamp.fill(0, 0, cells)
    grid.activeCount = 0
    grid.now = 0
    grid.minX = minX
    grid.minZ = minZ
    grid.invCell = 1 / cellSize
    grid.nx = nx
    grid.nz = nz
    grid.spanX = spanX
    grid.spanZ = spanZ
    grid.cells = cells
    grid.usable = true
    let radiusAll = 0
    for (let i = 0; i < live; i++) {
      sweepStats.rebuildRecords++
      const o = order[i] * SPAN_STRIDE
      if (spans[o + 6] > radiusAll) radiusAll = spans[o + 6]
    }
    grid.maxRadiusAll = radiusAll
    for (let id = 0; id < n; id++) {
      const rec = recs[id]
      if (rec === null) continue
      sweepStats.rebuildRecords++
      if (rec.tier !== NO_MESH_TIER || rec.viewCulled) placeInTier(id, rec, NO_MESH_TIER, false)
      if (shadow && rec.shadowWanted) applyShadowWanted(id, rec, false)
    }
  }

  function invalidateCellOf(id) {
    if (!grid.usable || id >= grid.cellOf.length) return
    const c = grid.cellOf[id]
    if (c >= 0 && c < grid.cells) grid.mode[c] = APPLIED_INVALID
  }

  let walked = 0, planeTests = 0

  function sweepPendingInstances() {
    for (let i = 0; i < grid.pendingCount; i++) {
      const id = grid.pending[i], rec = recs[id]
      walked++
      if (rec === null) continue
      const o = id * SPAN_STRIDE
      const dx = spans[o] - lodEyeX, dy = spans[o + 1] - lodEyeY, dz = spans[o + 2] - lodEyeZ
      const dsq = dx * dx + dy * dy + dz * dz
      const tier = tierFor(dsq)
      const shadowWanted = shadowDistSq >= 0 && dsq <= shadowDistSq
      if (shadow && shadowWanted !== rec.shadowWanted) applyShadowWanted(id, rec, shadowWanted)
      let culled = false
      if (tier !== NO_MESH_TIER) {
        const cx = spans[o + 3], cy = spans[o + 4], cz = spans[o + 5], nr = -spans[o + 6]
        for (let q = 0; q < 24; q += 4) {
          planeTests++
          if (planeBuf[q] * cx + planeBuf[q + 1] * cy + planeBuf[q + 2] * cz + planeBuf[q + 3] < nr) { culled = true; break }
        }
      }
      if (tier !== rec.tier || culled !== rec.viewCulled) placeInTier(id, rec, tier, culled)
    }
  }

  function updateLOD(cameraPos, frustum, viewChanged) {
    sweepStats.updateCalls++
    walked = 0
    planeTests = 0
    const ex = cameraPos.x - lodEyeX, ey = cameraPos.y - lodEyeY, ez = cameraPos.z - lodEyeZ
    const moved = lodStale || ex * ex + ey * ey + ez * ez >= LOD_REEVAL_MOVE_SQ
    if (!moved && !viewChanged) return
    if (moved) { lodEyeX = cameraPos.x; lodEyeY = cameraPos.y; lodEyeZ = cameraPos.z; lodStale = false }
    if (frustum) for (let p = 0, o = 0; p < 6; p++, o += 4) { const pl = frustum.planes[p]; planeBuf[o] = pl.normal.x; planeBuf[o + 1] = pl.normal.y; planeBuf[o + 2] = pl.normal.z; planeBuf[o + 3] = pl.constant }
    if (gridNeedsRebuild()) rebuildGrid()
    if (grid.usable && frustum) {
      const posMin = grid.posMin, posMax = grid.posMax
      const cenMin = grid.cenMin, cenMax = grid.cenMax, maxR = grid.maxR, minR = grid.minR
      const reach = Math.min(meshFarDist, grid.spanX + grid.spanZ + grid.maxRadiusAll)
      const ixMin = Math.max(0, Math.floor((lodEyeX - reach - grid.minX) * grid.invCell))
      const ixMax = Math.min(grid.nx - 1, Math.floor((lodEyeX + reach - grid.minX) * grid.invCell))
      const izMin = Math.max(0, Math.floor((lodEyeZ - reach - grid.minZ) * grid.invCell))
      const izMax = Math.min(grid.nz - 1, Math.floor((lodEyeZ + reach - grid.minZ) * grid.invCell))
      const now = ++grid.now
      const nextActive = grid.nextActive
      let nextCount = 0
      for (let iz = izMin; iz <= izMax; iz++) {
        const rowBase = iz * grid.nx
        for (let ix = ixMin; ix <= ixMax; ix++) {
          const c = rowBase + ix
          if (grid.start[c] === grid.start[c + 1]) continue
          const b = c * 3
          const rMax = maxR[c], rMin = minR[c]
          let mask = 0
          let cellOut = false
          for (let q = 0; q < 24; q += 4) {
            planeTests++
            const nx2 = planeBuf[q], ny2 = planeBuf[q + 1], nz2 = planeBuf[q + 2], pc = planeBuf[q + 3]
            const fx2 = nx2 > 0 ? cenMax[b] : cenMin[b]
            const fy2 = ny2 > 0 ? cenMax[b + 1] : cenMin[b + 1]
            const fz2 = nz2 > 0 ? cenMax[b + 2] : cenMin[b + 2]
            if (nx2 * fx2 + ny2 * fy2 + nz2 * fz2 + pc < -rMax) { cellOut = true; break }
            const ax = nx2 > 0 ? cenMin[b] : cenMax[b]
            const ay = ny2 > 0 ? cenMin[b + 1] : cenMax[b + 1]
            const az = nz2 > 0 ? cenMin[b + 2] : cenMax[b + 2]
            if (nx2 * ax + ny2 * ay + nz2 * az + pc < -rMin) mask |= 1 << (q >> 2)
          }
          const gx = Math.max(posMin[b] - lodEyeX, 0, lodEyeX - posMax[b])
          const gy = Math.max(posMin[b + 1] - lodEyeY, 0, lodEyeY - posMax[b + 1])
          const gz = Math.max(posMin[b + 2] - lodEyeZ, 0, lodEyeZ - posMax[b + 2])
          const fx = Math.max(lodEyeX - posMin[b], posMax[b] - lodEyeX)
          const fy = Math.max(lodEyeY - posMin[b + 1], posMax[b + 1] - lodEyeY)
          const fz = Math.max(lodEyeZ - posMin[b + 2], posMax[b + 2] - lodEyeZ)
          const dminSq = gx * gx + gy * gy + gz * gz
          const dmaxSq = fx * fx + fy * fy + fz * fz
          const tierNear = tierFor(dminSq)
          const tierFar = tierFor(dmaxSq)
          let shadowMode = SHADOW_NONE
          if (shadowDistSq >= 0) shadowMode = dmaxSq <= shadowDistSq ? SHADOW_ALL : (dminSq > shadowDistSq ? SHADOW_NONE : SHADOW_MIXED)
          const state = cellOut ? CELL_OUT : (mask === 0 ? CELL_IN : CELL_PART)
          grid.state[c] = state
          grid.mask[c] = cellOut ? 63 : mask
          const out = cellOut
          let mode = MODE_MIXED, cellTier = tierNear
          if (tierNear === NO_MESH_TIER || out) mode = MODE_NOT_DRAWN
          else if (tierNear === tierFar && shadowMode !== SHADOW_MIXED) mode = state === CELL_IN ? MODE_UNIFORM : MODE_MIXED
          if (mode !== MODE_MIXED && grid.mode[c] === mode && grid.tier[c] === cellTier && grid.shadowMode[c] === shadowMode) { sweepStats.cellsSkipped++; grid.stamp[c] = now; nextActive[nextCount++] = c; continue }
          const s0 = grid.start[c], s1 = grid.start[c + 1]
          const order = grid.order
          const bulkShadow = shadow !== null && shadowMode !== SHADOW_MIXED
          const bulkWant = shadowMode === SHADOW_ALL
          if (mode === MODE_NOT_DRAWN) {
            for (let i = s0; i < s1; i++) {
              const id = order[i]
              if (grid.cellOf[id] !== c) continue
              const rec = recs[id]
              walked++
              if (rec.tier !== NO_MESH_TIER || rec.viewCulled) placeInTier(id, rec, NO_MESH_TIER, false)
              if (bulkShadow && rec.shadowWanted !== bulkWant) applyShadowWanted(id, rec, bulkWant)
            }
          } else if (mode === MODE_UNIFORM) {
            for (let i = s0; i < s1; i++) {
              const id = order[i]
              if (grid.cellOf[id] !== c) continue
              const rec = recs[id]
              walked++
              if (rec.tier !== cellTier || rec.viewCulled) placeInTier(id, rec, cellTier, false)
              if (bulkShadow && rec.shadowWanted !== bulkWant) applyShadowWanted(id, rec, bulkWant)
            }
          } else {
            const cmask = grid.mask[c]
            for (let i = s0; i < s1; i++) {
              const id = order[i]
              if (grid.cellOf[id] !== c) continue
              const rec = recs[id]
              walked++
              const o = id * SPAN_STRIDE
              const dx = spans[o] - lodEyeX, dy = spans[o + 1] - lodEyeY, dz = spans[o + 2] - lodEyeZ
              const dsq = dx * dx + dy * dy + dz * dz
              const tier = tierFor(dsq)
              const shadowWanted = shadowDistSq >= 0 && dsq <= shadowDistSq
              if (shadow && shadowWanted !== rec.shadowWanted) applyShadowWanted(id, rec, shadowWanted)
              let culled = out
              if (!culled && tier !== NO_MESH_TIER && cmask !== 0) {
                const cx2 = spans[o + 3], cy2 = spans[o + 4], cz2 = spans[o + 5], nr = -spans[o + 6]
                for (let q = 0; q < 24; q += 4) {
                  if ((cmask & (1 << (q >> 2))) === 0) continue
                  planeTests++
                  if (planeBuf[q] * cx2 + planeBuf[q + 1] * cy2 + planeBuf[q + 2] * cz2 + planeBuf[q + 3] < nr) { culled = true; break }
                }
              }
              if (tier !== rec.tier || culled !== rec.viewCulled) placeInTier(id, rec, tier, culled)
            }
          }
          grid.mode[c] = mode
          grid.tier[c] = cellTier
          grid.shadowMode[c] = shadowMode
          grid.stamp[c] = now
          nextActive[nextCount++] = c
        }
      }
      sweepStats.cellsTested += nextCount
      sweepPendingInstances()
      const order = grid.order
      for (let k = 0; k < grid.activeCount; k++) {
        const c = grid.active[k]
        if (grid.stamp[c] === now) continue
        for (let i = grid.start[c], e = grid.start[c + 1]; i < e; i++) {
          const id = order[i]
          if (grid.cellOf[id] !== c) continue
          const rec = recs[id]
          walked++
          if (rec.tier !== NO_MESH_TIER || rec.viewCulled) placeInTier(id, rec, NO_MESH_TIER, false)
          if (shadow && rec.shadowWanted) applyShadowWanted(id, rec, false)
        }
        grid.mode[c] = MODE_NOT_DRAWN
        grid.tier[c] = NO_MESH_TIER
        grid.shadowMode[c] = SHADOW_NONE
      }
      grid.nextActive = grid.active
      grid.active = nextActive
      grid.activeCount = nextCount
    } else {
      for (let id = 0; id < recs.length; id++) {
        const rec = recs[id]
        if (rec === null) continue
        walked++
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
          for (let q = 0; q < 24; q += 4) { planeTests++; if (planeBuf[q] * bx + planeBuf[q + 1] * by + planeBuf[q + 2] * bz + planeBuf[q + 3] < nr) { culled = true; break } }
        }
        if (tier !== rec.tier || culled !== rec.viewCulled) placeInTier(id, rec, tier, culled)
      }
    }
    sweepStats.recordsWalked += walked
    sweepStats.planeTests += planeTests
  }

  const api = {
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
        enqueuePending(id)
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
      lodStale = true
      if (id < grid.cellOf.length) grid.cellOf[id] = -1
      grid.removedSinceBuild++
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
      invalidateCellOf(id)
      if (visible) show(id, rec); else hide(id, rec)
    },
    resizeBuffers() {},
    updateLOD,
    setMeshFarDistance(d) {
      if (!(d > 0)) throw new RangeError(`WebGPULodInstancer.setMeshFarDistance: distance must be positive, got ${d}`)
      meshFarSq = d * d
      meshFarDist = d
      lodStale = true
      if (grid.usable) grid.mode.fill(APPLIED_INVALID, 0, grid.cells)
    },
    get lodTierCount() { return tiers.length },
    get sweepStats() { return sweepStats },
    get tierIds() { return tiers.map(t => t.ids) },
    get sweepGrid() { return { usable: grid.usable, cells: grid.cells, instances: liveCount, reachCells: grid.activeCount, pending: grid.pendingCount, builtLive: grid.builtLive } },
    get shadowActiveCount() { return shadow ? shadow.size : 0 },
    get tierMeshes() { return tiers.map(t => t.mesh) },
    get shadowMesh() { return shadow ? shadow.mesh : null },
    dispose() { for (const p of pools) p.dispose(); recs.length = 0; liveFlags.fill(0); liveCount = 0; freeIds.length = 0; grid.dirty = true; grid.usable = false; grid.cells = 0; grid.pendingCount = 0; grid.removedSinceBuild = 0; grid.builtLive = 0 },
  }
  for (const p of pools) p.mesh.userData.lodInstancer = api
  return api
}
