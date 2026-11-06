import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint, wrapHeightWithFieldPaint, naturalMaskAt, PAINTED_HEIGHT_FIELD, NATURAL_MASK_FIELD } = await import('../src/terrain/fieldPaint.js')

assert.equal(PAINTED_HEIGHT_FIELD, 'terrain:height')
assert.equal(NATURAL_MASK_FIELD, 'terrain:natural-mask')

const paint = createFieldPaint({ cellSize: 1, chunkCells: 8 })
const base = (x, z) => 10
assert.equal(wrapHeightWithFieldPaint(null, base), base, 'no paint instance returns the base height unchanged')

paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], radius: 1, fn: () => 2 })
const wrapped = wrapHeightWithFieldPaint(paint, base)
assert.equal(wrapped(0, 0, 0), 12, 'painted terrain:height adds to the base height at the stroke')
assert.equal(wrapped(30, 30, 0), 10, 'outside the stroke the base height is kept')

paint.stroke({ field: 'terrain:natural-mask', layer: 'CREATOR', center: [5, 5], radius: 1, fn: () => 0.7 })
assert.ok(Math.abs(naturalMaskAt(paint, 5, 5) - 0.7) < 1e-6, 'natural-mask reads back the stroke value (Float32 storage)')
assert.equal(naturalMaskAt(paint, 30, 30), 0, 'natural-mask is zero away from the stroke')

assert.throws(() => wrapHeightWithFieldPaint({}, base), e => e.reasonCode === 'paint-invalid')
assert.throws(() => naturalMaskAt(null, 0, 0), e => e.reasonCode === 'paint-invalid')

const tp = readFileSync('src/terrain/TerrainPhysics.js', 'utf8')
assert.ok(tp.includes('wrapHeightWithFieldPaint(fieldPaint,'), 'TerrainPhysics must apply the field paint in the height chain')
console.log('RESULT: PASS terrain:height paint adds to the collider height at the stroke, terrain:natural-mask reads back its stroke and is zero elsewhere, and a non-paint instance refuses with paint-invalid')
