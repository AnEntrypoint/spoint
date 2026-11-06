import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint } = await import('../src/terrain/fieldPaint.js')

const a = createFieldPaint({ cellSize: 1, chunkCells: 8 })
a.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [2, 2], radius: 1, fn: () => 3 })
a.stroke({ field: 'terrain:natural-mask', layer: 'CREATOR', center: [6, 6], radius: 1, fn: () => 0.25 })
const saved = JSON.parse(JSON.stringify(a.toJSON()))

const b = createFieldPaint({ cellSize: 1, chunkCells: 8 })
b.fromJSON(saved)
assert.ok(Math.abs(b.read('terrain:height', 2, 2) - 3) < 1e-6, 'a restored paint reads back the saved height')
assert.ok(Math.abs(b.read('terrain:natural-mask', 6, 6) - 0.25) < 1e-6, 'a restored paint reads back the saved natural mask')
assert.equal(b.read('terrain:height', 40, 40), 0, 'unpainted cells stay unpainted after restore')
assert.deepEqual(JSON.parse(JSON.stringify(b.toJSON())), saved, 'save, restore and save again gives the same document')

for (const [doc, code] of [
  [null, 'paint-doc-invalid'],
  [{ 'terrain:sky': {} }, 'field-unknown'],
]) assert.throws(() => createFieldPaint({ cellSize: 1, chunkCells: 8 }).fromJSON(doc), e => e.reasonCode === code, code)
assert.throws(() => createFieldPaint({ cellSize: 1, chunkCells: 8 }).fromJSON({ 'terrain:height': { PLAYER: [{ key: '0,0', cells: [1, 2] }] } }), e => e instanceof RangeError)

console.log('RESULT: PASS field paint saves to a document and restores it: painted height and natural mask read back, unpainted cells stay zero, a second save matches, and a null document or unknown field refuses')
