import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { buildCrowdDots } = await import('../src/netcode/SnapshotEncoder.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const CELL = 25
const playerIn = (cx, cz, dx = 1, dz = 1) => ({ position: [cx * CELL + dx, 0, cz * CELL + dz] })
const sortDots = dots => [...dots].sort((a, b) => a[0] - b[0] || a[1] - b[1])
const sameDots = (got, want) => JSON.stringify(sortDots(got)) === JSON.stringify(sortDots(want))

const QUADRANTS = [
  ['both positive', [[30, 30]]],
  ['both negative', [[-3, -2]]],
  ['positive x, negative z', [[2, -5]]],
  ['negative x, positive z', [[-4, 7]]],
  ['negative x, zero z', [[-1, 0]]],
  ['zero x, negative z', [[0, -1]]],
  ['origin', [[0, 0]]],
]

for (const [label, cells] of QUADRANTS) {
  const got = buildCrowdDots(cells.map(([cx, cz]) => playerIn(cx, cz)), [0, 0, 0])
  const want = cells.map(([cx, cz]) => [cx, cz, 1])
  check(`a player in the ${label} cell is reported at that cell`, sameDots(got, want), `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`)
}

const mixed = [[2, -5], [-4, 7], [30, -30], [-30, 30], [-3, -2]]
const mixedGot = buildCrowdDots(mixed.map(([cx, cz]) => playerIn(cx, cz)), [0, 0, 0])
const mixedWant = mixed.map(([cx, cz]) => [cx, cz, 1])
check('every mixed-sign cell round-trips in one snapshot', sameDots(mixedGot, mixedWant), `got ${JSON.stringify(mixedGot)}`)

const pair = buildCrowdDots([playerIn(-4, 7, 1, 1), playerIn(-4, 7, 2, 2), playerIn(-4, 7, 3, 3)], [0, 0, 0])
check('players sharing a negative mixed-sign cell are counted together', sameDots(pair, [[-4, 7, 3]]), `got ${JSON.stringify(pair)}`)

const distinct = buildCrowdDots([playerIn(1, -1), playerIn(-1, 1)], [0, 0, 0])
check('the two diagonal cells (1,-1) and (-1,1) stay two dots', sameDots(distinct, [[1, -1, 1], [-1, 1, 1]]), `got ${JSON.stringify(distinct)}`)

check('an empty player list reports no dots', buildCrowdDots([], [0, 0, 0]).length === 0)

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a crowd dot is reported at its own cell in every quadrant, including mixed-sign cells, and players sharing a cell are counted together')
  await exitAfterQuiesce(0)
}
