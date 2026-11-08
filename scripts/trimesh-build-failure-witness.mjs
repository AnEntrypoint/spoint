import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()
const { AppRuntime } = await import('../src/apps/AppRuntime.js')

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const MODEL = 'props/witness-gate.glb'

async function buildWith(addStaticTrimeshAsync) {
  const runtime = new AppRuntime()
  runtime._physics = { addStaticTrimeshAsync }
  const warn = console.warn
  const error = console.error
  console.warn = () => {}
  console.error = () => {}
  try {
    runtime.spawnEntity('gate-1', { model: MODEL, bodyType: 'static', position: [0, 0, 0], autoTrimesh: true })
    await runtime.waitForPendingTrimeshBuilds(2000)
  } finally {
    console.warn = warn
    console.error = error
  }
  return runtime
}

const asserts = (runtime) => {
  if (typeof runtime.assertTrimeshBuildsClean !== 'function') return { threw: false, missing: true }
  try {
    runtime.assertTrimeshBuildsClean()
    return { threw: false, missing: false }
  } catch (error) {
    return { threw: true, error, missing: false }
  }
}

const failed = await buildWith(() => Promise.reject(new Error('gltf parse failed')))
const refusal = asserts(failed)
check('a failed static trimesh build is refused by assertTrimeshBuildsClean', refusal.threw && !refusal.missing, refusal.missing ? 'method missing' : refusal.threw ? refusal.error.message.slice(0, 120) : 'no throw')
check('the refusal is a ColliderBuildError', refusal.threw && refusal.error.name === 'ColliderBuildError', refusal.threw ? refusal.error.name : '')
check('the refusal names the model whose build failed', refusal.threw && refusal.error.message.includes(MODEL), refusal.threw ? refusal.error.message.slice(0, 160) : '')

const clean = await buildWith(() => Promise.resolve(7))
const passing = asserts(clean)
check('a successful static trimesh build does not refuse', !passing.threw && !passing.missing, passing.threw ? passing.error.message.slice(0, 120) : '')

const failures = failed._trimeshBuildFailures
check('a failed build is recorded on the runtime, not dropped', Array.isArray(failures) && failures.length === 1, Array.isArray(failures) ? `count=${failures.length}` : 'not recorded')

const failedEntity = failed.entities.get('gate-1')
check('a failed build still leaves the entity without a collider, as before', failedEntity && failedEntity.collider === null, failedEntity ? JSON.stringify(failedEntity.collider) : 'no entity')

const failedCount = checks.filter((c) => !c.ok).length
console.log(`${checks.length - failedCount}/${checks.length} checks passed`)
if (failedCount) {
  console.log(`RESULT: FAIL ${failedCount} check(s): ${checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log('RESULT: PASS a failed static trimesh build is recorded and refused as a ColliderBuildError naming the model, and a successful build is not')
  await exitAfterQuiesce(0)
}
