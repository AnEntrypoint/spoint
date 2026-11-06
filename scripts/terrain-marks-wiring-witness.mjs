import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { wrapHeightWithMarks, TerrainMarkError } = await import('../src/terrain/TerrainMarks.js')

const base = (x, z) => 10
assert.equal(wrapHeightWithMarks(undefined, base), base, 'no marks returns the base height function unchanged')
const wrapped = wrapHeightWithMarks([{ kind: 'lake', center: [0, 0], radius: 5, falloff: 0, level: 4 }], base)
assert.equal(wrapped(0, 0, 0), 4, 'a lake mark lowers the base height at its centre')
assert.equal(wrapped(50, 50, 0), 10, 'outside the mark the base height is kept')
assert.throws(() => wrapHeightWithMarks('lake', base), e => e instanceof TerrainMarkError && e.reasonCode === 'not-a-list')

const src = (await import('node:fs')).readFileSync('src/terrain/TerrainPhysics.js', 'utf8')
assert.ok(src.includes('wrapHeightWithMarks(tcfg.marks, baseHeightFn)'), 'TerrainPhysics must wire terrain.marks into the height chain')
console.log('RESULT: PASS terrain.marks from the world terrain config wrap the collider height chain: no marks is identity, a lake lowers its centre, and a non-list refuses with not-a-list')
