import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createHostFieldPaint, wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')
const paint = createHostFieldPaint(undefined)
assert.equal(wrapHeightWithFieldPaint(paint, () => 4)(0, 0, 0), 4, 'the worker default paint leaves the height unchanged')

const src = readFileSync('src/sdk/WorkerEntry.js', 'utf8')
assert.ok(src.includes(`import { createHostFieldPaint } from '${['..', 'terrain', 'fieldPaint.js'].join('/')}'`), 'WorkerEntry must import the host paint factory')
assert.ok(src.includes('fieldPaint: createHostFieldPaint(_tcfg) })'), 'the worker terrain setup must pass the paint instance')
console.log('RESULT: PASS the worker terrain setup passes a host field paint instance; an unpainted default leaves the height unchanged')
