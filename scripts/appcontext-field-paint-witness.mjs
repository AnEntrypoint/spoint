import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createHostFieldPaint, wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')

const paint = createHostFieldPaint(undefined)
assert.equal(typeof paint.stroke, 'function', 'no terrain config still yields a paint instance')
assert.equal(wrapHeightWithFieldPaint(paint, () => 3)(0, 0, 0), 3, 'an unpainted default leaves the height unchanged')
const custom = createHostFieldPaint({ fieldPaint: { cellSize: 2, chunkCells: 32 } })
const chunk = custom.chunkObject('terrain:height', 'PLAYER', 0, 0)
assert.equal(chunk.cellSize, 2, 'terrain.fieldPaint sets the cell size')
assert.equal(chunk.chunkCells, 32, 'terrain.fieldPaint sets the chunk cells')

const src = readFileSync('src/apps/AppContext.js', 'utf8')
assert.ok(src.includes(`const { createHostFieldPaint } = await import('${['..', 'terrain', 'fieldPaint.js'].join('/')}')`), 'AppContext must load the host paint factory')
assert.ok(src.includes('fieldPaint: createHostFieldPaint(tcfg)'), 'AppContext startStreaming must pass the paint instance')
console.log('RESULT: PASS AppContext startStreaming passes a host field paint instance to setupTerrainStreaming; terrain.fieldPaint sets its cell size and chunk cells, and the default leaves the height unchanged')
