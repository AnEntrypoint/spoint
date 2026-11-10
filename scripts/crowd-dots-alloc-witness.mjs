import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modArg = process.argv.find((a) => a.startsWith('--module='))
const modPath = modArg ? path.resolve(modArg.slice('--module='.length)) : path.join(ROOT, 'src/netcode/SnapshotEncoder.js')

const NativeMap = globalThis.Map
const counts = { mapNew: 0, mapSet: 0 }
globalThis.Map = class CountingMap extends NativeMap {
  constructor(entries) { super(entries); counts.mapNew++ }
  set(key, value) { counts.mapSet++; return super.set(key, value) }
}
const { buildCrowdDots } = await import(pathToFileURL(modPath).href)
globalThis.Map = NativeMap

const checks = []
const check = (name, ok, detail = '') => {
  checks.push(ok)
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const CELL = 25
const PLAYERS = Array.from({ length: 200 }, (_, i) => ({ id: i, position: [(i % 4) * 30 + 1, 0, Math.floor(i / 50) * 30 + 3] }))
const expected = new Map()
for (const p of PLAYERS) {
  const key = `${Math.floor(p.position[0] / CELL)},${Math.floor(p.position[2] / CELL)}`
  const cell = expected.get(key) ?? [Math.floor(p.position[0] / CELL), Math.floor(p.position[2] / CELL), 0]
  cell[2]++
  expected.set(key, cell)
}
const expectedDots = [...expected.values()]

const dots = buildCrowdDots(PLAYERS, [0, 0, 0], CELL)
const sameCells = dots.length === expectedDots.length && dots.every((d) => expectedDots.some((e) => e[0] === d[0] && e[1] === d[1] && e[2] === d[2]))
check('each occupied cell is one [cx, cz, count] dot with its player count', sameCells, `dots ${dots.length} expected ${expectedDots.length}`)
check('the dots total every player that has a position', dots.reduce((sum, d) => sum + d[2], 0) === PLAYERS.length)
check('an empty player list returns no dots', buildCrowdDots([], [0, 0, 0], CELL).length === 0)

const first = buildCrowdDots(PLAYERS, [0, 0, 0], CELL)
const before = JSON.stringify(first)
buildCrowdDots(PLAYERS.slice(0, 7).map((p) => ({ id: p.id, position: [500, 0, 500] })), [0, 0, 0], CELL)
check('a later call does not change an earlier result (no aliasing)', JSON.stringify(first) === before)

const CALLS = 100
counts.mapNew = 0
counts.mapSet = 0
for (let i = 0; i < CALLS; i++) buildCrowdDots(PLAYERS, [0, 0, 0], CELL)
console.log(`allocation: ${CALLS} calls over ${PLAYERS.length} players in ${expectedDots.length} cells: Map.set ${counts.mapSet}, new Map ${counts.mapNew}`)
check(`${CALLS} calls write no Map entry`, counts.mapSet === 0, `Map.set ${counts.mapSet}`)
check(`${CALLS} calls construct no Map`, counts.mapNew === 0, `new Map ${counts.mapNew}`)

const failed = checks.filter((ok) => !ok).length
if (failed) {
  console.log(`RESULT: FAIL ${failed} of ${checks.length} check(s) failed on ${path.relative(ROOT, modPath)}`)
  process.exit(1)
}
console.log(`RESULT: PASS buildCrowdDots builds its dots with no Map: ${CALLS} calls wrote ${counts.mapSet} Map entries and made ${counts.mapNew} Maps over ${PLAYERS.length} players (module ${path.relative(ROOT, modPath)})`)
process.exit(0)
