import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { AppRuntime } = await import('../src/apps/AppRuntime.js')
const { MSG } = await import('../src/protocol/MessageTypes.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const MISSING = './apps/maps/witness-missing-convex.glb'
const PRESENT = './node_modules/@dgreenheck/ez-tree/src/app/public/rock1.glb'
const ENTITY = 'convex-1'

async function convexBuild(model) {
  const runtime = new AppRuntime()
  const broadcasts = []
  runtime._physics = { addBody: () => 7, removeBody: () => {}, addStaticTrimeshAsync: () => Promise.reject(new Error('unused')) }
  runtime._connections = { broadcast: (type, payload) => broadcasts.push({ type, payload }) }
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    runtime.spawnEntity(ENTITY, { model, bodyType: 'static', position: [0, 0, 0] })
    runtime.changeBodyType(ENTITY, 'dynamic')
    await runtime.waitForPendingTrimeshBuilds(4000)
  } finally {
    console.warn = warn
    console.error = error
  }
  return { runtime, broadcasts, entity: runtime.entities.get(ENTITY) }
}

function refusalOf(runtime) {
  if (typeof runtime.assertTrimeshBuildsClean !== 'function') return { missing: true }
  try {
    runtime.assertTrimeshBuildsClean()
    return { threw: false }
  } catch (error) {
    return { threw: true, error }
  }
}

const failed = await convexBuild(MISSING)
const failures = failed.runtime._trimeshBuildFailures
check('a failed convex build is recorded on the runtime, not swallowed', Array.isArray(failures) && failures.length === 1, Array.isArray(failures) ? `count=${failures.length}` : 'not recorded')
check('a failed convex build leaves the entity without a collider', failed.entity && failed.entity.collider === null, failed.entity ? JSON.stringify(failed.entity.collider) : 'no entity')
check('a failed convex build names convex as the collider kind that failed', failed.entity && failed.entity._failedColliderType === 'convex', failed.entity ? String(failed.entity._failedColliderType) : 'no entity')

const refusal = refusalOf(failed.runtime)
check('assertTrimeshBuildsClean refuses a failed convex build', refusal.threw === true, refusal.missing ? 'method missing' : refusal.threw ? '' : 'no throw')
check('the refusal is a ColliderBuildError', refusal.threw && refusal.error.name === 'ColliderBuildError', refusal.threw ? refusal.error.name : '')
check('the refusal names the model whose convex build failed', refusal.threw && refusal.error.message.includes(MISSING), refusal.threw ? refusal.error.message.slice(0, 200) : '')

const reported = failed.broadcasts.filter(b => b.type === MSG.EDITOR_ERROR && b.payload?.entityId === ENTITY && String(b.payload?.message || '').includes('convex'))
check('the failed convex build is reported to the editor for its entity', reported.length === 1, `editor errors=${reported.length}`)

const passing = await convexBuild(PRESENT)
const passingEntity = passing.entity
check('a successful convex build is not recorded as a failure', passing.runtime._trimeshBuildFailures.length === 0, `count=${passing.runtime._trimeshBuildFailures.length}`)
check('a successful convex build keeps its convex collider', passingEntity && passingEntity.collider && passingEntity.collider.type === 'convex', passingEntity ? JSON.stringify(passingEntity.collider) : 'no entity')
check('a successful convex build does not refuse boot', refusalOf(passing.runtime).threw === false)
check('a successful convex build reports no editor error', passing.broadcasts.length === 0, `broadcasts=${passing.broadcasts.length}`)

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a failed convex trimesh build is recorded, refused at boot as a ColliderBuildError naming the model, and reported to the editor, and a successful convex build is none of these')
  await exitAfterQuiesce(0)
}
