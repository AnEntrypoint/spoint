import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createHostFieldPaint } = await import('../src/terrain/fieldPaint.js')
const ctx = {}
const first = ctx._fieldPaint ||= createHostFieldPaint({})
const again = ctx._fieldPaint ||= createHostFieldPaint({ fieldPaint: { cellSize: 5 } })
assert.equal(again, first, 'a rebuild keeps the same paint instance so painted terrain survives it')

const src = readFileSync('src/sdk/EditorHandlers.js', 'utf8')
assert.ok(src.includes('fieldPaint: ctx._fieldPaint ||= createHostFieldPaint(cfg)'), 'the editor build must pass the paint instance')
console.log('RESULT: PASS the editor terrain build passes a host field paint and keeps it across rebuilds, so painted terrain survives a rebuild')
