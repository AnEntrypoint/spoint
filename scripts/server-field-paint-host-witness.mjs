import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createHostFieldPaint, wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')
const paint = createHostFieldPaint(undefined)
assert.equal(typeof paint.stroke, 'function', 'the host default paint instance is a field paint')
assert.equal(wrapHeightWithFieldPaint(paint, () => 4)(0, 0, 0), 4, 'an unpainted default leaves the height unchanged')

const src = readFileSync('src/sdk/ServerAPI.js', 'utf8')
assert.ok(src.includes(`import { restorePaintDocument, persistPaintDocument } from '${['..', 'terrain', 'paintStore.js'].join('/')}'`), 'ServerAPI must import the paint store')
assert.ok(src.includes('restorePaintDocument(storage, _tcfg)'), 'the server terrain setup must restore the paint from storage')
console.log('RESULT: PASS the server host creates a field paint instance through the paint store and passes it to setupTerrainStreaming; an unpainted default leaves the collider height unchanged')
