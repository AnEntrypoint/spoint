import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint, naturalMaskAt } = await import('../src/terrain/fieldPaint.js')

const paint = createFieldPaint({ cellSize: 1, chunkCells: 8 })
paint.stroke({ field: 'terrain:natural-mask', layer: 'CREATOR', center: [3, 3], radius: 1, fn: () => 0.5 })
assert.ok(Math.abs(naturalMaskAt(paint, 3, 3) - 0.5) < 1e-6, 'the mask reads back the stroke')
assert.equal(naturalMaskAt(paint, 40, 40), 0, 'the mask is zero away from the stroke')

const src = readFileSync('src/terrain/TerrainPhysics.js', 'utf8')
assert.ok(src.includes('streamer.naturalMask = fieldPaint ? Object.freeze({ at: (x, z) => naturalMaskAt(fieldPaint, x, z) }) : null'), 'the terrain streamer must expose a read-only natural-mask accessor')
assert.ok(!/streamer\.naturalMask\.(set|paint|write)/.test(src), 'nothing may write through the natural-mask accessor')
console.log('RESULT: PASS the terrain streamer exposes terrain:natural-mask as a frozen read-only accessor that reads the paint instance, and is null when no paint is given')
