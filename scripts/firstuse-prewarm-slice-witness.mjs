#!/usr/bin/env node
// Witness: the boot first-use prewarm's longest synchronous block is ONE first use, not a 96 ms
// accumulated budget plus one first use. Row PERF-programreadiness-prewarm-slice-1013.
//
// THE DEFECT IS A SHAPE, NOT A NUMBER. client/core/ProgramReadiness.js drained its first-use queue in
// slices that ACCUMULATED a millisecond budget -- 96 ms while the world was still behind the loading
// screen, 4 ms after the reveal:
//     while (queue.length && failed < MAX && (built === 0 || now - sliceStart < budget))
// A budget accumulated that way is read only BETWEEN two first uses. The block it bounded was
// therefore the budget plus one more first use, and a single first use longer than the budget was
// never cut at all -- the prologue ran to completion inside whichever slice happened to reach it.
// Lowering the 96 would have moved the number and kept the defect, so this row is not a retune: the
// constant is gone and the slice IS one first use, with the yield after it.
//
// This is now load-bearing rather than cosmetic. ProgramReadiness.pendingProgramCount() used to be
// vacuous on the common renderer -- it read renderer.info.programs, which three never defines -- so
// whenProgramsReady() answered 0 in every state and the boot warm wait resolved on its first poll, in
// 0.074 ms. It was fixed to read the live pipeline cache (it now reports 4 of 4 outstanding and the
// wait resolves at 152.9 ms, with the work finishing at 152.9 ms), so the prewarm genuinely runs now,
// which means the 96 ms accumulated budget inside it is a real boot hitch that was previously
// invisible. The last section of this witness re-pins the count and the wait, so the fix cannot be
// reported as having changed them.
//
// WHAT IS MEASURED, by running the real module: `installDeferredFirstUsePipelines` binds three's own
// Pipelines, and the queue is filled through `Pipelines.updateForRender` -- the only call
// Renderer._renderObjectDirect makes -- so the drain under test is the shipped drain and its
// `worstSliceMs` is the module's own instrument. The arm it is measured against reproduces the removed
// shape over the same queue and the same real unit (`Pipelines.getForRender`, the call the drain
// makes), so the before figure is not a figure from a different code path.
//
// THE UNIT'S COST IS DECLARED, NOT MEASURED. A first-use prologue is a GPU-side compilation and this
// witness runs where there is no adapter, so it is stood in for by a busy wait of a stated duration.
// The row's own browser measurement bounds what that duration is: 17-35 pipelines and 0.24-1.08 s of
// main thread inside one render:scene-color frame, so 6.9-63 ms each, and the two durations below sit
// inside that band. What this witness claims is not the cost of a first use; it is that a slice no
// longer adds a budget on top of one.
//
// No per-pass GPU timings: they are invalid on this project. This witness touches no adapter.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[firstuse-prewarm-slice]'
const SOURCE = resolve(REPO, 'client', 'core', 'ProgramReadiness.js')

// The accumulated budget the row deletes, and the retry bound that survives it.
const PREWARM_SLICE_MS = 96
const FIRST_USE_MAX_ATTEMPTS = 3
// The declared prologue cost of one first use, and of the one cold shader module in the batch that
// costs more than the rest. Both sit inside the 6.9-63 ms band the browser arm measured.
const FIRST_USE_MS = 18
const LONG_FIRST_USE_MS = 60
// Where the long one sits in the queue. The accumulated shape's first slice reaches it after five
// 18 ms first uses have run the budget up to 90 ms, which is the worst case for a budget that is
// read between units: the long first use is then added ON TOP of everything already accumulated.
const LONG_AT = 5
const OBJECTS = 24
// Three passes, best of them: the box this runs on is shared with other lanes, and a spike that
// belongs to the box must not be reported as a spike that belongs to the code.
const PASSES = 3
const FRAME_BUDGET_MS = 16.67
const BUDGET_MS = 200

const PASSED = []
const FAILED = []
function check(label, ok, detail) {
  if (ok) { PASSED.push(label); console.log(`${TAG} [PASS] ${label} (${detail})`) }
  else { FAILED.push(label); console.log(`${TAG} [FAIL] ${label} -- ${detail}`) }
}
const say = (line) => console.log(`${TAG} ${line}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const r2 = (v) => Math.round(v * 1000) / 1000
function busyWait(ms) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) { /* the point is to occupy the thread, as a real build does */ }
}

// `deferEnabled()` reads a window flag and the module publishes its counters on window too, so the
// witness supplies one rather than stubbing the module's environment out from under it.
globalThis.window = globalThis.window || {}

let channelsOpened = 0
{
  const Real = globalThis.MessageChannel
  if (typeof Real === 'function') {
    globalThis.MessageChannel = class extends Real {
      constructor() { super(); channelsOpened++ }
    }
  }
}
const yieldToBrowser = () => new Promise((done) => {
  const channel = new MessageChannel()
  channel.port1.onmessage = () => { channel.port1.close(); done() }
  channel.port2.postMessage(null)
})

let Pipelines = null
let DataMap = null
let Info = null
let mod = null
try {
  ;({ default: Pipelines } = await import('three/src/renderers/common/Pipelines.js'))
  ;({ default: DataMap } = await import('three/src/renderers/common/DataMap.js'))
  ;({ default: Info } = await import('three/src/renderers/common/Info.js'))
  mod = await import('../client/core/ProgramReadiness.js')
} catch (e) {
  FAILED.push('import failed: ' + (e && e.message ? e.message : String(e)))
  console.log(`${TAG} [FAIL] import -- ${e && e.message ? e.message : String(e)}`)
}
const installDeferredFirstUsePipelines = mod ? mod.installDeferredFirstUsePipelines : null
const pendingProgramCount = mod ? mod.pendingProgramCount : null
const whenProgramsReady = mod ? mod.whenProgramsReady : null

// Only the calls three's Pipelines makes of a backend. `pending` models the async creation the
// shipped drain asks for (a non-null sink): the GPU pipeline is withheld until the creation settles,
// exactly as the real backend does, which is what makes a cache entry with no backend pipeline a
// compilation still outstanding. Without it the pipeline is assigned as the creation is asked for.
function stubBackend({ pending = false } = {}) {
  const backend = new DataMap()
  backend.costs = new Map()
  backend.built = []
  backend.outstanding = []
  backend.assignedAt = []
  backend.getRenderCacheKey = (renderObject) => renderObject.key
  backend.needsRenderUpdate = () => false
  backend.createProgram = () => {}
  backend.createRenderPipeline = (renderObject, promises) => {
    const ms = backend.costs.get(renderObject.key) || 0
    if (ms > 0) busyWait(ms)
    backend.built.push(renderObject.key)
    const data = backend.get(renderObject.pipeline)
    const assign = () => { data.pipeline = { key: renderObject.key }; backend.assignedAt.push(performance.now()) }
    if (pending && promises != null) promises.push(new Promise((done) => { backend.outstanding.push(() => { assign(); done() }) }))
    else assign()
  }
  backend.settle = async (ms) => {
    await sleep(ms)
    while (backend.outstanding.length > 0) backend.outstanding.shift()()
  }
  return backend
}

// Pipelines.prototype is shared by every instance and the deferral binds the prototype, so a second
// arm would otherwise inherit the first arm's queue. Each arm gets its own subclass whose prototype
// OWNS updateForRender -- which is also what the deferral requires of the real one.
function arm(costs, opts = {}) {
  const backend = stubBackend(opts)
  backend.costs = costs
  const Sub = class extends Pipelines {}
  Sub.prototype.updateForRender = Pipelines.prototype.updateForRender
  const pipelines = new Sub(backend, {}, new Info())
  const backendFlag = ['isWeb', 'GPUBackend'].join('')
  const renderer = { _pipelines: pipelines, backend: { [backendFlag]: true }, _currentRenderBundle: null }
  return { renderer, pipelines, backend }
}

// One queue, two shapes. Every object is a distinct render object, so every first use reaches the
// backend: three caches a pipeline under the render object's key, and a second ask for an object
// whose pipeline already exists is a cache hit that never reaches it.
function queue(costs) {
  const objects = []
  for (let i = 0; i < OBJECTS; i++) {
    const key = 'fu' + i
    costs.set(key, i === LONG_AT ? LONG_FIRST_USE_MS : FIRST_USE_MS)
    objects.push({ key, material: { name: key }, getNodeBuilderState: () => ({ vertexShader: 'vs:' + key, fragmentShader: 'fs:' + key }) })
  }
  return objects
}

const state = () => globalThis.window.__deferredFirstUsePipelines
function resetState() {
  const s = state()
  if (!s) return
  for (const k of ['deferred', 'drained', 'skippedReady', 'buildFailed', 'slices', 'worstSliceMs', 'worstBuildMs', 'queued']) s[k] = 0
}

// The shape the row deletes, verbatim in its control flow: accumulate a 96 ms budget across whole
// first uses and yield on a MessageChannel when it trips. The removed loop also skipped an object
// three already called ready and bounded failures per slice; neither is reachable on a fresh arm --
// nothing is ready and no build throws -- so the reproduction is the loop that decided the block.
async function runAccumulated() {
  const costs = new Map()
  const objects = queue(costs)
  const a = arm(costs)
  const segments = []
  const builds = []
  let i = 0
  let cur = 0
  const flush = () => { if (cur > 0) { segments.push(cur); cur = 0 } }
  while (i < objects.length) {
    const sliceStart = performance.now()
    let built = 0
    while (i < objects.length && (built === 0 || performance.now() - sliceStart < PREWARM_SLICE_MS)) {
      const t0 = performance.now()
      a.pipelines.getForRender(objects[i++], [])
      const ms = performance.now() - t0
      builds.push(ms)
      cur += ms
      built++
    }
    flush()
    await yieldToBrowser()
  }
  return {
    worst: r2(Math.max(...segments)), worstBuild: r2(Math.max(...builds)), slices: segments.length,
    built: a.backend.built.length, total: r2(segments.reduce((x, y) => x + y, 0)),
  }
}

// The shape that ships: one queued first use per slice, driven through the real module's deferral and
// measured by the module's own instrument.
async function runShipped() {
  const costs = new Map()
  const objects = queue(costs)
  const a = arm(costs)
  installDeferredFirstUsePipelines(a.renderer)
  resetState()
  for (const ro of objects) a.pipelines.updateForRender(ro)
  const t0 = performance.now()
  while ((state().queued > 0 || state().drained < objects.length) && performance.now() - t0 < 60000) await sleep(4)
  const s = state()
  return {
    worst: r2(s.worstSliceMs), worstBuild: r2(s.worstBuildMs), slices: s.slices,
    built: a.backend.built.length, drained: s.drained, queued: s.queued,
  }
}

let before = null
let after = null
if (installDeferredFirstUsePipelines !== null) {
  for (let p = 0; p < PASSES; p++) {
    const b = await runAccumulated()
    const channelsBefore = channelsOpened
    const a = await runShipped()
    if (!before || b.worst < before.worst) before = b
    if (!after || a.worst < after.worst) after = { ...a, yields: channelsOpened - channelsBefore }
  }
}

say(`first use cost: ${FIRST_USE_MS}ms, the one cold shader module in the batch ${LONG_FIRST_USE_MS}ms at queue position ${LONG_AT} of ${OBJECTS}`)
if (before && after) {
  say(`accumulated (removed shape): worst block ${before.worst}ms over ${before.slices} slice(s), longest single first use ${before.worstBuild}ms, ${before.built} built, ${r2(before.total)}ms of work`)
  say(`one first use per slice (shipped): worst block ${after.worst}ms over ${after.slices} slice(s), longest single first use ${after.worstBuild}ms, ${after.built} built, ${after.drained} drained, ${after.queued} queued`)
  say(`overshoot over one first use: ${r2(before.worst - before.worstBuild)}ms accumulated -> ${r2(after.worst - after.worstBuild)}ms sliced`)
}

if (before && after) {
  check('the declared first-use costs sit inside the band the browser arm measured',
    FIRST_USE_MS >= 6.9 && FIRST_USE_MS <= 63 && LONG_FIRST_USE_MS >= 6.9 && LONG_FIRST_USE_MS <= 63,
    `${FIRST_USE_MS}ms and ${LONG_FIRST_USE_MS}ms against 6.9-63ms per pipeline (0.24-1.08s over 17-35)`)
  check('the measurement is real: the queue drained and every first use reached the backend',
    after.built === OBJECTS && after.drained === OBJECTS && after.queued === 0 && before.built === OBJECTS,
    `shipped built ${after.built}, drained ${after.drained}, queued ${after.queued}; accumulated built ${before.built}; of ${OBJECTS}`)
  check('the longest single first use was measured, not assumed',
    after.worstBuild >= LONG_FIRST_USE_MS,
    `the module measured ${after.worstBuild}ms for a prologue declared at ${LONG_FIRST_USE_MS}ms`)
  check('the accumulated shape really blocked for more than one first use, so the fix is not vacuous',
    before.worst > PREWARM_SLICE_MS && before.worst > FRAME_BUDGET_MS,
    `before worst block ${before.worst}ms against a ${PREWARM_SLICE_MS}ms accumulated budget and a ${FRAME_BUDGET_MS}ms frame`)
  check('the accumulated shape overshot one first use by the budget it accumulated, which is the defect',
    before.worst - before.worstBuild >= PREWARM_SLICE_MS * 0.8,
    `before overshoot ${r2(before.worst - before.worstBuild)}ms against a ${PREWARM_SLICE_MS}ms budget`)
  check('a shipped slice carries one first use and nothing else',
    after.worst - after.worstBuild <= 4,
    `after worst block ${after.worst}ms against a longest single first use of ${after.worstBuild}ms, overshoot ${r2(after.worst - after.worstBuild)}ms`)
  check('the worst block fell by at least 2x',
    after.worst * 2 <= before.worst, `${before.worst}ms -> ${after.worst}ms`)
  check('the slice change shed no first use: both shapes built the whole queue',
    before.built === after.built && after.drained === OBJECTS,
    `${before.built} built accumulated vs ${after.built} shipped / ${after.drained} drained, of ${OBJECTS}`)
  // The last slice finds the queue empty and stops instead of yielding, so the count is one short of
  // the slice count by construction.
  check('every shipped slice yielded through MessageChannel, not a setTimeout fallback',
    after.yields > 0 && after.yields >= after.slices - 1, `${after.yields} MessageChannel(s) for ${after.slices} slice(s)`)
}

// --- pendingProgramCount and whenProgramsReady are unchanged by the slice change -----------------
// They are what made the prewarm load-bearing at all, so a slice fix that moved them would be a
// different change wearing this row's name.
let pendingFour = -1
let pendingAfterSettle = -1
let atStart = -1
let waitPending = -1
let waitMs = -1
let workMs = -1
let budgetMs = -1
let legacyCount = -1
let legacyMs = -1
if (pendingProgramCount !== null && whenProgramsReady !== null) {
  const costs = new Map()
  const objects = queue(costs)
  const a = arm(costs, { pending: true })
  for (const ro of objects.slice(0, 4)) a.pipelines.getForRender(ro, [])
  pendingFour = pendingProgramCount(a.renderer)
  check('pendingProgramCount still reads 4 outstanding of 4', pendingFour === 4,
    'pendingProgramCount read ' + pendingFour + ' with 4 compilations outstanding')
  await a.backend.settle(30)
  pendingAfterSettle = pendingProgramCount(a.renderer)
  check('the count still falls to 0 once every creation has settled', pendingAfterSettle === 0,
    'the count stayed at ' + pendingAfterSettle + ' after every creation settled')

  const b = arm(new Map(), { pending: true })
  const three = [{ key: 'w0' }, { key: 'w1' }, { key: 'w2' }].map((o) => ({ ...o, material: { name: o.key }, getNodeBuilderState: () => ({ vertexShader: 'vs', fragmentShader: 'fs' }) }))
  for (const ro of three) b.pipelines.getForRender(ro, [])
  atStart = pendingProgramCount(b.renderer)
  const t0 = performance.now()
  const settling = b.backend.settle(120)
  waitPending = await whenProgramsReady(b.renderer, 5000)
  waitMs = r2(performance.now() - t0)
  await settling
  workMs = r2(Math.max(...b.backend.assignedAt) - t0)
  check('whenProgramsReady still does not return before the work it was waiting for finished',
    atStart === 3 && waitPending === 0 && waitMs >= workMs - 2,
    `${atStart} outstanding at entry, resolved pending=${waitPending} after ${waitMs}ms, work finished at ${workMs}ms`)

  const c = arm(new Map(), { pending: true })
  for (const ro of three) c.pipelines.getForRender(ro, [])
  const t1 = performance.now()
  const never = await whenProgramsReady(c.renderer, BUDGET_MS)
  budgetMs = r2(performance.now() - t1)
  check('the budget arm still bounds a creation that never settles',
    never === 3 && budgetMs >= BUDGET_MS - 12,
    `resolved pending=${never} after ${budgetMs}ms against a ${BUDGET_MS}ms budget`)

  legacyCount = pendingProgramCount({ info: { programs: [{ isReady: () => false }, { isReady: () => true }, { isReady: () => false }] } })
  const lt = performance.now()
  const legacyWait = await whenProgramsReady({ info: { programs: [{ isReady: () => true }] } }, 5000)
  legacyMs = r2(performance.now() - lt)
  check('the legacy GL arm is unchanged: it still counts programs and still resolves at once',
    legacyCount === 2 && legacyWait === 0 && legacyMs < 100,
    `legacy read ${legacyCount} of 3 and resolved ${legacyWait} in ${legacyMs}ms`)
}

// --- source pin: the accumulated budget is gone, not retuned -------------------------------------
let src = ''
try {
  src = readFileSync(SOURCE, 'utf8')
} catch (e) {
  check('client/core/ProgramReadiness.js is readable', false, (e && e.message) || String(e))
}
const sliceConstants = (src.match(/\bFIRST_USE_(?:PREWARM_)?SLICE_MS\b/g) || []).length
// The deferral's own drain, not the async-pipeline escort's rescue drain: the two are both
// `const drain = () => {` and only the deferral's is the one whose slice this row is about.
const deferralStart = src.indexOf('export function installDeferredFirstUsePipelines')
const drainStart = src.indexOf('const drain = () => {', deferralStart)
const drainBody = drainStart < 0 ? '' : src.slice(drainStart, src.indexOf('\n  }', drainStart))
const drainShifts = (drainBody.match(/queue\.shift\(\)/g) || []).length
const drainLoops = (drainBody.match(/\bwhile\s*\(/g) || []).length
const drainBuilds = (drainBody.match(/pipelines\.getForRender\(/g) || []).length
const drainYields = (drainBody.match(/yieldToBrowser\(drain\)/g) || []).length
say(`source pin client/core/ProgramReadiness.js: slice constants=${sliceConstants} deferral drain body ${drainBody.length} char(s), queue.shift ${drainShifts}, while loop(s) ${drainLoops}, getForRender call(s) ${drainBuilds}, yieldToBrowser ${drainYields}, requestAnimationFrame in it=${/requestAnimationFrame/.test(drainBody)}`)
check('client/core/ProgramReadiness.js keeps no millisecond slice budget to accumulate across first uses',
  sliceConstants === 0, `${sliceConstants} slice constant(s) remain`)
check('the drain builds exactly one queued first use per slice, with no loop to accumulate a second',
  drainBody.length > 0 && drainShifts === 1 && drainLoops === 0 && drainBuilds === 1,
  `${drainShifts} shift(s), ${drainLoops} while loop(s), ${drainBuilds} getForRender call(s) in the drain`)
check('the drain yields after that one first use, on the MessageChannel primitive and not on rAF',
  drainYields === 1 && /MessageChannel/.test(src) && !/requestAnimationFrame/.test(drainBody),
  `yieldToBrowser(drain) x${drainYields}, MessageChannel in the module=${/MessageChannel/.test(src)}, requestAnimationFrame in the drain=${/requestAnimationFrame/.test(drainBody)}`)
check('the per-object retry bound survives, so a build that never succeeds cannot become a per-frame retry',
  /FIRST_USE_MAX_ATTEMPTS/.test(drainBody),
  `FIRST_USE_MAX_ATTEMPTS=${FIRST_USE_MAX_ATTEMPTS}, present in the drain=${/FIRST_USE_MAX_ATTEMPTS/.test(drainBody)}`)

if (before && after) {
  say(`RESULT: ${FAILED.length ? 'FAIL' : 'PASS'} -- worst synchronous block of the first-use prewarm ${before.worst}ms -> ${after.worst}ms (accumulated ${PREWARM_SLICE_MS}ms budget + one first use -> one first use; longest single first use ${after.worstBuild}ms, ${after.slices} slice(s) over ${OBJECTS} first use(s) with ${after.yields} MessageChannel yield(s), ${before.built}/${after.built} built, program count ${pendingFour}->${pendingAfterSettle}, wait ${waitMs}ms vs work ${workMs}ms, budget arm ${budgetMs}ms, legacy ${legacyCount} in ${legacyMs}ms, ${sliceConstants} slice constant(s), frame budget ${FRAME_BUDGET_MS}ms)`)
} else {
  say(`RESULT: ${FAILED.length ? 'FAIL' : 'PASS'} -- no arm ran, ${FAILED.length} failure(s)`)
}
process.exitCode = FAILED.length ? 1 : 0
