import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createVoxelPart, restore } from '../src/behaviours/voxels.js'

const source = readFileSync(new URL('../src/behaviours/voxels.js', import.meta.url), 'utf8')
for (const name of ['window', 'document', 'navigator', 'localStorage', 'fetch', 'process']) {
  assert.ok(!source.includes(name), 'voxels.js references a browser or host global: ' + name)
}

const PALETTE = ['air', 'stone', 'water', 'glass']
const refusals = []

function refusal(call, code) {
  assert.throws(call, (err) => {
    assert.equal(typeof err.reasonCode, 'string', 'a refusal carries no reasonCode')
    assert.ok(err.reasonCode.length > 0, 'a refusal carries an empty reasonCode')
    return err.reasonCode === code
  }, 'expected refusal code ' + code)
  refusals.push(code)
}

function countCells(part, value) {
  const [sx, sy, sz] = part.size
  let n = 0
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) if (part.get(x, y, z) === value) n++
    }
  }
  return n
}

function sumRuns(cells) {
  let n = 0
  for (let i = 1; i < cells.length; i += 2) n += cells[i]
  return n
}

const part = createVoxelPart({ size: [8, 8, 8], palette: PALETTE })
assert.deepEqual(part.size, [8, 8, 8])
assert.deepEqual(part.palette, PALETTE)
assert.equal(part.cellCount, 512)
assert.equal(countCells(part, 0), 512, 'a fresh part is all background')
assert.equal(part.set(1, 2, 3, 2), part, 'set returns the part for chaining')
assert.equal(part.get(1, 2, 3), 2)
assert.equal(part.get(1, 2, 4), 0)
part.set(1, 2, 3, 0)
assert.equal(part.get(1, 2, 3), 0, 'index 0 clears a cell')

const boxPart = createVoxelPart({ size: [8, 8, 8], palette: PALETTE })
boxPart.fill({ from: [2, 2, 2], to: [4, 4, 4] }, 1)
assert.equal(countCells(boxPart, 1), 27, 'a 3x3x3 box fills 27 cells')
assert.equal(boxPart.get(1, 2, 2), 0)
assert.equal(boxPart.get(5, 4, 4), 0)
boxPart.fill([[6, 6, 6], [5, 5, 5]], 3)
assert.equal(countCells(boxPart, 3), 8, 'reversed box corners normalize to an 8-cell box')
assert.equal(boxPart.get(5, 5, 5), 3)
assert.equal(boxPart.get(6, 6, 6), 3)
boxPart.fill({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 } }, 2)
assert.equal(countCells(boxPart, 2), 1, 'a degenerate box fills exactly one cell')

const shell = createVoxelPart({ size: [7, 7, 7], palette: PALETTE })
shell.hollowBox({ from: [0, 0, 0], to: [6, 6, 6] }, 1, 1)
assert.equal(countCells(shell, 1), 343 - 125, 'a 1-thick shell leaves a 5x5x5 hollow interior')
assert.equal(shell.get(3, 3, 3), 0)
assert.equal(shell.get(0, 3, 3), 1)
assert.equal(shell.get(6, 3, 3), 1)
assert.equal(shell.get(3, 0, 3), 1)
assert.equal(shell.get(1, 1, 1), 0, 'the interior corner of the shell stays empty')
assert.equal(shell.get(1, 1, 0), 1, 'a face cell one step in is still wall')

const shell2 = createVoxelPart({ size: [7, 7, 7], palette: PALETTE })
shell2.fill({ from: [0, 0, 0], to: [6, 6, 6] }, 2)
shell2.hollowBox({ from: [0, 0, 0], to: [6, 6, 6] }, 1, 2)
assert.equal(countCells(shell2, 1), 343 - 27, 'a 2-thick shell leaves a 3x3x3 interior')
assert.equal(countCells(shell2, 2), 27, 'hollowBox leaves the interior material untouched')
assert.equal(shell2.get(3, 3, 3), 2)
assert.equal(shell2.get(2, 2, 2), 2)

const shell3 = createVoxelPart({ size: [5, 5, 5], palette: PALETTE })
shell3.hollowBox({ from: [0, 0, 0], to: [4, 4, 4] }, 3, 9)
assert.equal(countCells(shell3, 3), 125, 'a thickness past the half-extent fills the whole box')

const ball = createVoxelPart({ size: [7, 7, 7], palette: PALETTE })
ball.sphere([3, 3, 3], 2, 1)
assert.equal(countCells(ball, 1), 33, 'a radius-2 lattice sphere holds 33 cells')
assert.equal(ball.get(3, 3, 3), 1)
assert.equal(ball.get(5, 3, 3), 1)
assert.equal(ball.get(4, 4, 4), 1)
assert.equal(ball.get(6, 3, 3), 0)
assert.equal(ball.get(5, 4, 3), 0)
assert.equal(ball.get(1, 1, 1), 0)

const corner = createVoxelPart({ size: [8, 8, 8], palette: PALETTE })
corner.sphere({ x: 0, y: 0, z: 0 }, 2, 2)
assert.equal(countCells(corner, 2), 11, 'a sphere at the corner clips to the grid')

const half = createVoxelPart({ size: [6, 6, 6], palette: PALETTE })
half.sphere([2.5, 2.5, 2.5], 1.5, 3)
assert.equal(countCells(half, 3), 8, 'a fractional center produces a symmetric 2x2x2 sphere')

const pristine = createVoxelPart({ size: [8, 8, 8], palette: PALETTE })
const blank = pristine.serialize()
assert.deepEqual(Object.keys(blank).sort(), ['cells', 'palette', 'size'])
assert.deepEqual(blank.size, [8, 8, 8])
assert.deepEqual(blank.palette, PALETTE)
assert.deepEqual(blank.cells, [0, 512], 'an empty grid serializes to a single run')
pristine.set(0, 0, 0, 2)
assert.deepEqual(pristine.serialize().cells, [2, 1, 0, 511], 'one painted cell yields two runs')

const stripes = createVoxelPart({ size: [4, 4, 4], palette: PALETTE })
stripes.fill({ from: [0, 0, 0], to: [3, 3, 1] }, 1)
const stripeRecord = stripes.serialize()
assert.deepEqual(stripeRecord.cells, [1, 32, 0, 32], 'RLE collapses a half-filled grid to two runs')
assert.equal(sumRuns(stripeRecord.cells), stripes.cellCount)

const built = createVoxelPart({ size: [9, 7, 5], palette: PALETTE })
built.fill({ from: [1, 1, 1], to: [7, 5, 3] }, 2)
built.hollowBox({ from: [0, 0, 0], to: [8, 6, 4] }, 3, 1)
built.sphere([4, 3, 2], 2, 1)
built.set(8, 6, 4, 0)
const record = built.serialize()
assert.ok(record.cells.length > 2, 'the composite part has several distinct runs')
assert.equal(sumRuns(record.cells), built.cellCount)
const clone = restore(record)
assert.deepEqual(clone.serialize(), record, 'serialize/restore is a byte-for-byte round trip')
assert.deepEqual(clone.size, built.size)
assert.deepEqual(clone.palette, built.palette)
const [sx, sy, sz] = built.size
for (let z = 0; z < sz; z++) {
  for (let y = 0; y < sy; y++) {
    for (let x = 0; x < sx; x++) assert.equal(clone.get(x, y, z), built.get(x, y, z), 'cell ' + x + ',' + y + ',' + z + ' differs after restore')
  }
}

const multi = restore({ size: [4, 4, 4], palette: PALETTE, cells: [1, 8, 0, 24, 2, 16, 3, 16] })
assert.equal(multi.get(0, 0, 0), 1)
assert.equal(multi.get(0, 0, 1), 0)
assert.equal(multi.get(0, 0, 2), 2)
assert.equal(multi.get(0, 0, 3), 3)

const mutableRecord = JSON.parse(JSON.stringify(record))
const aliased = restore(mutableRecord)
mutableRecord.cells[0] = 12345
assert.equal(aliased.serialize().cells[0], record.cells[0], 'restore copies the runs instead of aliasing the caller record')

const other = createVoxelPart({ size: [2, 2, 2], palette: ['dirt'] })
assert.equal(other.restore(record), other, 'the part restore method returns the part')
assert.deepEqual(other.size, [9, 7, 5], 'restore adopts the record size')
assert.deepEqual(other.palette, PALETTE, 'restore adopts the record palette')
assert.deepEqual(other.serialize(), record)
const beforeOther = other.serialize()
refusal(() => other.restore({ size: [2, 2, 2], palette: ['x'], cells: [0, 7] }), 'voxel-record-invalid')
assert.deepEqual(other.serialize(), beforeOther, 'a refused restore leaves the part untouched')

refusal(() => createVoxelPart(null), 'voxel-spec-invalid')
refusal(() => createVoxelPart([]), 'voxel-spec-invalid')
refusal(() => createVoxelPart({ size: [0, 2, 2], palette: PALETTE }), 'voxel-size-invalid')
refusal(() => createVoxelPart({ size: [2, 2], palette: PALETTE }), 'voxel-size-invalid')
refusal(() => createVoxelPart({ size: [2, 2, 2.5], palette: PALETTE }), 'voxel-size-invalid')
refusal(() => createVoxelPart({ size: [2, 2, NaN], palette: PALETTE }), 'voxel-size-invalid')
refusal(() => createVoxelPart({ size: [4096, 4096, 4096], palette: PALETTE }), 'voxel-size-invalid')
refusal(() => createVoxelPart({ size: [2, 2, 2], palette: [] }), 'voxel-palette-invalid')
refusal(() => createVoxelPart({ size: [2, 2, 2], palette: ['air', ''] }), 'voxel-palette-invalid')

const r = createVoxelPart({ size: [4, 4, 4], palette: PALETTE })
refusal(() => r.set(0, 0, 0, 4), 'voxel-index-invalid')
refusal(() => r.set(0, 0, 0, -1), 'voxel-index-invalid')
refusal(() => r.set(0, 0, 0, 1.5), 'voxel-index-invalid')
refusal(() => r.set(0, 0, 0, '1'), 'voxel-index-invalid')
refusal(() => r.set(0, 0, 0, NaN), 'voxel-index-invalid')
refusal(() => r.fill({ from: [0, 0, 0], to: [1, 1, 1] }, 99), 'voxel-index-invalid')
refusal(() => r.hollowBox({ from: [0, 0, 0], to: [3, 3, 3] }, 99, 1), 'voxel-index-invalid')
refusal(() => r.sphere([1, 1, 1], 1, 99), 'voxel-index-invalid')

refusal(() => r.get(-1, 0, 0), 'voxel-out-of-bounds')
refusal(() => r.get(4, 0, 0), 'voxel-out-of-bounds')
refusal(() => r.get(0, 0, 1.5), 'voxel-out-of-bounds')
refusal(() => r.set(0, 4, 0, 1), 'voxel-out-of-bounds')
refusal(() => r.fill({ from: [0, 0, 0], to: [4, 0, 0] }, 1), 'voxel-out-of-bounds')
refusal(() => r.fill({ from: [-1, 0, 0], to: [1, 1, 1] }, 1), 'voxel-out-of-bounds')
refusal(() => r.sphere([5, 1, 1], 1, 1), 'voxel-out-of-bounds')

refusal(() => r.fill(null, 1), 'voxel-box-invalid')
refusal(() => r.fill({ from: [0, 0], to: [1, 1, 1] }, 1), 'voxel-box-invalid')
refusal(() => r.fill({ from: [0, 0, 0], to: [1, 1, 1.2] }, 1), 'voxel-box-invalid')
refusal(() => r.hollowBox({ from: [0, 0, 0], to: [3, 3, 3] }, 1, 0), 'voxel-thickness-invalid')
refusal(() => r.hollowBox({ from: [0, 0, 0], to: [3, 3, 3] }, 1, 1.5), 'voxel-thickness-invalid')
refusal(() => r.sphere([1, 1], 1, 1), 'voxel-center-invalid')
refusal(() => r.sphere([1, 1, NaN], 1, 1), 'voxel-center-invalid')
refusal(() => r.sphere([1, 1, 1], 0, 1), 'voxel-radius-invalid')
refusal(() => r.sphere([1, 1, 1], Infinity, 1), 'voxel-radius-invalid')

const good = r.serialize()
refusal(() => restore(null), 'voxel-record-invalid')
refusal(() => restore([]), 'voxel-record-invalid')
refusal(() => restore({}), 'voxel-record-invalid')
refusal(() => restore({ size: good.size, palette: good.palette }), 'voxel-record-invalid')
refusal(() => restore({ ...good, size: [0, 4, 4] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, size: [4, 4, 4, 4] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, palette: [] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [0] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [0, 63] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [0, 65] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [0, 0] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [0, 32.5, 0, 31.5] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: [9, 64] }), 'voxel-record-invalid')
refusal(() => restore({ ...good, cells: ['0', 64] }), 'voxel-record-invalid')

for (const code of refusals) assert.equal(typeof code, 'string', 'a refusal code is missing')

console.log('RESULT: PASS voxels set/get, fill, hollow walls, sphere clipping, RLE round trip, ' + refusals.length + ' coded refusals, pure module')
