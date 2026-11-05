const MAX_CELLS = 1 << 22
const MAX_PALETTE = 1 << 16

function refuse(reasonCode, message) {
  const err = new TypeError('[voxels] ' + reasonCode + ': ' + message)
  err.reasonCode = reasonCode
  throw err
}

function parseSize(size, code) {
  if (!Array.isArray(size) || size.length !== 3) refuse(code, 'size must be [sx, sy, sz], got ' + JSON.stringify(size))
  const dims = []
  let total = 1
  for (const n of size) {
    if (!Number.isInteger(n) || n < 1) refuse(code, 'size component must be a positive integer, got ' + JSON.stringify(n))
    total *= n
    if (!Number.isSafeInteger(total) || total > MAX_CELLS) refuse(code, 'size exceeds ' + MAX_CELLS + ' cells')
    dims.push(n)
  }
  return { dims, total }
}

function parsePalette(palette, code) {
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > MAX_PALETTE) refuse(code, 'palette must hold 1..' + MAX_PALETTE + ' material ids')
  for (const id of palette) {
    if (typeof id !== 'string' || id.length === 0) refuse(code, 'palette entries must be non-empty strings, got ' + JSON.stringify(id))
  }
  return palette.slice()
}

function parseIndex(value, length) {
  if (!Number.isInteger(value) || value < 0 || value >= length) refuse('voxel-index-invalid', 'index must be an integer in 0..' + (length - 1) + ', got ' + JSON.stringify(value))
  return value
}

function parseCoord(value, axis, dims) {
  if (!Number.isInteger(value) || value < 0 || value >= dims[axis]) refuse('voxel-out-of-bounds', 'axis ' + axis + ' coordinate ' + JSON.stringify(value) + ' is outside 0..' + (dims[axis] - 1))
  return value
}

function readTriple(value, code, integral) {
  let out = null
  if (Array.isArray(value) && value.length === 3) out = [value[0], value[1], value[2]]
  else if (value !== null && typeof value === 'object' && !Array.isArray(value)) out = [value.x, value.y, value.z]
  if (out === null) refuse(code, 'expected [x, y, z] or {x, y, z}, got ' + JSON.stringify(value))
  for (const n of out) {
    if (!Number.isFinite(n) || (integral && !Number.isInteger(n))) refuse(code, 'coordinate must be ' + (integral ? 'an integer' : 'finite') + ', got ' + JSON.stringify(n))
  }
  return out
}

function parseBox(box, dims) {
  let from
  let to
  if (Array.isArray(box) && box.length === 2) {
    from = box[0]
    to = box[1]
  } else if (box !== null && typeof box === 'object' && !Array.isArray(box)) {
    from = box.from
    to = box.to
  } else refuse('voxel-box-invalid', 'box must be {from, to} or [from, to], got ' + JSON.stringify(box))
  const a = readTriple(from, 'voxel-box-invalid', true)
  const b = readTriple(to, 'voxel-box-invalid', true)
  const lo = [0, 0, 0]
  const hi = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    lo[axis] = Math.min(a[axis], b[axis])
    hi[axis] = Math.max(a[axis], b[axis])
    parseCoord(lo[axis], axis, dims)
    parseCoord(hi[axis], axis, dims)
  }
  return { lo, hi }
}

function parseThickness(thickness) {
  if (!Number.isInteger(thickness) || thickness < 1) refuse('voxel-thickness-invalid', 'thickness must be a positive integer, got ' + JSON.stringify(thickness))
  return thickness
}

function parseCenter(center, dims) {
  const c = readTriple(center, 'voxel-center-invalid', false)
  for (let axis = 0; axis < 3; axis++) {
    if (c[axis] < 0 || c[axis] > dims[axis] - 1) refuse('voxel-out-of-bounds', 'center axis ' + axis + ' is outside 0..' + (dims[axis] - 1))
  }
  return c
}

function parseRadius(radius) {
  if (!Number.isFinite(radius) || radius <= 0) refuse('voxel-radius-invalid', 'radius must be a finite positive number, got ' + JSON.stringify(radius))
  return radius
}

function decodeRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) refuse('voxel-record-invalid', 'record must be an object {size, palette, cells}')
  if (!('size' in record) || !('palette' in record) || !('cells' in record)) refuse('voxel-record-invalid', 'record needs size, palette and cells')
  const { dims, total } = parseSize(record.size, 'voxel-record-invalid')
  const materials = parsePalette(record.palette, 'voxel-record-invalid')
  const runs = record.cells
  if (!Array.isArray(runs) || runs.length === 0 || runs.length % 2 !== 0) refuse('voxel-record-invalid', 'cells must be a non-empty even-length run-length array')
  const cells = new Uint32Array(total)
  let cursor = 0
  for (let k = 0; k < runs.length; k += 2) {
    const value = runs[k]
    const run = runs[k + 1]
    if (!Number.isInteger(value) || value < 0 || value >= materials.length) refuse('voxel-record-invalid', 'cell value ' + JSON.stringify(value) + ' is not a palette index')
    if (!Number.isInteger(run) || run < 1) refuse('voxel-record-invalid', 'run length ' + JSON.stringify(run) + ' must be a positive integer')
    if (cursor + run > total) refuse('voxel-record-invalid', 'run lengths exceed the declared size')
    if (value !== 0) cells.fill(value, cursor, cursor + run)
    cursor += run
  }
  if (cursor !== total) refuse('voxel-record-invalid', 'run lengths cover ' + cursor + ' of ' + total + ' cells')
  return { dims, total, materials, cells }
}

function makePart(state) {
  let dims = state.dims
  let total = state.total
  let materials = state.materials
  let cells = state.cells
  const offsetOf = (x, y, z) => x + dims[0] * (y + dims[1] * z)
  const coord = (value, axis) => parseCoord(value, axis, dims)
  const index = (value) => parseIndex(value, materials.length)
  const part = {
    get size() { return dims.slice() },
    get palette() { return materials.slice() },
    get cellCount() { return total },
    get(x, y, z) { return cells[offsetOf(coord(x, 0), coord(y, 1), coord(z, 2))] },
    set(x, y, z, value) {
      const i = index(value)
      cells[offsetOf(coord(x, 0), coord(y, 1), coord(z, 2))] = i
      return part
    },
    fill(box, value) {
      const i = index(value)
      const { lo, hi } = parseBox(box, dims)
      for (let z = lo[2]; z <= hi[2]; z++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let x = lo[0]; x <= hi[0]; x++) cells[offsetOf(x, y, z)] = i
        }
      }
      return part
    },
    hollowBox(box, value, thickness) {
      const i = index(value)
      const t = parseThickness(thickness)
      const { lo, hi } = parseBox(box, dims)
      for (let z = lo[2]; z <= hi[2]; z++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let x = lo[0]; x <= hi[0]; x++) {
            if (x >= lo[0] + t && x <= hi[0] - t && y >= lo[1] + t && y <= hi[1] - t && z >= lo[2] + t && z <= hi[2] - t) continue
            cells[offsetOf(x, y, z)] = i
          }
        }
      }
      return part
    },
    sphere(center, radius, value) {
      const i = index(value)
      const c = parseCenter(center, dims)
      const r = parseRadius(radius)
      const r2 = r * r
      const xa = Math.max(0, Math.ceil(c[0] - r))
      const xb = Math.min(dims[0] - 1, Math.floor(c[0] + r))
      const ya = Math.max(0, Math.ceil(c[1] - r))
      const yb = Math.min(dims[1] - 1, Math.floor(c[1] + r))
      const za = Math.max(0, Math.ceil(c[2] - r))
      const zb = Math.min(dims[2] - 1, Math.floor(c[2] + r))
      for (let z = za; z <= zb; z++) {
        const dz2 = (z - c[2]) * (z - c[2])
        for (let y = ya; y <= yb; y++) {
          const dy2 = (y - c[1]) * (y - c[1])
          for (let x = xa; x <= xb; x++) {
            const dx2 = (x - c[0]) * (x - c[0])
            if (dx2 + dy2 + dz2 <= r2) cells[offsetOf(x, y, z)] = i
          }
        }
      }
      return part
    },
    serialize() {
      const runs = []
      let previous = cells[0]
      let run = 1
      for (let k = 1; k < total; k++) {
        const value = cells[k]
        if (value === previous) run++
        else {
          runs.push(previous, run)
          previous = value
          run = 1
        }
      }
      runs.push(previous, run)
      return { size: dims.slice(), palette: materials.slice(), cells: runs }
    },
    restore(record) {
      const next = decodeRecord(record)
      dims = next.dims
      total = next.total
      materials = next.materials
      cells = next.cells
      return part
    },
  }
  return part
}

export function createVoxelPart(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('voxel-spec-invalid', 'createVoxelPart expects {size, palette}')
  const { dims, total } = parseSize(spec.size, 'voxel-size-invalid')
  const materials = parsePalette(spec.palette, 'voxel-palette-invalid')
  return makePart({ dims, total, materials, cells: new Uint32Array(total) })
}

export function restore(record) {
  return makePart(decodeRecord(record))
}
