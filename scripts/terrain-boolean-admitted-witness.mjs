#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const TAG = '[terrain-boolean-boundary]'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const srcUrl = p => pathToFileURL(resolve(ROOT, p)).href

const { parseWorld, assertWorld, WorldResolveError } = await import(srcUrl('src/shared/worldResolve.js'))
const { parseTerrainConfig, resolveTerrainConfig } = await import(srcUrl('src/shared/terrainConfig.js'))

const failures = []
function expect (cond, msg) {
  if (cond) return true
  failures.push(msg)
  console.error(`${TAG} assertion failed: ${msg}`)
  return false
}

const REFUSAL = 'must be a terrain config object, false or null: true declares no terrain config and no terrain consumer parses it'

const rTrue = parseWorld({ name: 'w6', terrain: true })
expect(rTrue.ok === false, `parseWorld({terrain:true}).ok is ${rTrue.ok}, expected false`)
expect(rTrue.path === 'terrain', `refusal path is ${JSON.stringify(rTrue.path)}, expected "terrain"`)
expect(rTrue.code === 'world-field-invalid', `refusal code is ${JSON.stringify(rTrue.code)}, expected "world-field-invalid"`)
expect(rTrue.reason === REFUSAL, `refusal reason is ${JSON.stringify(rTrue.reason)}, expected the terrain-union refusal`)

let thrown = null
try { assertWorld({ name: 'w6', terrain: true }) } catch (e) { thrown = e }
expect(thrown instanceof WorldResolveError, `assertWorld did not throw WorldResolveError (got ${thrown && thrown.name})`)
expect(thrown instanceof TypeError, 'WorldResolveError is not a TypeError')
expect(thrown?.code === 'world-field-invalid', `thrown code is ${JSON.stringify(thrown?.code)}, expected "world-field-invalid"`)
expect(thrown?.path === 'terrain', `thrown path is ${JSON.stringify(thrown?.path)}, expected "terrain"`)
expect(thrown?.worldName === 'w6', `thrown worldName is ${JSON.stringify(thrown?.worldName)}, expected "w6"`)
console.log(`${TAG} refusal message: ${thrown?.message}`)

const CANDIDATES = [
  undefined, null, false, true,
  {}, { seed: 1, radius: 100 }, { bakedHeightfield: '/apps/world/tps-game.hf' }, { seed: 0, radius: 4000, reliefScale: 1 },
  1, 'x', [], [1, 2],
]
let admitted = 0
const admittedLabels = []
for (const v of CANDIDATES) {
  const world = { name: 'w', terrain: v }
  const r = parseWorld(world)
  const label = JSON.stringify(v) ?? 'undefined'
  if (!r.ok) {
    expect(r.path === 'terrain', `terrain=${label} refused on path ${JSON.stringify(r.path)}, expected "terrain"`)
    continue
  }
  admitted++
  admittedLabels.push(label)
  const resolved = resolveTerrainConfig(world)
  const parsed = parseTerrainConfig(resolved)
  expect(resolved === null || parsed.ok === true, `terrain=${label} accepted by the boundary but parseTerrainConfig(resolveTerrainConfig(world)) answered ok=${parsed.ok} reason=${JSON.stringify(parsed.reason)}`)
  if (parsed.ok) expect(parsed.config.hashVersion === 2, `terrain=${label} parsed hashVersion is ${parsed.config && parsed.config.hashVersion}, expected 2`)
}
console.log(`${TAG} candidates=${CANDIDATES.length} admitted=${admitted} refused=${CANDIDATES.length - admitted}`)
const EXPECTED_ADMITTED = ['undefined', 'null', 'false', '{}', '{"seed":1,"radius":100}', '{"bakedHeightfield":"/apps/world/tps-game.hf"}', '{"seed":0,"radius":4000,"reliefScale":1}']
expect(JSON.stringify(admittedLabels) === JSON.stringify(EXPECTED_ADMITTED), `admitted set is ${JSON.stringify(admittedLabels)}, expected ${JSON.stringify(EXPECTED_ADMITTED)}`)

for (const [label, v] of [['undefined', undefined], ['null', null], ['false', false], ['empty', {}], ['seeded', { seed: 1, radius: 100 }]]) {
  expect(parseWorld({ name: 'w', terrain: v }).ok === true, `parseWorld(terrain=${label}).ok is false, a documented union member regressed`)
}
for (const v of [1, 'x', [], [1, 2]]) {
  expect(parseWorld({ name: 'w', terrain: v }).ok === false, `parseWorld(terrain=${JSON.stringify(v)}).ok is true, a non-object terrain was admitted`)
}
expect(resolveTerrainConfig({ terrain: false }) === null, 'resolveTerrainConfig(terrain:false) is not null, the documented disable regressed')
expect(resolveTerrainConfig({ terrain: true }) === true, 'resolveTerrainConfig(terrain:true) is not true: the consumer-side fact this row pins moved, the refusal belongs to the boundary')

if (failures.length === 0) {
  console.log(`${TAG} RESULT: PASS`)
  process.exit(0)
}
console.log(`${TAG} RESULT: FAIL (${failures.length} assertion(s))`)
process.exit(1)
