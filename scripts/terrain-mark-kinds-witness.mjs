import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { TERRAIN_MARK_KINDS, compileTerrainMarks, TerrainMarkError } = await import('../src/terrain/TerrainMarks.js')

for (const kind of ['grade', 'spline', 'liquid']) assert.ok(TERRAIN_MARK_KINDS.includes(kind), `kind ${kind} must be declared`)
assert.equal(TERRAIN_MARK_KINDS.length, 12)

const grade = compileTerrainMarks([{ kind: 'grade', center: [0, 0], radius: 10, falloff: 0, level: 0, slope: 0.25, maxGrade: 0.5 }])
assert.equal(grade.height(4, 0, 10), 1, 'a grade drives the ground to level plus slope times x')
assert.throws(() => compileTerrainMarks([{ kind: 'grade', center: [0, 0], radius: 10, falloff: 0, level: 0, slope: 0.9, maxGrade: 0.5 }]), e => e instanceof TerrainMarkError && e.reasonCode === 'grade-too-steep')

const spline = compileTerrainMarks([{ kind: 'spline', points: [[0, 0, 2], [10, 0, 2]], width: 0, falloff: 1 }])
assert.equal(spline.height(0, 0, 6), 2, 'a spline pulls the ground onto its level on the line')
assert.equal(spline.height(0, 50, 6), 6, 'far from the spline the ground is unchanged')
assert.throws(() => compileTerrainMarks([{ kind: 'spline', points: [[0, 0, 2], [10, 0, 2]], width: 0, falloff: 0 }]), e => e instanceof TerrainMarkError && e.reasonCode === 'bad-number')

const liquid = compileTerrainMarks([{ kind: 'liquid', center: [0, 0], radius: 5, level: 3 }])
assert.equal(liquid.height(0, 0, 9), 9, 'a liquid mark does not change the ground height')
assert.equal(liquid.liquidLevelAt(1, 1), 3, 'inside the footprint the liquid level is reported')
assert.equal(liquid.liquidLevelAt(20, 20), null, 'outside the footprint there is no liquid level')

console.log('RESULT: PASS grade drives the ground to its slope and refuses a slope above maxGrade, a spline pulls the ground onto its line, and liquid reports a level without changing the ground height; 12 mark kinds declared')
