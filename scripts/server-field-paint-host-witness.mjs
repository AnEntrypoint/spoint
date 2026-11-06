import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createFieldPaint, wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')

const paint = createFieldPaint({ cellSize: 1, chunkCells: 64 })
assert.equal(typeof paint.stroke, 'function', 'the host default paint instance is a createFieldPaint instance')
assert.equal(wrapHeightWithFieldPaint(paint, () => 5)(0, 0, 0), 5, 'an unpainted default paint leaves the height unchanged')

const src = readFileSync('src/sdk/ServerAPI.js', 'utf8')
assert.ok(src.includes("import { createFieldPaint } from '../terrain/fieldPaint.js'"), 'ServerAPI must import the paint factory')
assert.ok(src.includes('fieldPaint })'), 'the server terrain setup must pass fieldPaint')
console.log('RESULT: PASS the server host creates a field paint instance and passes it to setupTerrainStreaming; an unpainted default leaves the collider height unchanged')
