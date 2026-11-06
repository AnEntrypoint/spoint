import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint, TERRAIN_FIELD_NAMES, FIELD_LAYER_NAMES } = await import('../src/terrain/fieldPaint.js')

assert.deepEqual(TERRAIN_FIELD_NAMES, ['terrain:height', 'terrain:water', 'terrain:natural-mask'])
assert.deepEqual(FIELD_LAYER_NAMES, ['PLAYER', 'CREATOR'])

const paint = createFieldPaint({ cellSize: 1, chunkCells: 8 })
const n = paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], radius: 2, fn: (p, inset, current) => current + inset })
assert.ok(n > 0, 'stroke must touch cells')
assert.ok(paint.read('terrain:height', 0, 0) > 0.9, 'centre takes the full inset')
assert.equal(paint.read('terrain:height', 10, 10), 0, 'cells outside the radius stay untouched')
assert.equal(paint.read('terrain:water', 0, 0), 0, 'other fields are untouched')

paint.stroke({ field: 'terrain:height', layer: 'CREATOR', center: [0, 0], radius: 1, fn: () => 5 })
assert.equal(paint.read('terrain:height', 0, 0), 6, 'each layer keeps its own value: PLAYER 1 plus CREATOR 5')
assert.ok(paint.undo(), 'undo reverts the last stroke')
assert.ok(paint.read('terrain:height', 0, 0) < 5, 'undo removes the CREATOR stroke')
assert.ok(paint.undo())
assert.equal(paint.read('terrain:height', 0, 0), 0, 'undo of the first stroke restores zero')

const chunk = paint.chunkObject('terrain:height', 'PLAYER', 0, 0)
assert.equal(chunk.cellSize, 1)
assert.equal(chunk.chunkCells, 8)
assert.equal(typeof chunk.version, 'number')

for (const [call, code] of [
  [() => paint.stroke({ field: 'terrain:sky', layer: 'PLAYER', center: [0, 0], radius: 1, fn: () => 0 }), 'field-unknown'],
  [() => paint.stroke({ field: 'terrain:height', layer: 'GUEST', center: [0, 0], radius: 1, fn: () => 0 }), 'layer-unknown'],
  [() => paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], radius: 0, fn: () => 0 }), 'radius-invalid'],
  [() => paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], radius: 1, fn: 3 }), 'stroke-fn-invalid'],
]) assert.throws(call, e => e.reasonCode === code, code)

console.log('RESULT: PASS named terrain fields with PLAYER and CREATOR layers paint by stroke callback, undo reverts the last stroke, and unknown field, layer, radius and fn refuse with codes')
