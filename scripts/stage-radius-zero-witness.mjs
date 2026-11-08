import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { Stage } = await import('../src/stage/Stage.js')
const { StageLoader } = await import('../src/stage/StageLoader.js')
const { AppRuntime } = await import('../src/apps/AppRuntime.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}
const sorted = ids => [...ids].map(String).sort()
const same = (got, want) => JSON.stringify(sorted(got)) === JSON.stringify(sorted(want))
const show = v => JSON.stringify(v)
const throwsTypeError = fn => { try { fn(); return null } catch (error) { return error instanceof TypeError ? error : null } }

const RELEVANCE = 100
const stage = new Stage('zero-radius-witness', { relevanceRadius: RELEVANCE })
stage.spatial.insert('origin', [0, 0, 0])
stage.spatial.insert('east', [10, 0, 0])
stage.spatial.insert('far', [60, 0, 0])

const CENTRE = [0, 0, 0]

check('a zero radius to getRelevantEntities returns only the entity at the centre', same(stage.getRelevantEntities(CENTRE, 0), ['origin']), `got ${show(stage.getRelevantEntities(CENTRE, 0))}`)
check('a zero radius to getNearbyEntities returns only the entity at the centre', same(stage.getNearbyEntities(CENTRE, 0), ['origin']), `got ${show(stage.getNearbyEntities(CENTRE, 0))}`)
check('a zero radius to getRelevantEntitiesHorizontal returns only the entity at the centre', same(stage.getRelevantEntitiesHorizontal(CENTRE, 0), ['origin']), `got ${show(stage.getRelevantEntitiesHorizontal(CENTRE, 0))}`)
check('a zero radius to getRelevantEntitiesForCell returns only the entity at the centre', same(stage.getRelevantEntitiesForCell(CENTRE, 0), ['origin']), `got ${show(stage.getRelevantEntitiesForCell(CENTRE, 0))}`)
check('a zero radius gives a zero-radius relevance ring', stage.relevanceRing(0).radius === 0, `got radius ${show(stage.relevanceRing(0).radius)}`)

check('an absent radius to getRelevantEntities still means the relevance ring', same(stage.getRelevantEntities(CENTRE), ['origin', 'east', 'far']), `got ${show(stage.getRelevantEntities(CENTRE))}`)
check('an explicit undefined radius still means the relevance ring', same(stage.getRelevantEntities(CENTRE, undefined), ['origin', 'east', 'far']))
check('a null radius still means the relevance ring', same(stage.getRelevantEntities(CENTRE, null), ['origin', 'east', 'far']))
check('an absent radius to getRelevantEntitiesHorizontal still means the relevance ring', same(stage.getRelevantEntitiesHorizontal(CENTRE), ['origin', 'east', 'far']))
check('an absent radius gives the relevance ring radius', stage.relevanceRing().radius === RELEVANCE, `got ${show(stage.relevanceRing().radius)}`)

const nanError = throwsTypeError(() => stage.getRelevantEntities(CENTRE, NaN))
check('a NaN radius is refused with a TypeError, not replaced by the relevance ring', nanError !== null, nanError ? nanError.message.slice(0, 100) : `returned ${show(stage.getRelevantEntities(CENTRE, NaN))}`)
const negativeError = throwsTypeError(() => stage.getRelevantEntities(CENTRE, -1))
check('a negative radius is refused with a TypeError', negativeError !== null)

const loader = new StageLoader({})
loader.loadFromDefinition('zero-radius-witness', { relevanceRadius: RELEVANCE, entities: [] })
loader._activeStage.spatial.insert('origin', [0, 0, 0])
loader._activeStage.spatial.insert('east', [10, 0, 0])
const runtime = new AppRuntime()
runtime.setStageLoader(loader)

check('an app asking for a zero radius through the runtime gets only the entity at the centre', same(runtime.nearbyEntities(CENTRE, 0), ['origin']), `got ${show(runtime.nearbyEntities(CENTRE, 0))}`)
check('the runtime relevance query with a zero radius gets only the entity at the centre', same(runtime.relevantEntities(CENTRE, 0), ['origin']), `got ${show(runtime.relevantEntities(CENTRE, 0))}`)
check('the runtime with an absent radius still gets the relevance ring', same(runtime.nearbyEntities(CENTRE), ['origin', 'east']), `got ${show(runtime.nearbyEntities(CENTRE))}`)

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS a zero radius is a zero radius through the stage, its shapes and the runtime, an absent radius is the relevance ring, and a NaN or negative radius is refused (${checks.length} checks)`)
  await exitAfterQuiesce(0)
}
