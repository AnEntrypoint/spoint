const TILE_SIZE = 8
const TILE_CELLS = 64
const TEXELS_PER_TILE_ROW = TILE_SIZE
const BYTES_PER_TEXEL = 4
const TILE_BYTES = TILE_CELLS * BYTES_PER_TEXEL

export function createFireStageMap({ kernel, lattice, slotsAcross = 64, slotsDown = 64 }) {
  if (lattice.cellsPerFace < TILE_SIZE) throw new RangeError('[fireStageMap] lattice too small')
  const slotCapacity = slotsAcross * slotsDown
  const width = slotsAcross * TILE_SIZE, height = slotsDown * TILE_SIZE
  const data = new Uint8Array(width * height * BYTES_PER_TEXEL)
  const tilesPerAxis = Math.ceil(lattice.cellsPerFace / TILE_SIZE)
  const slotOfKey = new Map()
  const keyOfSlot = new Int32Array(slotCapacity).fill(-1)
  const refCount = new Int32Array(slotCapacity)
  const seenSerial = new Float64Array(slotCapacity)
  const tileOfSlot = new Int32Array(slotCapacity).fill(-1)
  const freeSlots = []
  let slotCount = 0
  let generation = -1
  const scratch = new Uint8Array(TILE_BYTES)
  const dirty = new Int32Array(slotCapacity)
  const stats = { syncs: 0, tilesWritten: 0, bytesWritten: 0, resolves: 0 }

  function tileKey(face, ti, tj) { return (face * tilesPerAxis + ti) * tilesPerAxis + tj }
  function blockOrigin(slot) { return { x: (slot % slotsAcross) * TILE_SIZE, y: Math.floor(slot / slotsAcross) * TILE_SIZE } }

  function writeTile(slot, source) {
    const bx = (slot % slotsAcross) * TILE_SIZE, by = Math.floor(slot / slotsAcross) * TILE_SIZE
    for (let row = 0; row < TILE_SIZE; row++) {
      const dst = ((by + row) * width + bx) * BYTES_PER_TEXEL
      data.set(source.subarray(row * TEXELS_PER_TILE_ROW * BYTES_PER_TEXEL, (row + 1) * TEXELS_PER_TILE_ROW * BYTES_PER_TEXEL), dst)
    }
  }

  function clearTile(slot) { scratch.fill(0); writeTile(slot, scratch) }

  function acquire(face, ti, tj) {
    const key = tileKey(face, ti, tj)
    let slot = slotOfKey.get(key)
    if (slot === undefined) {
      slot = freeSlots.length ? freeSlots.pop() : slotCount < slotCapacity ? slotCount++ : -1
      if (slot < 0) throw new RangeError(`[fireStageMap] all ${slotCapacity} tile slots are in use`)
      slotOfKey.set(key, slot); keyOfSlot[slot] = key; refCount[slot] = 0; seenSerial[slot] = -1; tileOfSlot[slot] = -1
      clearTile(slot)
    }
    refCount[slot]++
    return slot
  }

  function release(face, ti, tj) {
    const key = tileKey(face, ti, tj)
    const slot = slotOfKey.get(key)
    if (slot === undefined) return false
    if (--refCount[slot] > 0) return true
    slotOfKey.delete(key); keyOfSlot[slot] = -1; tileOfSlot[slot] = -1
    clearTile(slot)
    freeSlots.push(slot)
    return true
  }

  function slotValueOfCell(face, I, J) {
    const slot = slotOfKey.get(tileKey(face, I >> 3, J >> 3))
    return slot === undefined ? -1 : slot * TILE_CELLS + ((J & 7) << 3) + (I & 7)
  }

  function slotValueOfTrunk(trunkId) {
    const c = lattice.cellOfPlacementId(trunkId)
    return slotValueOfCell(c.face, c.I, c.J)
  }

  function texelOf(value, out) {
    const slot = Math.floor(value / TILE_CELLS), local = value % TILE_CELLS
    out.x = (slot % slotsAcross) * TILE_SIZE + (local & 7)
    out.y = Math.floor(slot / slotsAcross) * TILE_SIZE + (local >> 3)
    return out
  }

  function sync() {
    stats.syncs++
    const regenerate = kernel.tileGeneration !== generation
    if (regenerate) { generation = kernel.tileGeneration; stats.resolves++ }
    let changed = 0
    for (const [key, slot] of slotOfKey) {
      let t = tileOfSlot[slot]
      if (regenerate || t < 0) {
        const tj = key % tilesPerAxis, rest = (key - tj) / tilesPerAxis, ti = rest % tilesPerAxis, face = (rest - ti) / tilesPerAxis
        t = kernel.tileIndexOf(face, ti, tj)
        tileOfSlot[slot] = t
        if (regenerate) seenSerial[slot] = -1
      }
      if (t < 0) {
        if (seenSerial[slot] !== 0) { clearTile(slot); seenSerial[slot] = 0; dirty[changed++] = slot; stats.bytesWritten += TILE_BYTES }
        continue
      }
      const serial = kernel.tileSerialOf(t)
      if (serial === seenSerial[slot]) continue
      kernel.readTileStage(t, scratch, 0)
      writeTile(slot, scratch)
      seenSerial[slot] = serial
      dirty[changed++] = slot
      stats.bytesWritten += TILE_BYTES
    }
    stats.tilesWritten += changed
    return changed
  }

  return {
    data, width, height, slotCapacity, acquire, release, slotValueOfCell, slotValueOfTrunk, texelOf, sync, stats, dirtySlots: dirty, blockOrigin,
    get watchedTiles() { return slotOfKey.size },
  }
}

export function burnMaskWindow(kernel, face, I0, J0, widthCells, heightCells, out) {
  let lit = 0
  for (let j = 0; j < heightCells; j++) {
    const row = j * widthCells
    for (let i = 0; i < widthCells; i++) {
      const state = kernel.stateCodeAt(face, I0 + i, J0 + j)
      out[row + i] = state === 2 ? 255 : state === 1 ? 128 : 0
      if (state !== 0) lit++
    }
  }
  return lit
}
