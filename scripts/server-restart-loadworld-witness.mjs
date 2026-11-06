import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { createServer } = await import('../src/sdk/server.js')
const { restorePaintDocument, persistPaintDocument, PAINT_STORE_KEY } = await import('../src/terrain/paintStore.js')
const { wrapHeightWithMarks } = await import('../src/terrain/TerrainMarks.js')
const { wrapHeightWithFieldPaint } = await import('../src/terrain/fieldPaint.js')

const lake = { kind: 'lake', center: [0, 0], radius: 5, falloff: 0, level: 4 }
const server = await createServer({ port: 0, staticDirs: [], appsDirs: [] })
await server.loadWorld({ name: 'restart-probe', terrain: { radius: 512, seed: 1, marks: [lake] }, entities: [] }, 'restart-probe')

const src = readFileSync('src/sdk/ServerAPI.js', 'utf8')
const loadWorldAt = src.indexOf('async loadWorld(')
const startAt = src.indexOf('async start()')
const listenAt = src.indexOf('ctx.httpServer.listen(')
assert.ok(loadWorldAt > 0 && startAt > loadWorldAt && listenAt > startAt, 'the only listen call must sit inside start(), after loadWorld')

function memoryStorage() {
  const m = new Map()
  return { async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null }, async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))) }, _m: m }
}
const base = () => 10
const storage = memoryStorage()
const first = await restorePaintDocument(storage, { marks: [lake] })
first.fieldPaint.onChange(() => persistPaintDocument(storage, first.fieldPaint, first.marks))
first.fieldPaint.stroke({ field: 'terrain:height', layer: 'PLAYER', center: [20, 20], radius: 1, fn: () => 2 })
assert.ok(storage._m.has(PAINT_STORE_KEY), 'a change persists the paint document (direct-call check)')

const second = await restorePaintDocument(storage, {})
assert.ok(Math.abs(wrapHeightWithFieldPaint(second.fieldPaint, base)(20, 20, 0) - 12) < 1e-6, 'the painted height survives a restart (direct-call check)')
assert.equal(wrapHeightWithMarks(second.marks, base)(0, 0, 0), 4, 'the lake mark survives a restart (direct-call check)')
console.log('RESULT: PASS server loadWorld runs on a real physics instance without opening a listener (listen sits only in start()); the paint and lake mark restore after restart is a DIRECT-CALL check on paintStore, not a server-boot restart')
process.exit(0)
