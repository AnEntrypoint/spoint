import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint } = await import('../src/terrain/fieldPaint.js')

const paint = createFieldPaint({ cellSize: 1, chunkCells: 8 })
paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], place: [100, 50], radius: 1, fn: () => 3 })
assert.equal(paint.read('terrain:height', 100, 50), 3, 'the stroke lands at place plus center')
assert.equal(paint.read('terrain:height', 0, 0), 0, 'the origin is untouched when place is set')
assert.throws(() => paint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [0, 0], place: [NaN, 0], radius: 1, fn: () => 0 }), e => e.reasonCode === 'place-invalid')
console.log('RESULT: PASS field paint strokes land at place plus center, the origin stays untouched, and a non-finite place refuses with place-invalid')
