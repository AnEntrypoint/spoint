import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { TERRAIN_MARK_KINDS, compileTerrainMarks, TerrainMarkError } = await import('../src/terrain/TerrainMarks.js')

for (const kind of ['flatten', 'pond', 'lake', 'sea', 'river', 'path', 'road', 'clear', 'hole']) {
  assert.ok(TERRAIN_MARK_KINDS.includes(kind), `kind ${kind} must be declared`)
}
assert.equal(TERRAIN_MARK_KINDS.length, 9)

const lake = compileTerrainMarks([{ kind: 'lake', center: [0, 0], radius: 10, falloff: 0, level: 2 }])
assert.equal(lake.height(0, 0, 5), 2, 'lake lowers the centre to its level')
const road = compileTerrainMarks([{ kind: 'road', points: [[0, 0, 3], [10, 0, 3], [20, 0, 3]], width: 4, falloff: 0 }])
assert.equal(road.height(5, 0, 9), 3, 'road levels the ground to the path level')
const hole = compileTerrainMarks([{ kind: 'hole', center: [0, 0], radius: 3 }])
assert.equal(hole.clearsAt(1, 1), true, 'hole clears inside its radius')
assert.equal(hole.clearsAt(9, 9), false, 'hole does not clear outside its radius')
assert.equal(hole.height(0, 0, 7), 7, 'hole does not change height')

assert.throws(() => compileTerrainMarks([{ kind: 'castle' }]), e => e instanceof TerrainMarkError && e.reasonCode === 'unknown-kind')

console.log(`RESULT: PASS ${TERRAIN_MARK_KINDS.length} terrain mark kinds compile; lake levels, road follows path level, hole clears without touching height, unknown kind refuses with unknown-kind`)
