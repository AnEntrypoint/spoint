import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { packCellKey, resolveCell } = await import('../src/terrain/CubeSphereCells.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const TWO_POW_31 = 2 ** 31
const TWO_POW_32 = 2 ** 32
const EARTH_RADIUS_M = 6371000
const RELEVANCE_M = 200
const CELLS = Math.ceil((2 * EARTH_RADIUS_M) / RELEVANCE_M)
const STRIDE = packCellKey(0, 1, 0, CELLS) / 4
const FACE_STEP = STRIDE * 4

const raw = (face, cx, cy) => (face * STRIDE + cx) * FACE_STEP + cy
const wrap32 = value => ((value % TWO_POW_32) + TWO_POW_32) % TWO_POW_32

function inRangeCellWithRaw(value) {
  const n = Math.floor(value / FACE_STEP)
  const cy = value - n * FACE_STEP
  const face = Math.floor(n / STRIDE)
  const cx = n - face * STRIDE
  if (face > 5 || cx < 0 || cx >= CELLS || cy < 0 || cy >= CELLS) return null
  return [face, cx, cy]
}

function aliasOf(face, cx, cy) {
  return inRangeCellWithRaw(wrap32(raw(face, cx, cy)))
}

function findTopAlias() {
  for (let cx = CELLS - 1; cx >= CELLS - 200; cx--) {
    for (let cy = CELLS - 1; cy >= 0; cy--) {
      if (raw(5, cx, cy) < TWO_POW_32) return null
      const b = aliasOf(5, cx, cy)
      if (b) return { a: [5, cx, cy], b }
    }
  }
  return null
}

function findNegativeAlias() {
  for (let cy = 0; cy < CELLS; cy++) {
    const b = aliasOf(0, -1, cy)
    if (b && raw(b[0], b[1], b[2]) >= TWO_POW_31) return { n: [0, -1, cy], b }
  }
  return null
}

const top = findTopAlias()
if (top) {
  const [af, acx, acy] = top.a
  const [bf, bcx, bcy] = top.b
  const keyA = packCellKey(af, acx, acy, CELLS)
  const keyB = packCellKey(bf, bcx, bcy, CELLS)
  check('a cell past the int32 limit keeps a key distinct from every other reachable cell', keyA !== keyB, `cell (${af},${acx},${acy}) key ${keyA}; cell (${bf},${bcx},${bcy}) key ${keyB}; ${CELLS} cells per face`)
} else {
  check('a cell past the int32 limit keeps a key distinct from every other reachable cell', false, 'no in-range alias found to test')
}

check('the top cell key is the exact packed integer, not a wrapped one', packCellKey(5, CELLS - 1, CELLS - 1, CELLS) === raw(5, CELLS - 1, CELLS - 1), `packCellKey ${packCellKey(5, CELLS - 1, CELLS - 1, CELLS)}, exact ${raw(5, CELLS - 1, CELLS - 1)}`)

const negative = findNegativeAlias()
if (negative) {
  const [nf, ncx, ncy] = negative.n
  const [bf, bcx, bcy] = negative.b
  const keyN = packCellKey(nf, ncx, ncy, CELLS)
  const keyB = packCellKey(bf, bcx, bcy, CELLS)
  check('a negative cell is not packed onto a cell past the int32 limit', keyN !== keyB, `negative cell (${nf},${ncx},${ncy}) key ${keyN}; cell (${bf},${bcx},${bcy}) key ${keyB}`)
} else {
  check('a negative cell is not packed onto a cell past the int32 limit', false, 'no alias found to test')
}

let resolvedInRange = true
let worst = null
for (let face = 0; face < 6; face++) {
  for (const [cx, cy] of [[-1, 0], [0, -1], [-1, -1], [CELLS, 0], [0, CELLS], [CELLS, CELLS], [-1, CELLS]]) {
    const r = resolveCell(face, cx, cy, CELLS)
    if (r.cx < 0 || r.cx >= CELLS || r.cy < 0 || r.cy >= CELLS || r.face < 0 || r.face > 5) {
      resolvedInRange = false
      worst = { face, cx, cy, r }
    }
  }
}
check('resolveCell maps every off-face neighbour back into the packed range, so the packer never sees a negative cell from its callers', resolvedInRange, worst ? JSON.stringify(worst) : `${CELLS} cells per face, six faces`)

check('the packed key is a safe integer at the reachable top cell', Number.isSafeInteger(packCellKey(5, CELLS - 1, CELLS - 1, CELLS)), `${packCellKey(5, CELLS - 1, CELLS - 1, CELLS)}`)

check('a small planet keeps its existing key values', packCellKey(3, 10, 20, 1000) === (3 * 1002 + 10) * 4008 + 20, `got ${packCellKey(3, 10, 20, 1000)}`)

const failed = checks.filter(c => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map(c => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS packCellKey keeps every reachable cell key distinct and exact at ${CELLS} cells per face (Earth radius at 200 m relevance), including past the int32 limit and for a negative input (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
