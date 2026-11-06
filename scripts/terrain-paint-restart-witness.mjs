import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { restorePaintDocument, persistPaintDocument, PAINT_STORE_KEY } = await import('../src/terrain/paintStore.js')
const { wrapHeightWithMarks } = await import('../src/terrain/TerrainMarks.js')
const { wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')

function memoryStorage() {
  const m = new Map()
  return { async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null }, async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))) }, _m: m }
}
const base = () => 10
const lake = { kind: 'lake', center: [0, 0], radius: 5, falloff: 0, level: 4 }
const storage = memoryStorage()

// First run: no saved document, the config carries the marks, a stroke is made and saved.
const first = await restorePaintDocument(storage, { marks: [lake] })
assert.equal(first.marks.length, 1)
first.fieldPaint.onChange(() => persistPaintDocument(storage, first.fieldPaint, first.marks))
first.fieldPaint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [20, 20], radius: 1, fn: () => 2 })
assert.ok(storage._m.has(PAINT_STORE_KEY), 'a change persists the paint document')

// Restart: a new run with no marks in config reads the paint and the marks back.
const second = await restorePaintDocument(storage, {})
assert.ok(Math.abs(wrapHeightWithFieldPaint(second.fieldPaint, base)(20, 20, 0) - 12) < 1e-6, 'the painted height survives a restart')
assert.equal(wrapHeightWithMarks(second.marks, base)(0, 0, 0), 4, 'the lake mark survives a restart and still lowers the centre')
assert.equal(wrapHeightWithMarks(second.marks, base)(50, 50, 0), 10, 'outside the lake the base height is kept after restart')

// Config marks win over stored ones.
const third = await restorePaintDocument(storage, { marks: [{ ...lake, level: 1 }] })
assert.equal(wrapHeightWithMarks(third.marks, base)(0, 0, 0), 1, 'config marks override stored marks')

// A malformed stored document refuses loudly.
const bad = memoryStorage()
await bad.set(PAINT_STORE_KEY, { nope: true })
await assert.rejects(() => restorePaintDocument(bad, {}), e => /malformed/.test(e.message))

const src = readFileSync('src/sdk/ServerAPI.js', 'utf8')
assert.ok(src.includes('restorePaintDocument(storage, _tcfg)'), 'the server host must restore the paint document from world storage')
assert.ok(src.includes('fieldPaint.onChange('), 'the server host must save the paint document on each change')
console.log('RESULT: PASS the server host restores the terrain paint and marks from world storage on start and saves on each change: a painted height and a lake mark survive a restart, config marks override stored ones, and a malformed document refuses')
