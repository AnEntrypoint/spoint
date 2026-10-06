import { FIRE_DIR_COUNT, FIRE_DIR_DI, FIRE_DIR_DJ } from './fireLattice.js'

export const FIRE_STATE = Object.freeze({ UNBURNT: 0, BURNING: 1, BURNT: 2 })
export const FIRE_EVENT = Object.freeze({ IGNITE: 0, EXTINGUISH: 1, WIND: 2, MOISTURE: 3, RAIN: 4, IGNITE_AREA: 5 })

const UNBURNT = 0
const BURNING = 1
const BURNT = 2
const TILE_SHIFT = 3
export const TILE_AXIS_CELLS = 1 << TILE_SHIFT
const TILE_SIZE = TILE_AXIS_CELLS
const TILE_MASK = TILE_SIZE - 1
const TILE_CELLS = TILE_SIZE * TILE_SIZE
const TILE_CELL_SHIFT = 6
const HALF_TILE_CELLS = TILE_CELLS >> 1
const NBR_UNKNOWN = -2
const NBR_NONE = -1
export const FACE_FREE = 255
export const FACE_COUNT = 6
const MAX_U16 = 65535
const ORTHOGONAL_BASE_WEIGHT = 64
const DIAGONAL_BASE_WEIGHT = 40
const WIND_WEIGHT_GAIN = 24
const MIN_WEIGHT = 4
const MAX_WEIGHT = 255
const SPOT_MIN_CELLS = 2
const SPOT_SPAN_CELLS = 4
const COOL_SHIFT = 2
const MOISTURE_SHIFT = 7
const SCAR_RING_PAD = 64
const HASH_MASK = 0xffffff
const UNDO_CELLS_INIT = 4096
const UNDO_SCAR_WRITES_INIT = 1024
const UNDO_POOL_MAX = 12

function mix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

function cellHash(seed, step, face, I, J) {
  let h = (seed ^ Math.imul(step | 0, 0x9e3779b1)) | 0
  h ^= Math.imul(face + 1, 0x7feb352d); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  h ^= Math.imul(I | 0, 0x846ca68b); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  h ^= Math.imul(J | 0, 0xa5a35625); h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h & HASH_MASK
}

function sign(v) { return v > 0 ? 1 : v < 0 ? -1 : 0 }
function abs(v) { return v < 0 ? -v : v }

export function createFireKernel({ lattice, fuelClassAt, classes, seed = 1, stepTicks = 30, maxTiles = 4096, softActiveCells = 32768, maxActiveCells = 65536, regrowSteps = 1200, regrowFuelFraction = 1, interiorSkip = true, windAt = null, undo = true }) {
  if (!lattice || typeof lattice.walk !== 'function') throw new TypeError('[fireKernel] lattice is required')
  if (typeof fuelClassAt !== 'function') throw new TypeError('[fireKernel] fuelClassAt(face, I, J) is required')
  if (!Array.isArray(classes) || classes.length < 2 || classes.length > 255) throw new TypeError('[fireKernel] classes must list class 0 (non-flammable) plus at least one fuel class')
  if (!Number.isInteger(stepTicks) || stepTicks < 2) throw new RangeError(`[fireKernel] stepTicks must be an integer of at least 2, got ${stepTicks}`)
  if (!(maxActiveCells >= softActiveCells)) throw new RangeError('[fireKernel] maxActiveCells must be at least softActiveCells')

  const n = lattice.cellsPerFace
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`[fireKernel] the lattice must span a positive integer number of cells per face, got ${n}`)
  const tilesPerAxis = Math.ceil(n / TILE_SIZE)
  const partialLastTile = n % TILE_SIZE !== 0
  const cellCapacity = maxTiles * TILE_CELLS
  const classCount = classes.length
  const igniteHeat = new Uint16Array(classCount), burnRate = new Uint16Array(classCount), heatOut = new Uint16Array(classCount)
  const fuelInit = new Uint16Array(classCount), spotChance = new Uint16Array(classCount), spotHeat = new Uint16Array(classCount)
  const smokeOf = new Uint8Array(classCount), damageOf = new Uint16Array(classCount)
  for (let c = 0; c < classCount; c++) {
    const k = classes[c]
    igniteHeat[c] = k.igniteHeat ?? 0; burnRate[c] = k.burnRate ?? 0; heatOut[c] = k.heatOut ?? 0
    fuelInit[c] = k.fuel ?? 0; spotChance[c] = k.spotChance ?? 0; spotHeat[c] = k.spotHeat ?? 0
    smokeOf[c] = k.smoke ?? 0; damageOf[c] = k.damage ?? 0
  }

  const state = new Uint8Array(cellCapacity), cls = new Uint8Array(cellCapacity)
  const fuel = new Uint16Array(cellCapacity), heat = new Uint16Array(cellCapacity), timer = new Uint16Array(cellCapacity)
  const tileFace = new Uint8Array(maxTiles), tileI = new Int32Array(maxTiles), tileJ = new Int32Array(maxTiles)
  const tileNbr = new Int32Array(maxTiles * FIRE_DIR_COUNT).fill(NBR_UNKNOWN)
  const maskLo = new Uint32Array(maxTiles), maskHi = new Uint32Array(maxTiles), tileListed = new Uint8Array(maxTiles)
  const interiorLo = new Uint32Array(maxTiles), interiorHi = new Uint32Array(maxTiles)
  const tileSerial = new Float64Array(maxTiles)
  const freeTiles = new Int32Array(maxTiles)
  const reclaimQueue = new Int32Array(maxTiles)
  const reclaimMark = new Int32Array(maxTiles)
  let freeTop = 0, tileEpoch = 0, reclaimCount = 0, reclaimGen = 1
  let changeSerial = 1, tileGeneration = 0
  const activeTiles = new Int32Array(maxTiles)
  let tableSize = 1
  while (tableSize < maxTiles * 2) tableSize <<= 1
  const table = new Int32Array(tableSize)
  const scarRingSize = cellCapacity + SCAR_RING_PAD
  const scarRing = new Int32Array(scarRingSize), scarAt = new Int32Array(scarRingSize)
  const hashOfCell = new Uint32Array(cellCapacity)
  const dirtyCells = new Int32Array(cellCapacity)
  let dirtyCount = 0, hashCursor = 0, hashValid = true
  let hashSum = 0, hashXor = 0
  const undoMark = undo ? new Int32Array(cellCapacity) : null
  const undoPool = []
  let undoBuf = null
  let undoCount = 0, undoGen = 1
  let scarWriteCount = 0
  let stepStartedSinceDelta = false
  const preStep = {
    tileCount: 0, activeCount: 0, activeTileCount: 0, stepIndex: 0, stepStart: 0, nextStepTick: 0,
    phase: 0, cursor: 0, phaseEnd: 0, writePtr: 0, quota: 0, stepInterval: stepTicks,
    moisture: 0, rain: 0, wx: 0, wy: 0, wz: 0, eventSeq: 0, scarHead: 0, scarTail: 0, scarCount: 0,
    tileEpoch: 0,
  }
  let stepStartStats = null
  let stepOpen = false

  let tileCount = 0, activeCount = 0, activeTileCount = 0, scarHead = 0, scarTail = 0, scarCount = 0
  let stepStart = 0, stepIndex = 0, nextStepTick = 0, phase = 0, cursor = 0, phaseEnd = 0, writePtr = 0, quota = 0, stepInterval = stepTicks
  let moisture = 0, rain = 0
  const wind = new Int32Array(3)
  const faceWind = new Int32Array(lattice.faceCount * 2)
  const weights = new Int32Array(lattice.faceCount * FIRE_DIR_COUNT)
  const stats = { steps: 0, cellsVisited: 0, ignitions: 0, spots: 0, deniedActivations: 0, deniedTiles: 0, slowSteps: 0 }
  let pending = []
  let eventSeq = 0
  const walked = { face: 0, I: 0, J: 0 }
  const walkedWind = [0, 0]
  const dirIndex = new Int8Array(9)
  for (let d = 0; d < FIRE_DIR_COUNT; d++) dirIndex[(FIRE_DIR_DJ[d] + 1) * 3 + FIRE_DIR_DI[d] + 1] = d

  function rebuildWeights() {
    for (let f = 0; f < lattice.faceCount; f++) {
      lattice.windInFaceAxes(f, wind[0], wind[1], wind[2], walkedWind)
      faceWind[f * 2] = walkedWind[0]; faceWind[f * 2 + 1] = walkedWind[1]
      for (let d = 0; d < FIRE_DIR_COUNT; d++) {
        const di = FIRE_DIR_DI[d], dj = FIRE_DIR_DJ[d]
        const base = di !== 0 && dj !== 0 ? DIAGONAL_BASE_WEIGHT : ORTHOGONAL_BASE_WEIGHT
        const w = base + WIND_WEIGHT_GAIN * (walkedWind[0] * di + walkedWind[1] * dj)
        weights[f * FIRE_DIR_COUNT + d] = w < MIN_WEIGHT ? MIN_WEIGHT : w > MAX_WEIGHT ? MAX_WEIGHT : w
      }
    }
  }
  rebuildWeights()

  function tileHash(face, ti, tj) {
    return mix32(Math.imul(face + 1, 0x9e3779b1) ^ mix32(Math.imul(ti, 0x85ebca6b) ^ Math.imul(tj, 0xc2b2ae35))) & (tableSize - 1)
  }

  function findTile(face, ti, tj) {
    let slot = tileHash(face, ti, tj)
    for (;;) {
      const t = table[slot] - 1
      if (t < 0) return -1
      if (tileFace[t] === face && tileI[t] === ti && tileJ[t] === tj) return t
      slot = (slot + 1) & (tableSize - 1)
    }
  }

  function initTileCells(t, face, ti, tj) {
    const base = t << TILE_CELL_SHIFT
    const I0 = ti << TILE_SHIFT, J0 = tj << TILE_SHIFT
    for (let lj = 0; lj < TILE_SIZE; lj++) {
      for (let li = 0; li < TILE_SIZE; li++) {
        const g = base | (lj << TILE_SHIFT) | li
        const I = I0 + li, J = J0 + lj
        const c = I < n && J < n ? fuelClassAt(face, I, J) : 0
        cls[g] = c; fuel[g] = fuelInit[c]; state[g] = UNBURNT; heat[g] = 0; timer[g] = 0
        clearCellHash(g)
      }
    }
  }

  function noteTileCells(t) {
    const base = t << TILE_CELL_SHIFT
    for (let i = 0; i < TILE_CELLS; i++) noteCell(base + i)
  }

  function createTile(face, ti, tj) {
    let t = -1
    if (freeTop > 0) t = freeTiles[--freeTop]
    else if (tileCount < maxTiles) t = tileCount
    if (t < 0) { stats.deniedTiles++; return -1 }
    if (t >= tileCount) tileCount = t + 1
    tileEpoch++
    tileFace[t] = face; tileI[t] = ti; tileJ[t] = tj
    maskLo[t] = 0; maskHi[t] = 0; tileListed[t] = 0; interiorLo[t] = 0; interiorHi[t] = 0; tileSerial[t] = ++changeSerial
    tileNbr.fill(NBR_UNKNOWN, t * FIRE_DIR_COUNT, t * FIRE_DIR_COUNT + FIRE_DIR_COUNT)
    let slot = tileHash(face, ti, tj)
    while (table[slot] !== 0) slot = (slot + 1) & (tableSize - 1)
    table[slot] = t + 1
    if (undoMark !== null) noteTileCells(t)
    initTileCells(t, face, ti, tj)
    noteReclaim(t)
    return t
  }

  function tileOf(face, ti, tj) {
    const t = findTile(face, ti, tj)
    return t >= 0 ? t : createTile(face, ti, tj)
  }

  function cellAt(face, I, J) {
    const t = tileOf(face, I >> TILE_SHIFT, J >> TILE_SHIFT)
    return t < 0 ? -1 : (t << TILE_CELL_SHIFT) | ((J & TILE_MASK) << TILE_SHIFT) | (I & TILE_MASK)
  }

  function peekCell(face, I, J) {
    const t = findTile(face, I >> TILE_SHIFT, J >> TILE_SHIFT)
    return t < 0 ? -1 : (t << TILE_CELL_SHIFT) | ((J & TILE_MASK) << TILE_SHIFT) | (I & TILE_MASK)
  }

  function neighbourTile(t, dx, dy) {
    const idx = t * FIRE_DIR_COUNT + dirIndex[(dy + 1) * 3 + dx + 1]
    let nt = tileNbr[idx]
    if (nt === NBR_UNKNOWN) {
      const ti = tileI[t] + dx, tj = tileJ[t] + dy
      nt = (ti < 0 || tj < 0 || ti >= tilesPerAxis || tj >= tilesPerAxis) ? NBR_NONE : tileOf(tileFace[t], ti, tj)
      if (nt >= 0) tileNbr[idx] = nt
    }
    return nt
  }

  function isActive(g) {
    const bit = g & (TILE_CELLS - 1), t = g >> TILE_CELL_SHIFT
    return bit < HALF_TILE_CELLS ? (maskLo[t] & (1 << bit)) !== 0 : (maskHi[t] & (1 << (bit - HALF_TILE_CELLS))) !== 0
  }

  function setActive(g) {
    const bit = g & (TILE_CELLS - 1), t = g >> TILE_CELL_SHIFT
    if (bit < HALF_TILE_CELLS) maskLo[t] |= 1 << bit; else maskHi[t] |= 1 << (bit - HALF_TILE_CELLS)
    activeCount++
    if (tileListed[t] === 0) { tileListed[t] = 1; activeTiles[activeTileCount++] = t }
  }

  function activate(g) {
    if (isActive(g)) return true
    if (activeCount >= maxActiveCells) { stats.deniedActivations++; return false }
    setActive(g)
    return true
  }

  function hashCellValue(g) {
    const t = g >> TILE_CELL_SHIFT, i = g & (TILE_CELLS - 1)
    const face = tileFace[t], I0 = tileI[t] << TILE_SHIFT, J0 = tileJ[t] << TILE_SHIFT
    const li = i & TILE_MASK, lj = i >> TILE_SHIFT
    let h = mix32(Math.imul(face + 1, 0x9e3779b1) ^ Math.imul(I0 + li, 0x85ebca6b) ^ Math.imul(J0 + lj, 0xc2b2ae35))
    h = mix32(h ^ (state[g] | (fuel[g] << 8)))
    return mix32(h ^ (heat[g] | (timer[g] << 16)))
  }

  function hashIsQuiet(g) { return state[g] === UNBURNT && heat[g] === 0 && timer[g] === 0 && fuel[g] === fuelInit[cls[g]] }

  function refreshCell(g) {
    const h = hashIsQuiet(g) ? 0 : hashCellValue(g)
    const old = hashOfCell[g]
    if (h === old) return
    hashSum = (hashSum - old + h) | 0
    hashXor = (hashXor ^ old ^ h) >>> 0
    hashOfCell[g] = h
  }

  function clearCellHash(g) {
    const h = hashOfCell[g]
    if (h === 0) return
    hashSum = (hashSum - h) | 0
    hashXor = (hashXor ^ h) >>> 0
    hashOfCell[g] = 0
  }

  function noteCell(g) {
    if (dirtyCount < cellCapacity) dirtyCells[dirtyCount++] = g
    else hashValid = false
    if (!undo || undoMark === null) return
    if (undoMark[g] === undoGen) return
    if (undoCount === undoBuf.cells.length && !growDelta(undoBuf, undoCount + 1, undoCount)) return
    undoMark[g] = undoGen
    const k = undoCount++
    undoBuf.cells[k] = g
    undoBuf.state[k] = state[g]
    undoBuf.fuel[k] = fuel[g]
    undoBuf.heat[k] = heat[g]
    undoBuf.timer[k] = timer[g]
  }

  function flushHash() {
    const cells = tileCount << TILE_CELL_SHIFT
    for (let i = hashCursor; i < dirtyCount; i++) {
      const g = dirtyCells[i]
      if (g < cells) refreshCell(g)
    }
    dirtyCount = 0; hashCursor = 0
  }

  function rebuildHash() {
    let sum = 0, mixed = 0
    const cells = tileCount << TILE_CELL_SHIFT
    for (let g = 0; g < cells; g++) {
      let h = 0
      if (!hashIsQuiet(g)) {
        h = hashCellValue(g)
        sum = (sum + h) | 0
        mixed ^= h
      }
      hashOfCell[g] = h
    }
    hashSum = sum; hashXor = mixed >>> 0
    dirtyCount = 0; hashCursor = 0; hashValid = true
  }

  const NO_PENDING = Object.freeze([])
  function newDelta(cellCap) {
    return {
      cells: new Int32Array(cellCap), state: new Uint8Array(cellCap), fuel: new Uint16Array(cellCap),
      heat: new Uint16Array(cellCap), timer: new Uint16Array(cellCap),
      maskLo: new Uint32Array(maxTiles), maskHi: new Uint32Array(maxTiles), listed: new Uint8Array(maxTiles),
      interiorLo: new Uint32Array(maxTiles), interiorHi: new Uint32Array(maxTiles),
      activeTiles: new Int32Array(maxTiles),
      scarSlot: new Int32Array(UNDO_SCAR_WRITES_INIT), scarPrevCell: new Int32Array(UNDO_SCAR_WRITES_INIT), scarPrevStep: new Int32Array(UNDO_SCAR_WRITES_INIT),
      face: new Uint8Array(maxTiles), tileI: new Int32Array(maxTiles), tileJ: new Int32Array(maxTiles),
      count: 0, scarWrites: 0, tileCount: 0, activeCount: 0, activeTileCount: 0, tileEpoch: 0,
      stepIndex: 0, stepStart: 0, nextStepTick: 0, phase: 0, cursor: 0, phaseEnd: 0, writePtr: 0, quota: 0,
      stepInterval: stepTicks, moisture: 0, rain: 0, wx: 0, wy: 0, wz: 0, eventSeq: 0,
      scarHead: 0, scarTail: 0, scarCount: 0, stats: null, pending: [],
    }
  }

  function growDelta(d, need, staged) {
    let cap = d.cells.length
    if (cap >= cellCapacity) return false
    while (cap < need) cap = cap * 2 > cellCapacity ? cellCapacity : cap * 2
    const cells = new Int32Array(cap); cells.set(d.cells.subarray(0, staged)); d.cells = cells
    const st = new Uint8Array(cap); st.set(d.state.subarray(0, staged)); d.state = st
    const fu = new Uint16Array(cap); fu.set(d.fuel.subarray(0, staged)); d.fuel = fu
    const he = new Uint16Array(cap); he.set(d.heat.subarray(0, staged)); d.heat = he
    const ti = new Uint16Array(cap); ti.set(d.timer.subarray(0, staged)); d.timer = ti
    return true
  }

  function growScarWrites(d, need, staged) {
    let cap = d.scarSlot.length
    if (cap >= scarRingSize) return false
    while (cap < need) cap = cap * 2 > scarRingSize ? scarRingSize : cap * 2
    const slot = new Int32Array(cap); slot.set(d.scarSlot.subarray(0, staged)); d.scarSlot = slot
    const cell = new Int32Array(cap); cell.set(d.scarPrevCell.subarray(0, staged)); d.scarPrevCell = cell
    const step = new Int32Array(cap); step.set(d.scarPrevStep.subarray(0, staged)); d.scarPrevStep = step
    return true
  }

  function noteScarWrite(slot) {
    const d = undoBuf
    if (scarWriteCount === d.scarSlot.length && !growScarWrites(d, scarWriteCount + 1, scarWriteCount)) return
    const k = scarWriteCount++
    d.scarSlot[k] = slot
    d.scarPrevCell[k] = scarRing[slot]
    d.scarPrevStep[k] = scarAt[slot]
  }

  function captureStructure() {
    undoBuf.maskLo.set(maskLo.subarray(0, tileCount))
    undoBuf.maskHi.set(maskHi.subarray(0, tileCount))
    undoBuf.listed.set(tileListed.subarray(0, tileCount))
    undoBuf.interiorLo.set(interiorLo.subarray(0, tileCount))
    undoBuf.interiorHi.set(interiorHi.subarray(0, tileCount))
    undoBuf.activeTiles.set(activeTiles.subarray(0, activeTileCount))
    undoBuf.face.set(tileFace.subarray(0, tileCount))
    undoBuf.tileI.set(tileI.subarray(0, tileCount))
    undoBuf.tileJ.set(tileJ.subarray(0, tileCount))
  }

  function capturePreStep() {
    const s = preStep
    s.tileCount = tileCount
    s.activeCount = activeCount
    s.activeTileCount = activeTileCount
    s.stepIndex = stepIndex
    s.stepStart = stepStart
    s.nextStepTick = nextStepTick
    s.phase = phase
    s.cursor = cursor
    s.phaseEnd = phaseEnd
    s.writePtr = writePtr
    s.quota = quota
    s.stepInterval = stepInterval
    s.moisture = moisture
    s.rain = rain
    s.wx = wind[0]; s.wy = wind[1]; s.wz = wind[2]
    s.eventSeq = eventSeq
    s.scarHead = scarHead
    s.scarTail = scarTail
    s.scarCount = scarCount
    s.tileEpoch = tileEpoch
    stepStartStats = { ...stats }
    if (undoMark !== null) captureStructure()
  }

  function markStepStart() {
    capturePreStep()
    stepOpen = true
    stepStartedSinceDelta = true
  }

  function takeDelta() {
    if (undoBuf === null) throw new TypeError('[fireKernel] takeDelta needs a kernel created with undo: true')
    const d = undoBuf
    if (!stepStartedSinceDelta) capturePreStep()
    const s = preStep
    d.count = undoCount
    d.scarWrites = scarWriteCount
    d.tileCount = s.tileCount
    d.activeCount = s.activeCount
    d.activeTileCount = s.activeTileCount
    d.stepIndex = s.stepIndex; d.stepStart = s.stepStart; d.nextStepTick = s.nextStepTick
    d.phase = s.phase; d.cursor = s.cursor; d.phaseEnd = s.phaseEnd; d.writePtr = s.writePtr; d.quota = s.quota
    d.stepInterval = s.stepInterval; d.moisture = s.moisture; d.rain = s.rain
    d.wx = s.wx; d.wy = s.wy; d.wz = s.wz; d.eventSeq = s.eventSeq
    d.scarHead = s.scarHead; d.scarTail = s.scarTail; d.scarCount = s.scarCount
    d.tileEpoch = s.tileEpoch
    d.stats = stepStartStats === null ? { ...stats } : stepStartStats
    d.pending = pending.length === 0 ? NO_PENDING : pending.map(e => ({ ...e }))
    undoBuf = undoPool.length > 0 ? undoPool.pop() : newDelta(UNDO_CELLS_INIT)
    undoCount = 0; scarWriteCount = 0; undoGen++; stepStartedSinceDelta = false
    return d
  }

  function releaseDelta(d) { if (undoPool.length < UNDO_POOL_MAX) undoPool.push(d) }

  function undoOpenStep() {
    if (!stepOpen) return false
    const d = takeDelta()
    undoDelta(d)
    releaseDelta(d)
    stepOpen = false
    return true
  }

  function markRestored(events) {
    pending = events === undefined ? [] : events.map(e => ({ ...e }))
    stepOpen = false
    tileNbr.fill(NBR_UNKNOWN)
    if (undoMark !== null) capturePreStep()
  }

  if (undoMark !== null) undoBuf = newDelta(UNDO_CELLS_INIT)

  function undoDelta(d) {
    if (d.tileCount !== tileCount) {
      const from = (d.tileCount < tileCount ? d.tileCount : tileCount) << TILE_CELL_SHIFT
      const to = (d.tileCount < tileCount ? tileCount : d.tileCount) << TILE_CELL_SHIFT
      for (let g = from; g < to; g++) {
        const h = hashOfCell[g]
        if (h === 0) continue
        hashSum = (hashSum - h) | 0
        hashXor = (hashXor ^ h) >>> 0
        hashOfCell[g] = 0
      }
      tileCount = d.tileCount
      let queued = 0
      for (let i = 0; i < reclaimCount; i++) {
        const q = reclaimQueue[i]
        if (q < tileCount) reclaimQueue[queued++] = q
      }
      reclaimCount = queued
    }
    if (d.tileEpoch !== tileEpoch) {
      tileEpoch = d.tileEpoch
      restoreTileStructure(d)
    }
    const liveCells = tileCount << TILE_CELL_SHIFT
    for (let k = 0; k < d.count; k++) {
      const g = d.cells[k]
      if (g >= liveCells) { clearCellHash(g); continue }
      state[g] = d.state[k]; fuel[g] = d.fuel[k]; heat[g] = d.heat[k]; timer[g] = d.timer[k]
      refreshCell(g)
    }
    maskLo.set(d.maskLo.subarray(0, tileCount))
    maskHi.set(d.maskHi.subarray(0, tileCount))
    tileListed.set(d.listed.subarray(0, tileCount))
    interiorLo.set(d.interiorLo.subarray(0, tileCount)); interiorHi.set(d.interiorHi.subarray(0, tileCount))
    activeTiles.set(d.activeTiles.subarray(0, d.activeTileCount))
    activeCount = d.activeCount; activeTileCount = d.activeTileCount
    stepIndex = d.stepIndex; stepStart = d.stepStart; nextStepTick = d.nextStepTick
    phase = d.phase; cursor = d.cursor; phaseEnd = d.phaseEnd; writePtr = d.writePtr; quota = d.quota
    stepInterval = d.stepInterval; moisture = d.moisture; rain = d.rain
    wind[0] = d.wx; wind[1] = d.wy; wind[2] = d.wz; rebuildWeights()
    eventSeq = d.eventSeq
    for (let k = d.scarWrites - 1; k >= 0; k--) {
      const slot = d.scarSlot[k]
      scarRing[slot] = d.scarPrevCell[k]
      scarAt[slot] = d.scarPrevStep[k]
    }
    scarHead = d.scarHead; scarTail = d.scarTail; scarCount = d.scarCount
    Object.assign(stats, d.stats)
    pending = d.pending.map(e => ({ ...e }))
    undoCount = 0; scarWriteCount = 0; undoGen++
    changeSerial++; tileGeneration++
  }

  function addHeat(g, amount) {
    noteCell(g)
    const v = heat[g] + amount
    heat[g] = v > MAX_U16 ? MAX_U16 : v
  }

  function pushHeatTo(face, I, J, amount) {
    const g = cellAt(face, I, J)
    if (g < 0 || cls[g] === 0 || state[g] !== UNBURNT) return
    if (!activate(g)) return
    addHeat(g, amount)
  }

  function touchTile(g) { tileSerial[g >> TILE_CELL_SHIFT] = ++changeSerial }

  function ignite(face, I, J) {
    const g = cellAt(face, I, J)
    if (g < 0 || cls[g] === 0 || state[g] !== UNBURNT || fuel[g] === 0) return false
    if (!activate(g)) return false
    noteCell(g)
    state[g] = BURNING
    heat[g] = heatOut[cls[g]]
    timer[g] = stepIndex & MAX_U16
    touchTile(g)
    stats.ignitions++
    return true
  }

  function igniteArea(face, I, J, radius) {
    for (let dj = -radius; dj <= radius; dj++) {
      for (let di = -radius; di <= radius; di++) {
        if (di * di + dj * dj > radius * radius) continue
        lattice.walk(face, I, J, di, dj, walked)
        ignite(walked.face, walked.I, walked.J)
      }
    }
  }

  function extinguish(face, I, J, radius) {
    let count = 0
    for (let dj = -radius; dj <= radius; dj++) {
      for (let di = -radius; di <= radius; di++) {
        lattice.walk(face, I, J, di, dj, walked)
        const g = peekCell(walked.face, walked.I, walked.J)
        if (g < 0) continue
        if (state[g] === BURNING) { noteCell(g); fuel[g] = 0; count++ }
        else if (state[g] === UNBURNT) { noteCell(g); heat[g] = heat[g] >> 2 }
      }
    }
    return count
  }

  function scarPush(g, atStep) {
    if (scarCount >= scarRingSize) return
    if (undoMark !== null) noteScarWrite(scarTail)
    scarRing[scarTail] = g; scarAt[scarTail] = atStep
    scarTail = scarTail + 1 === scarRingSize ? 0 : scarTail + 1
    scarCount++
  }

  function clearInteriorAround(g) {
    const t = g >> TILE_CELL_SHIFT
    interiorLo[t] = 0; interiorHi[t] = 0
    const face = tileFace[t], ti = tileI[t], tj = tileJ[t]
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const ni = ti + dx, nj = tj + dy
        if (ni < 0 || nj < 0 || ni >= tilesPerAxis || nj >= tilesPerAxis) { interiorLo.fill(0, 0, tileCount); interiorHi.fill(0, 0, tileCount); return }
        const nt = findTile(face, ni, nj)
        if (nt >= 0) { interiorLo[nt] = 0; interiorHi[nt] = 0 }
      }
    }
  }

  function regrow() {
    while (scarCount > 0 && scarAt[scarHead] <= stepIndex) {
      const g = scarRing[scarHead]
      scarHead = scarHead + 1 === scarRingSize ? 0 : scarHead + 1
      scarCount--
      noteCell(g)
      state[g] = UNBURNT; heat[g] = 0; timer[g] = 0
      fuel[g] = Math.floor(fuelInit[cls[g]] * regrowFuelFraction)
      touchTile(g)
      clearInteriorAround(g)
      noteReclaim(g >> TILE_CELL_SHIFT)
    }
  }

  function applyEvent(ev) {
    switch (ev.kind) {
      case FIRE_EVENT.IGNITE: ignite(ev.face, ev.I, ev.J); break
      case FIRE_EVENT.EXTINGUISH: extinguish(ev.face, ev.I, ev.J, ev.radius); break
      case FIRE_EVENT.WIND: wind[0] = ev.wx; wind[1] = ev.wy; wind[2] = ev.wz; rebuildWeights(); break
      case FIRE_EVENT.MOISTURE: moisture = ev.value; break
      case FIRE_EVENT.RAIN: rain = ev.value; break
      case FIRE_EVENT.IGNITE_AREA: igniteArea(ev.face, ev.I, ev.J, ev.radius); break
    }
  }

  function queueEvent(ev) {
    if (ev.id === undefined) ev.id = eventSeq
    eventSeq = Math.max(eventSeq, ev.id + 1)
    let i = pending.length
    pending.push(ev)
    while (i > 0 && (pending[i - 1].tick > ev.tick || (pending[i - 1].tick === ev.tick && pending[i - 1].id > ev.id))) { pending[i] = pending[i - 1]; i-- }
    pending[i] = ev
  }

  function beginStep(tickNumber) {
    let consumed = 0
    while (consumed < pending.length && pending[consumed].tick <= tickNumber) applyEvent(pending[consumed++])
    if (consumed > 0) pending = pending.slice(consumed)
    stepIndex++
    if (windAt !== null) { windAt(stepIndex, wind); rebuildWeights() }
    stats.steps++
    const slow = activeCount > softActiveCells
    stepInterval = slow ? stepTicks * 2 : stepTicks
    if (slow) stats.slowSteps++
    stepStart = tickNumber
    nextStepTick = tickNumber + stepInterval
    regrow()
    phase = 1; cursor = 0; phaseEnd = activeTileCount
    quota = Math.ceil(phaseEnd / (stepInterval >> 1)) + 1
  }

  function markInterior(g) {
    const bit = g & (TILE_CELLS - 1), t = g >> TILE_CELL_SHIFT
    if (bit < HALF_TILE_CELLS) interiorLo[t] |= 1 << bit; else interiorHi[t] |= 1 << (bit - HALF_TILE_CELLS)
  }

  function isInterior(g) {
    const bit = g & (TILE_CELLS - 1), t = g >> TILE_CELL_SHIFT
    return bit < HALF_TILE_CELLS ? (interiorLo[t] & (1 << bit)) !== 0 : (interiorHi[t] & (1 << (bit - HALF_TILE_CELLS))) !== 0
  }

  function pushFrom(g) {
    const t = g >> TILE_CELL_SHIFT, li = g & TILE_MASK, lj = (g >> TILE_SHIFT) & TILE_MASK
    const face = tileFace[t]
    const gI = (tileI[t] << TILE_SHIFT) + li, gJ = (tileJ[t] << TILE_SHIFT) + lj
    const c = cls[g]
    const out = heatOut[c]
    const wBase = face * FIRE_DIR_COUNT
    let open = false
    for (let d = 0; d < FIRE_DIR_COUNT; d++) {
      const di = FIRE_DIR_DI[d], dj = FIRE_DIR_DJ[d]
      const ni = li + di, nj = lj + dj
      let ng
      if (ni >= 0 && ni < TILE_SIZE && nj >= 0 && nj < TILE_SIZE && !(partialLastTile && (gI + di >= n || gJ + dj >= n))) ng = (t << TILE_CELL_SHIFT) | (nj << TILE_SHIFT) | ni
      else {
        const nI = gI + di, nJ = gJ + dj
        if (nI < 0 || nI >= n || nJ < 0 || nJ >= n) {
          lattice.walk(face, gI, gJ, di, dj, walked)
          pushHeatTo(walked.face, walked.I, walked.J, (out * weights[wBase + d]) >> 8)
          open = true
          continue
        }
        const dx = ni < 0 ? -1 : ni >= TILE_SIZE ? 1 : 0, dy = nj < 0 ? -1 : nj >= TILE_SIZE ? 1 : 0
        const nt = neighbourTile(t, dx, dy)
        if (nt < 0) { open = true; continue }
        ng = (nt << TILE_CELL_SHIFT) | ((nj & TILE_MASK) << TILE_SHIFT) | (ni & TILE_MASK)
      }
      if (cls[ng] === 0 || state[ng] !== UNBURNT) continue
      open = true
      if (!activate(ng)) continue
      addHeat(ng, (out * weights[wBase + d]) >> 8)
    }
    if (!open && interiorSkip) markInterior(g)
    if (spotChance[c] !== 0) pushSpot(g)
  }

  function pushSpot(g) {
    const t = g >> TILE_CELL_SHIFT
    const face = tileFace[t]
    const wu = faceWind[face * 2], wv = faceWind[face * 2 + 1]
    if (wu === 0 && wv === 0) return
    const gI = (tileI[t] << TILE_SHIFT) + (g & TILE_MASK), gJ = (tileJ[t] << TILE_SHIFT) + ((g >> TILE_SHIFT) & TILE_MASK)
    const c = cls[g]
    const h = cellHash(seed, stepIndex, face, gI, gJ)
    if ((h & 0xffff) >= spotChance[c] * (abs(wu) + abs(wv))) return
    const dist = SPOT_MIN_CELLS + ((h >>> 16) & (SPOT_SPAN_CELLS - 1))
    const lateral = ((h >>> 20) & 3) - 1
    const ox = (abs(wu) * 2 >= abs(wv)) ? sign(wu) * dist : lateral
    const oy = (abs(wv) * 2 >= abs(wu)) ? sign(wv) * dist : lateral
    lattice.walk(face, gI, gJ, ox, oy, walked)
    pushHeatTo(walked.face, walked.I, walked.J, spotHeat[c])
    stats.spots++
  }

  function burnCell(g) {
    const c = cls[g]
    const f = fuel[g]
    noteCell(g)
    fuel[g] = f > burnRate[c] ? f - burnRate[c] : 0
    if (rain !== 0) {
      const t = g >> TILE_CELL_SHIFT
      const h = cellHash(seed, stepIndex, tileFace[t], (tileI[t] << TILE_SHIFT) + (g & TILE_MASK), (tileJ[t] << TILE_SHIFT) + ((g >> TILE_SHIFT) & TILE_MASK))
      if ((h & 255) < rain) { fuel[g] = 0; noteCell(g); return }
    }
    if (isInterior(g)) { if (spotChance[c] !== 0) pushSpot(g) } else pushFrom(g)
  }

  function phaseOneMask(base, masks, t) {
    let mask = masks[t]
    while (mask !== 0) {
      const low = mask & -mask
      mask ^= low
      const g = base + (31 - Math.clz32(low))
      if (state[g] === BURNING) burnCell(g)
    }
  }

  function phaseOne(limit) {
    let done = 0
    while (cursor < phaseEnd && done < limit) {
      const t = activeTiles[cursor++]
      done++
      const base = t << TILE_CELL_SHIFT
      phaseOneMask(base, maskLo, t)
      phaseOneMask(base + HALF_TILE_CELLS, maskHi, t)
    }
    stats.cellsVisited += done
  }

  function beginPhaseTwo() {
    phase = 2; cursor = 0; phaseEnd = activeTileCount; writePtr = 0
    quota = Math.ceil(phaseEnd / (stepInterval - (stepInterval >> 1))) + 1
  }

  function settleMask(base, masks, t) {
    let mask = masks[t]
    let keep = mask
    while (mask !== 0) {
      const low = mask & -mask
      mask ^= low
      const g = base + (31 - Math.clz32(low))
      if (state[g] === BURNING) {
        if (fuel[g] === 0) {
          noteCell(g)
          state[g] = BURNT; heat[g] = 0; keep ^= low; activeCount--
          timer[g] = stepIndex & MAX_U16
          touchTile(g)
          scarPush(g, stepIndex + regrowSteps)
        }
        continue
      }
      const c = cls[g]
      const wet = timer[g]
      if (wet !== 0) { noteCell(g); timer[g] = wet - 1 }
      const thr = igniteHeat[c] + ((igniteHeat[c] * moisture) >> MOISTURE_SHIFT)
      if (heat[g] >= thr && wet === 0 && fuel[g] !== 0 && c !== 0) { noteCell(g); state[g] = BURNING; heat[g] = heatOut[c]; timer[g] = stepIndex & MAX_U16; touchTile(g); stats.ignitions++; continue }
      const hv = heat[g]
      const next = hv - ((hv >> COOL_SHIFT) + (hv !== 0 ? 1 : 0))
      noteCell(g)
      heat[g] = next
      if (next === 0 && timer[g] === 0) { keep ^= low; activeCount-- }
    }
    masks[t] = keep
  }

  function phaseTwo(limit) {
    let done = 0
    while (cursor < phaseEnd && done < limit) {
      const t = activeTiles[cursor++]
      done++
      const base = t << TILE_CELL_SHIFT
      settleMask(base, maskLo, t)
      settleMask(base + HALF_TILE_CELLS, maskHi, t)
      if (maskLo[t] === 0 && maskHi[t] === 0) { tileListed[t] = 0; noteReclaim(t) }
      else activeTiles[writePtr++] = t
    }
    stats.cellsVisited += done
    if (cursor >= phaseEnd) {
      for (let i = cursor; i < activeTileCount; i++) activeTiles[writePtr++] = activeTiles[i]
      activeTileCount = writePtr
      phase = 0
      sweepReclaim()
      if (activeCount === 0 && scarCount === 0) reclaimIdle()
    }
  }

  function noteReclaim(t) {
    if (reclaimMark[t] === reclaimGen) return
    reclaimMark[t] = reclaimGen
    reclaimQueue[reclaimCount++] = t
  }

  function sweepReclaim() {
    for (let i = 0; i < reclaimCount; i++) tryReclaim(reclaimQueue[i])
    reclaimCount = 0
    reclaimGen++
  }

  function tryReclaim(t) {
    if (t >= tileCount || tileFace[t] === FACE_FREE || tileListed[t] !== 0 || maskLo[t] !== 0 || maskHi[t] !== 0) return false
    const base = t << TILE_CELL_SHIFT
    for (let i = 0; i < TILE_CELLS; i++) {
      const g = base + i
      if (state[g] !== UNBURNT || heat[g] !== 0 || timer[g] !== 0 || fuel[g] !== fuelInit[cls[g]]) return false
    }
    releaseTile(t)
    return true
  }

  function releaseTile(t) {
    let slot = tileHash(tileFace[t], tileI[t], tileJ[t])
    let probes = 0
    while (table[slot] !== t + 1) {
      slot = (slot + 1) & (tableSize - 1)
      if (++probes >= tableSize) throw new RangeError(`[fireKernel] releaseTile(${t}) at face ${tileFace[t]} tile ${tileI[t]},${tileJ[t]} holds no entry in the tile table; the reclaim queue carried a tile index the kernel no longer holds`)
    }
    table[slot] = 0
    let scan = (slot + 1) & (tableSize - 1)
    while (table[scan] !== 0) {
      const u = table[scan] - 1
      table[scan] = 0
      let h = tileHash(tileFace[u], tileI[u], tileJ[u])
      while (table[h] !== 0) h = (h + 1) & (tableSize - 1)
      table[h] = u + 1
      scan = (scan + 1) & (tableSize - 1)
    }
    for (let d = 0; d < FIRE_DIR_COUNT; d++) {
      const idx = t * FIRE_DIR_COUNT + d
      const nt = tileNbr[idx]
      tileNbr[idx] = NBR_UNKNOWN
      if (nt < 0) continue
      const back = nt * FIRE_DIR_COUNT + dirIndex[(1 - FIRE_DIR_DJ[d]) * 3 + 1 - FIRE_DIR_DI[d]]
      if (tileNbr[back] === t) tileNbr[back] = NBR_UNKNOWN
    }
    tileFace[t] = FACE_FREE
    tileSerial[t] = ++changeSerial
    tileListed[t] = 0
    tileEpoch++
    tileGeneration++
    let high = tileCount
    while (high > 0 && tileFace[high - 1] === FACE_FREE) high--
    if (high !== tileCount) {
      tileCount = high
      let kept = 0
      for (let i = 0; i < freeTop; i++) { const s = freeTiles[i]; if (s < high) freeTiles[kept++] = s }
      freeTop = kept
    }
    if (t < high) freeTiles[freeTop++] = t
  }

  function quietTile(t) {
    const base = t << TILE_CELL_SHIFT
    for (let i = 0; i < TILE_CELLS; i++) {
      const g = base + i
      clearCellHash(g)
      state[g] = UNBURNT; heat[g] = 0; timer[g] = 0; fuel[g] = fuelInit[cls[g]]
    }
  }

  function restoreTileStructure(d) {
    const count = d.tileCount
    for (let t = 0; t < count; t++) {
      const free = d.face[t] === FACE_FREE
      const wasFree = tileFace[t] === FACE_FREE
      if (free) {
        if (!wasFree) quietTile(t)
        continue
      }
      if (wasFree || d.face[t] !== tileFace[t] || d.tileI[t] !== tileI[t] || d.tileJ[t] !== tileJ[t]) initTileCells(t, d.face[t], d.tileI[t], d.tileJ[t])
    }
    tileFace.set(d.face.subarray(0, count))
    tileI.set(d.tileI.subarray(0, count))
    tileJ.set(d.tileJ.subarray(0, count))
    rebuildTileIndex()
  }

  function rebuildTileIndex() {
    freeTop = 0
    table.fill(0)
    tileNbr.fill(NBR_UNKNOWN)
    for (let t = 0; t < tileCount; t++) {
      if (tileFace[t] === FACE_FREE) { freeTiles[freeTop++] = t; continue }
      let slot = tileHash(tileFace[t], tileI[t], tileJ[t])
      while (table[slot] !== 0) slot = (slot + 1) & (tableSize - 1)
      table[slot] = t + 1
    }
  }

  function reclaimIdle() {
    for (let t = 0; t < tileCount; t++) {
      if (tileFace[t] === FACE_FREE) continue
      const base = t << TILE_CELL_SHIFT
      for (let i = 0; i < TILE_CELLS; i++) {
        const g = base + i
        if (state[g] !== UNBURNT || heat[g] !== 0 || timer[g] !== 0 || fuel[g] !== fuelInit[cls[g]]) return
      }
    }
    hashOfCell.fill(0, 0, tileCount << TILE_CELL_SHIFT)
    dirtyCount = 0; hashCursor = 0; hashValid = true; hashSum = 0; hashXor = 0
    reclaimCount = 0; reclaimGen++
    tileFace.fill(FACE_FREE)
    table.fill(0); tileNbr.fill(NBR_UNKNOWN); tileCount = 0; activeTileCount = 0; tileGeneration++; changeSerial++
    freeTop = 0; tileEpoch++; reclaimCount = 0; reclaimGen++
  }

  function skipQuietStep(tickNumber) {
    if (activeCount !== 0 || scarCount !== 0 || (pending.length !== 0 && pending[0].tick <= tickNumber)) return false
    sweepReclaim()
    if (activeCount === 0 && scarCount === 0) reclaimIdle()
    nextStepTick = tickNumber + stepTicks
    return true
  }

  function tick(tickNumber) {
    if (phase === 0) {
      if (tickNumber < nextStepTick || tickNumber % stepTicks !== 0 || skipQuietStep(tickNumber)) return
      markStepStart()
      beginStep(tickNumber)
    }
    const offset = tickNumber - stepStart
    const half = stepInterval >> 1
    if (phase === 1) {
      phaseOne(offset >= half - 1 ? Infinity : quota)
      if (offset >= half) beginPhaseTwo()
    }
    if (phase === 2) phaseTwo(offset >= stepInterval - 1 ? Infinity : quota)
  }

  function runStepUnsliced(tickNumber) {
    if (skipQuietStep(tickNumber)) return
    markStepStart()
    beginStep(tickNumber)
    phaseOne(Infinity)
    beginPhaseTwo()
    phaseTwo(Infinity)
  }

  function checksum() {
    if (hashValid) flushHash(); else rebuildHash()
    const sum = hashSum, mixed = hashXor
    let h = mix32(sum ^ Math.imul(mixed, 0x27d4eb2f))
    h = mix32(h ^ stepIndex); h = mix32(h ^ (moisture | (rain << 8))); h = mix32(h ^ wind[0] ^ (wind[1] << 8) ^ (wind[2] << 16))
    h = mix32(h ^ Math.imul(activeCount, 0x165667b1)); h = mix32(h ^ Math.imul(scarCount, 0x9e3779b1))
    return h >>> 0
  }

  function snapshot() {
    const cells = tileCount << TILE_CELL_SHIFT
    const scar = new Int32Array(scarCount * 2)
    for (let i = 0, p = scarHead; i < scarCount; i++, p = p + 1 === scarRingSize ? 0 : p + 1) { scar[i * 2] = scarRing[p]; scar[i * 2 + 1] = scarAt[p] }
    return {
      cellsPerFace: n,
      tileCount, activeCount, activeTileCount, scarCount, stepStart, stepIndex, nextStepTick, phase, cursor, phaseEnd, writePtr, quota, stepInterval, moisture, rain, eventSeq,
      wind: wind.slice(), pending: pending.map(e => ({ ...e })), stats: { ...stats },
      classFuel: fuelInit.slice(),
      state: state.slice(0, cells), cls: cls.slice(0, cells), fuel: fuel.slice(0, cells), heat: heat.slice(0, cells), timer: timer.slice(0, cells),
      tileFace: tileFace.slice(0, tileCount), tileI: tileI.slice(0, tileCount), tileJ: tileJ.slice(0, tileCount),
      maskLo: maskLo.slice(0, tileCount), maskHi: maskHi.slice(0, tileCount), tileListed: tileListed.slice(0, tileCount),
      interiorLo: interiorLo.slice(0, tileCount), interiorHi: interiorHi.slice(0, tileCount),
      activeTiles: activeTiles.slice(0, activeTileCount), scar,
    }
  }

  function restore(s) {
    const prevCells = tileCount << TILE_CELL_SHIFT
    tileCount = s.tileCount; activeCount = s.activeCount; activeTileCount = s.activeTileCount; scarCount = s.scarCount
    stepStart = s.stepStart; stepIndex = s.stepIndex; nextStepTick = s.nextStepTick; phase = s.phase; cursor = s.cursor; phaseEnd = s.phaseEnd; writePtr = s.writePtr
    quota = s.quota; stepInterval = s.stepInterval; moisture = s.moisture; rain = s.rain; eventSeq = s.eventSeq
    wind.set(s.wind); rebuildWeights()
    pending = s.pending.map(e => ({ ...e }))
    Object.assign(stats, s.stats)
    state.set(s.state); cls.set(s.cls); fuel.set(s.fuel); heat.set(s.heat); timer.set(s.timer)
    tileFace.set(s.tileFace); tileI.set(s.tileI); tileJ.set(s.tileJ)
    maskLo.set(s.maskLo); maskHi.set(s.maskHi); tileListed.set(s.tileListed)
    interiorLo.set(s.interiorLo); interiorHi.set(s.interiorHi)
    activeTiles.set(s.activeTiles)
    scarHead = 0; scarTail = scarCount % scarRingSize
    for (let i = 0; i < scarCount; i++) { scarRing[i] = s.scar[i * 2]; scarAt[i] = s.scar[i * 2 + 1] }
    rebuildTileIndex()
    tileEpoch = 0
    changeSerial++; tileGeneration++
    for (let t = 0; t < tileCount; t++) tileSerial[t] = changeSerial
    const cells = tileCount << TILE_CELL_SHIFT
    if (cells !== prevCells) hashOfCell.fill(0, Math.min(cells, prevCells), Math.max(cells, prevCells))
    reclaimCount = 0; reclaimGen++
    rebuildHash()
    if (undoMark !== null) { undoCount = 0; scarWriteCount = 0; undoGen++; capturePreStep() }
    stepOpen = false
  }

  return {
    queueEvent, tick, runStepUnsliced, checksum, snapshot, restore, takeDelta, undoDelta, releaseDelta, undoOpenStep, markRestored,
    ignite: (tickNumber, face, I, J, id) => queueEvent({ kind: FIRE_EVENT.IGNITE, tick: tickNumber, face, I, J, id }),
    extinguish: (tickNumber, face, I, J, radius, id) => queueEvent({ kind: FIRE_EVENT.EXTINGUISH, tick: tickNumber, face, I, J, radius, id }),
    setWind: (tickNumber, wx, wy, wz, id) => queueEvent({ kind: FIRE_EVENT.WIND, tick: tickNumber, wx, wy, wz, id }),
    setMoisture: (tickNumber, value, id) => queueEvent({ kind: FIRE_EVENT.MOISTURE, tick: tickNumber, value, id }),
    setRain: (tickNumber, value, id) => queueEvent({ kind: FIRE_EVENT.RAIN, tick: tickNumber, value, id }),
    cellState(face, I, J) {
      const g = peekCell(face, I, J)
      return g < 0 ? { state: UNBURNT, heat: 0, fuel: fuelInit[fuelClassAt(face, I, J)] } : { state: state[g], heat: heat[g], fuel: fuel[g] }
    },
    get changeSerial() { return changeSerial },
    get tileGeneration() { return tileGeneration },
    tileIndexOf: (face, ti, tj) => findTile(face, ti, tj),
    tileSerialOf: (t) => tileSerial[t],
    readTileStage(t, out, offset) {
      const base = t << TILE_CELL_SHIFT
      for (let i = 0; i < TILE_CELLS; i++) {
        const g = base + i, o = offset + i * 4, st = state[g]
        out[o] = st
        out[o + 1] = st === UNBURNT ? 0 : timer[g] & 255
        out[o + 2] = cls[g]
        out[o + 3] = 255
      }
    },
    smokeAt(face, I, J) { const g = peekCell(face, I, J); return g < 0 || state[g] !== BURNING ? 0 : smokeOf[cls[g]] },
    damageAt(face, I, J) { const g = peekCell(face, I, J); return g < 0 || state[g] !== BURNING ? 0 : damageOf[cls[g]] },
    stateCodeAt(face, I, J) { const g = peekCell(face, I, J); return g < 0 ? UNBURNT : state[g] },
    atBoundary: (tickNumber) => phase === 0 && tickNumber >= nextStepTick && tickNumber % stepTicks === 0,
    get stepStart() { return stepStart },
    get activeCount() { return activeCount },
    get activeTileCount() { return activeTileCount },
    get tileCount() { return tileCount },
    get liveTileCount() { return tileCount - freeTop },
    get freeTileCount() { return freeTop },
    get scarCount() { return scarCount },
    get stepIndex() { return stepIndex },
    get stats() { return stats },
    get wind() { return [wind[0], wind[1], wind[2]] },
    get memoryBytes() { return state.byteLength + cls.byteLength + fuel.byteLength + heat.byteLength + timer.byteLength + scarRing.byteLength + scarAt.byteLength + tileNbr.byteLength + table.byteLength + maskLo.byteLength * 2 + activeTiles.byteLength },
  }
}
