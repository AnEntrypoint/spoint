import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { AppRuntime } = await import('../src/apps/AppRuntime.js')
const { StageLoader } = await import('../src/stage/StageLoader.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const sorted = ids => [...ids].map(String).sort()
const same = (got, want) => JSON.stringify(sorted(got)) === JSON.stringify(sorted(want))
const show = v => JSON.stringify(v)
const throwsTypeError = fn => { try { fn(); return null } catch (error) { return error instanceof TypeError ? error : null } }

const CENTRE = [0, 0, 0]
const ENTITIES = [
  ['origin', [0, 0, 0]],
  ['east', [10, 0, 0]],
  ['far', [60, 0, 0]],
  ['beyond', [500, 0, 0]],
]
const RELEVANCE = 200

function buildRuntime(withLoader) {
  const runtime = new AppRuntime()
  if (withLoader) {
    const loader = new StageLoader({})
    loader.loadFromDefinition('no-loader-radius', { relevanceRadius: RELEVANCE, entities: [] })
    runtime.setStageLoader(loader)
  }
  for (const [id, position] of ENTITIES) runtime.spawnEntity(id, { position })
  return runtime
}

const origin = ENTITIES.map(([id]) => id)

for (const withLoader of [false, true]) {
  const label = withLoader ? 'with a stage loader (control)' : 'with no stage loader'
  const runtime = buildRuntime(withLoader)

  const zeroNearby = runtime.nearbyEntities(CENTRE, 0)
  check(`${label}: nearbyEntities with a zero radius returns only the entity at the centre`, same(zeroNearby, ['origin']), `got ${show(zeroNearby)}`)
  const zeroRelevant = runtime.relevantEntities(CENTRE, 0)
  check(`${label}: relevantEntities with a zero radius returns only the entity at the centre`, same(zeroRelevant, ['origin']), `got ${show(zeroRelevant)}`)

  const positiveNearby = runtime.nearbyEntities(CENTRE, 20)
  check(`${label}: nearbyEntities with a 20 m radius returns the entities within 20 m`, same(positiveNearby, ['origin', 'east']), `got ${show(positiveNearby)}`)
  const positiveRelevant = runtime.relevantEntities(CENTRE, 20)
  check(`${label}: relevantEntities with a 20 m radius returns the entities within 20 m`, same(positiveRelevant, ['origin', 'east']), `got ${show(positiveRelevant)}`)

  const absentNearby = runtime.nearbyEntities(CENTRE)
  check(`${label}: nearbyEntities with an absent radius returns the default relevance ring, not the whole world`, same(absentNearby, ['origin', 'east', 'far']), `got ${show(absentNearby)}`)
  const absentRelevant = runtime.relevantEntities(CENTRE)
  check(`${label}: relevantEntities with an absent radius returns the default relevance ring, not the whole world`, same(absentRelevant, ['origin', 'east', 'far']), `got ${show(absentRelevant)}`)

  const nanError = throwsTypeError(() => runtime.nearbyEntities(CENTRE, NaN))
  check(`${label}: nearbyEntities refuses a NaN radius with a TypeError`, nanError !== null, nanError ? nanError.message.slice(0, 90) : `returned ${show(runtime.nearbyEntities(CENTRE, NaN))}`)
}

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS a runtime with no stage loader answers the relevance queries with the same radius semantics as one with a loader: zero, positive, absent and NaN radii (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
