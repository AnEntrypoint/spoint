import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createHostFieldPaint } = await import('../src/terrain/fieldPaint.js')

const dflt = createHostFieldPaint(undefined)
assert.equal(dflt.chunkObject('terrain:height', 'PLAYER', 0, 0).chunkCells, 64, 'no config keeps the default chunk cells')
assert.equal(createHostFieldPaint({ fieldPaint: { cellSize: 2, chunkCells: 32 } }).chunkObject('terrain:height', 'PLAYER', 0, 0).cellSize, 2)
for (const [cfg, code] of [
  [{ fieldPaint: 'big' }, 'field-paint-config-invalid'],
  [{ fieldPaint: { cellSize: 0 } }, 'field-paint-cell-size-invalid'],
  [{ fieldPaint: { cellSize: NaN } }, 'field-paint-cell-size-invalid'],
  [{ fieldPaint: { cellSize: '2' } }, 'field-paint-cell-size-invalid'],
  [{ fieldPaint: { chunkCells: 2.5 } }, 'field-paint-chunk-cells-invalid'],
  [{ fieldPaint: { chunkCells: 0 } }, 'field-paint-chunk-cells-invalid'],
]) assert.throws(() => createHostFieldPaint(cfg), e => e.reasonCode === code, code)
console.log('RESULT: PASS terrain.fieldPaint is validated at config load: defaults hold with no config, and a non-object, a non-positive or non-numeric cellSize and a non-integer chunkCells each refuse with a named reasonCode')
