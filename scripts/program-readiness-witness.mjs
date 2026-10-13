// Witness: pendingProgramCount() answers a real count of outstanding pipeline compilations on the
// common (TSL) renderer arm, and the boot wait it feeds -- whenProgramsReady() -- actually waits.
//
// The common arm is driven through three's OWN Pipelines and Info classes with a stub backend, so
// the number under test is read out of the same state three's own Pipelines.isReady() reads rather
// than out of an object this file could agree with by construction. Silence is not an acceptable
// failure mode: every import is guarded, every check is recorded, and the verdict prints from one
// place after the run, so a missing module reports itself as a named FAIL instead of an uncaught
// throw with empty stdout. The verdict is set with process.exitCode and never process.exit(),
// because process.exit() drops stdout still buffered in a pipe.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAG = '[program-readiness]'
const SOURCE = fileURLToPath(new URL('../client/core/ProgramReadiness.js', import.meta.url))
const BUDGET_MS = 200

const failures = []
const checks = []
const check = (label, ok, detail) => {
  checks.push(label)
  if (!ok) failures.push(detail || label)
}
const say = (line) => console.log(TAG + ' ' + line)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let Pipelines = null
let DataMap = null
let Info = null
let pendingProgramCount = null
let whenProgramsReady = null

try {
  ;({ default: Pipelines } = await import('three/src/renderers/common/Pipelines.js'))
  ;({ default: DataMap } = await import('three/src/renderers/common/DataMap.js'))
  ;({ default: Info } = await import('three/src/renderers/common/Info.js'))
  ;({ pendingProgramCount, whenProgramsReady } = await import('../client/core/ProgramReadiness.js'))
} catch (e) {
  failures.push('import failed: ' + (e && e.message ? e.message : String(e)))
}

// Only the four calls three's Pipelines makes of a backend. The async branch is the one that
// matters: it holds the GPU pipeline back until the creation settles, exactly as the real backend
// does, so a cache entry with no backend pipeline is a compilation still outstanding. Settling is
// driven by the witness rather than by a timer, so the never-settling arms leave no timer behind.
function stubBackend() {
  const backend = new DataMap()
  const outstanding = []
  const assignedAt = []
  const finish = (data, key) => {
    data.pipeline = { key }
    assignedAt.push(performance.now())
  }
  backend.assignedAt = assignedAt
  backend.getRenderCacheKey = (renderObject) => renderObject.key
  backend.needsRenderUpdate = () => false
  backend.createProgram = () => {}
  backend.createRenderPipeline = (renderObject, promises) => {
    const data = backend.get(renderObject.pipeline)
    if (promises === null) { finish(data, renderObject.key); return }
    promises.push(new Promise((resolve) => {
      outstanding.push(() => { finish(data, renderObject.key); resolve() })
    }))
  }
  backend.settle = async (ms) => {
    await sleep(ms)
    while (outstanding.length > 0) outstanding.shift()()
  }
  return backend
}

function commonArm() {
  const backend = stubBackend()
  const info = new Info()
  const pipelines = new Pipelines(backend, {}, info)
  return { renderer: { _pipelines: pipelines, info }, pipelines, info, backend }
}

function renderObject(key) {
  return { key, material: { name: key }, getNodeBuilderState: () => ({ vertexShader: 'vs:' + key, fragmentShader: 'fs:' + key }) }
}

function drawAsync(arm, n) {
  const objects = []
  for (let i = 0; i < n; i++) {
    const object = renderObject('obj' + i)
    objects.push(object)
    arm.pipelines.getForRender(object, [])
  }
  return objects
}

let asShippedField = 'unread'
let pendingFour = -1
let pendingAfterSettle = -1
let atStart = -1
let polledMax = -1
let waitPending = -1
let waitMs = -1
let workMs = -1
let budgetPending = -1
let budgetMs = -1
let legacyCount = -1
let legacyWait = -1
let legacyMs = -1

async function run() {
  if (pendingProgramCount === null || whenProgramsReady === null) return

  // --- the field the shipped reader read, on a real three Info --------------------------------
  const armA = commonArm()
  check("three's common Info carries no programs array", armA.info.programs === undefined,
    "three's common Info defines info.programs, so the premise of this row no longer holds")
  check('what it carries instead is a number under info.memory', typeof armA.info.memory.programs === 'number',
    'info.memory.programs is ' + typeof armA.info.memory.programs + ', not a number')
  asShippedField = String(armA.renderer.info && armA.renderer.info.programs)
  check('the field the shipped reader read is absent, so it answered 0 in every state',
    armA.renderer.info.programs === undefined,
    'the shipped reader had ' + asShippedField + ' to read, so this row is not the defect it claims')

  // --- the count is real ---------------------------------------------------------------------
  const four = drawAsync(armA, 4)
  pendingFour = pendingProgramCount(armA.renderer)
  const notReady = four.filter((o) => armA.pipelines.isReady(o) === false).length
  check('pendingProgramCount reads 4 outstanding of 4', pendingFour === 4,
    'pendingProgramCount read ' + pendingFour + ' with 4 compilations outstanding')
  check('it agrees with three isReady() on every render object', pendingFour === notReady,
    pendingFour + ' counted against ' + notReady + ' render object(s) three itself calls not ready')
  await armA.backend.settle(30)
  pendingAfterSettle = pendingProgramCount(armA.renderer)
  check('the count falls to 0 once every creation has settled', pendingAfterSettle === 0,
    'the count stayed at ' + pendingAfterSettle + ' after every creation settled')
  check('every render object is ready then', four.every((o) => armA.pipelines.isReady(o) === true),
    'a render object is still not ready after every creation settled')

  // --- whenProgramsReady actually waits ------------------------------------------------------
  const armB = commonArm()
  drawAsync(armB, 3)
  atStart = pendingProgramCount(armB.renderer)
  polledMax = 0
  const sampler = setInterval(() => { polledMax = Math.max(polledMax, pendingProgramCount(armB.renderer)) }, 8)
  const t0 = performance.now()
  const settling = armB.backend.settle(150)
  waitPending = await whenProgramsReady(armB.renderer, 5000)
  waitMs = performance.now() - t0
  clearInterval(sampler)
  await settling
  workMs = Math.max(...armB.backend.assignedAt) - t0
  check('the wait saw the outstanding work', atStart === 3,
    'at entry pendingProgramCount read ' + atStart + ', so the wait had nothing to wait for')
  check('the poller saw outstanding work while it waited', polledMax > 0,
    'every poll read 0, so the wait cannot have been waiting on these compilations')
  check('the wait resolved on the work finishing, not on its budget', waitPending === 0 && waitMs < 5000,
    'the wait resolved pending=' + waitPending + ' after ' + waitMs.toFixed(1) + 'ms, so it did not wait for the work')
  check('the wait did not return before the work it was waiting for finished', waitMs >= workMs - 2,
    'the wait returned after ' + waitMs.toFixed(1) + 'ms while the work finished at ' + workMs.toFixed(1) + 'ms, so it returned early')

  // --- the budget still bounds it -------------------------------------------------------------
  const armC = commonArm()
  drawAsync(armC, 2)
  const t1 = performance.now()
  budgetPending = await whenProgramsReady(armC.renderer, BUDGET_MS)
  budgetMs = performance.now() - t1
  check('a compilation that never settles is bounded by the budget', budgetPending === 2 && budgetMs >= BUDGET_MS - 12 && budgetMs < 5000,
    'the budget arm resolved pending=' + budgetPending + ' after ' + budgetMs.toFixed(1) + 'ms against a ' + BUDGET_MS + 'ms budget')

  // --- a creation three reported as failed is not outstanding work -----------------------------
  const armD = commonArm()
  const two = drawAsync(armD, 2)
  check('both creations start outstanding', pendingProgramCount(armD.renderer) === 2,
    'pendingProgramCount read ' + pendingProgramCount(armD.renderer) + ' with 2 compilations outstanding')
  armD.backend.get(two[0].pipeline).error = true
  check('a failed creation is not counted as outstanding', pendingProgramCount(armD.renderer) === 1,
    'the count still includes a creation three reported as failed, so boot would burn its budget on a shader that cannot compile')
  check('that object is still not ready, so the count is of outstanding work and not of unready objects',
    armD.pipelines.isReady(two[0]) === false,
    'the failed render object reads ready, so the two claims were not told apart')

  // --- the legacy GL arm is unchanged ----------------------------------------------------------
  const legacyPrograms = [{ isReady: () => false }, { isReady: () => true }, { isReady: () => false }]
  legacyCount = pendingProgramCount({ info: { programs: legacyPrograms } })
  check('the legacy arm still counts the programs not yet ready', legacyCount === 2,
    'the legacy arm read ' + legacyCount + ' of 3 programs, 2 of which are not ready')
  check('a legacy renderer with nothing outstanding reads 0',
    pendingProgramCount({ info: { programs: [{ isReady: () => true }] } }) === 0,
    'a legacy renderer whose only program is ready no longer reads 0')
  check('a renderer with no program list at all reads 0', pendingProgramCount({ info: {} }) === 0,
    'a renderer carrying no program list no longer reads 0')
  const lt = performance.now()
  legacyWait = await whenProgramsReady({ info: { programs: [{ isReady: () => true }] } }, 5000)
  legacyMs = performance.now() - lt
  check('the legacy arm still resolves at once when nothing is outstanding', legacyWait === 0 && legacyMs < 100,
    'the legacy arm took ' + legacyMs.toFixed(1) + 'ms to resolve ' + legacyWait + ', so it now waits')
  check('a renderer with both reads the pipeline cache, not the program array',
    pendingProgramCount({ _pipelines: armA.pipelines, info: { programs: legacyPrograms } }) === 0,
    'a renderer carrying both was read through the program array')

  // --- the source still carries both arms ------------------------------------------------------
  let src = ''
  try {
    src = readFileSync(SOURCE, 'utf8')
  } catch (e) {
    failures.push('client/core/ProgramReadiness.js unreadable: ' + (e && e.message ? e.message : String(e)))
    return
  }
  check('client/core/ProgramReadiness.js still reads the legacy programs array', /info\.programs/.test(src),
    'client/core/ProgramReadiness.js no longer reads info.programs, so the legacy arm was dropped')
  check('client/core/ProgramReadiness.js reads the live pipeline cache as well', /_pipelines/.test(src),
    'client/core/ProgramReadiness.js no longer reads _pipelines, so the common arm was dropped')
}

try {
  await run()
} catch (e) {
  failures.push('threw: ' + (e && e.message ? e.message : String(e)))
}

say('MEASURED common arm: info.programs=' + asShippedField + ' (as-shipped count 0) with ' + pendingFour +
  ' outstanding, fixed count ' + pendingFour + ', ' + pendingAfterSettle + ' after settle')
say('MEASURED wait: ' + atStart + ' outstanding at entry, polled max ' + polledMax + ', resolved pending=' +
  waitPending + ' after ' + waitMs.toFixed(1) + 'ms, work finished at ' + workMs.toFixed(1) + 'ms, budget arm ' +
  budgetMs.toFixed(1) + 'ms/pending=' + budgetPending)
say('MEASURED legacy arm: ' + legacyCount + ' of 3 programs not ready, resolved ' + legacyWait + ' in ' + legacyMs.toFixed(1) + 'ms')
say('RESULT: ' + (failures.length === 0 ? 'PASS' : 'FAIL') + ' (' + failures.length + ' failure(s) over ' + checks.length + ' check(s))')
for (const f of failures) say('[FAIL] ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
