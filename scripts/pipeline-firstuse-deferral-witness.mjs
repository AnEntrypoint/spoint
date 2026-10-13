// Witness: the frame that FIRST needs a render object must not be the frame that builds it.
//
// The class this kills: three mints a render pipeline inside `Pipelines.updateForRender`, which
// `Renderer._renderObjectDirect` calls on the draw path. Everything in that prologue is synchronous
// and has no async form -- the TSL node graph build, the shader module for both stages, every bind
// group layout and the pipeline layout -- so a batch of newly streamed scenery lands the whole
// prologue of every one of its objects in a single frame. `installAsyncRenderPipelines` moves only
// the last step off the draw path; `installDeferredFirstUsePipelines` moves the first use itself.
//
// Node-runnable, no adapter: three's OWN Pipelines and DataMap drive the deferral against a stub
// backend that records what the draw path asked for, so the property under test is read out of the
// same state three's own Pipelines.isReady() reads. Silence is not an acceptable failure mode:
// every import is guarded, every check is recorded, and the verdict prints from one place after the
// run, so a missing module reports itself as a named FAIL instead of an uncaught throw with empty
// stdout. The verdict is set with process.exitCode and never process.exit(), because process.exit()
// drops stdout still buffered in a pipe.
const YIELD_MS = 30

const failures = []
const checks = []
const check = (label, ok, detail) => {
  checks.push(label)
  console.log(`${ok === true ? '[PASS]' : '[FAIL]'} ${label}`)
  if (ok !== true) failures.push(detail || label)
}
const say = (line) => console.log(line)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let Pipelines = null
let DataMap = null
let Info = null
let installDeferredFirstUsePipelines = null
let endPipelinePrewarm = null

try {
  ;({ default: Pipelines } = await import('three/src/renderers/common/Pipelines.js'))
  ;({ default: DataMap } = await import('three/src/renderers/common/DataMap.js'))
  ;({ default: Info } = await import('three/src/renderers/common/Info.js'))
  ;({ installDeferredFirstUsePipelines, endPipelinePrewarm } = await import('../client/core/ProgramReadiness.js'))
} catch (e) {
  failures.push('import failed: ' + (e && e.message ? e.message : String(e)))
}

// `deferEnabled()` reads a window flag and the module exposes its counters on window too, so the
// witness supplies one rather than stubbing the module's environment out from under it.
globalThis.window = globalThis.window || {}

function busyWait(ms) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) { /* the point is to occupy the thread, as a real build does */ }
}

// Only the calls three's Pipelines makes of a backend. `built` is the record the whole witness
// turns on: a pipeline created while nothing is draining is a pipeline built on the draw path.
function stubBackend({ buildMs = 0, throwOnBuild = false, uniqueKeys = false } = {}) {
  let keySeq = 0
  const backend = new DataMap()
  backend.built = []
  // three caches a pipeline under this key BEFORE asking the backend for it, so a stable key makes
  // the second attempt a cache hit that never reaches the backend. Unique keys are what let this
  // witness see all three attempts of a prologue that never succeeds.
  backend.getRenderCacheKey = (renderObject) => (uniqueKeys ? renderObject.key + '#' + ++keySeq : renderObject.key)
  backend.needsRenderUpdate = () => false
  backend.createProgram = () => {}
  backend.createRenderPipeline = (renderObject, promises) => {
    if (buildMs > 0) busyWait(buildMs)
    if (throwOnBuild) throw new Error('shader validation failed for ' + renderObject.key)
    const hook = backend.onFirstBuild
    if (hook) { backend.onFirstBuild = null; hook() }
    backend.built.push(renderObject.key)
    // Assigning here models an async creation that has already resolved: what the deferral has to
    // prove is WHEN the build is asked for, not how long an adapter takes to answer.
    backend.get(renderObject.pipeline).pipeline = { key: renderObject.key }
    if (promises !== null && promises !== undefined) promises.push(Promise.resolve())
  }
  return backend
}

// Pipelines.prototype is shared by every instance, and the deferral binds the prototype, so a
// second arm would otherwise inherit the first arm's queue. Each arm gets its own subclass whose
// prototype OWNS updateForRender -- which is also what the deferral requires of the real one.
function arm(opts) {
  const backend = stubBackend(opts)
  const Sub = class extends Pipelines {}
  Sub.prototype.updateForRender = Pipelines.prototype.updateForRender
  const pipelines = new Sub(backend, {}, new Info())
  const backendFlag = ['isWeb', 'GPUBackend'].join('')
  const renderer = { _pipelines: pipelines, backend: { [backendFlag]: true }, _currentRenderBundle: null }
  return { renderer, pipelines, backend }
}

function renderObject(key) {
  return { key, material: { name: key }, getNodeBuilderState: () => ({ vertexShader: 'vs:' + key, fragmentShader: 'fs:' + key }) }
}

const state = () => globalThis.window.__deferredFirstUsePipelines
const snapshot = () => (state() ? { ...state() } : null)

async function run() {
  if (installDeferredFirstUsePipelines === null) return

  // --- a first use on the draw path builds nothing --------------------------------------------
  const a = arm()
  const installed = installDeferredFirstUsePipelines(a.renderer)
  check('the deferral binds three\'s own Pipelines', installed === true,
    'installDeferredFirstUsePipelines returned ' + installed + ' against a real Pipelines instance')
  const roA = renderObject('objA')
  // This is the exact call Renderer._renderObjectDirect makes, and it is its only caller.
  a.pipelines.updateForRender(roA)
  check('a first use on the draw path builds nothing', a.backend.built.length === 0,
    'the draw path built ' + a.backend.built.length + ' pipeline(s): ' + a.backend.built.join(', '))
  check('and the object is not drawn yet, because three isReady() reads false', a.pipelines.isReady(roA) === false,
    'isReady() read true for an object whose pipeline was never built')
  check('the first use was deferred instead', state() && state().deferred === 1,
    'deferred counter reads ' + (state() ? state().deferred : 'no state exposed on window'))

  // --- the drain builds it off the draw path ---------------------------------------------------
  await sleep(YIELD_MS)
  check('the drain builds it off the draw path', a.backend.built.length === 1 && a.pipelines.isReady(roA) === true,
    'after a yield the drain had built ' + a.backend.built.length + ' pipeline(s) and isReady() read ' + a.pipelines.isReady(roA))
  check('nothing is left stranded in the queue', state().queued === 0,
    state().queued + ' object(s) are still queued after the drain ran')

  // --- a prologue longer than the slice cannot starve the queue --------------------------------
  // endPipelinePrewarm is what takes the slice down to its steady-state size, so this arm also
  // pins that the boot slice and the steady slice are different budgets.
  endPipelinePrewarm()
  const b = arm({ buildMs: 12 })
  installDeferredFirstUsePipelines(b.renderer)
  const beforeB = snapshot()
  const roB = [renderObject('objB0'), renderObject('objB1'), renderObject('objB2')]
  for (const ro of roB) b.pipelines.updateForRender(ro)
  await sleep(300)
  const afterB = snapshot()
  const slicesB = afterB.slices - beforeB.slices
  say('slow arm: ' + slicesB + ' slice(s), ' + (afterB.drained - beforeB.drained) + ' drained, worst slice ' + afterB.worstSliceMs.toFixed(2) + 'ms, worst single first use ' + afterB.worstBuildMs.toFixed(2) + 'ms')
  check('a prologue longer than the slice cannot starve the queue', b.backend.built.length === 3 && afterB.queued === 0,
    'a 12ms prologue against a 4ms slice built ' + b.backend.built.length + ' of 3 and left ' + afterB.queued + ' queued')
  check('it costs one slice each, so N first uses never sum into one slice', slicesB >= 3,
    'the drain used ' + slicesB + ' slice(s) for 3 over-budget prologue(s), so a batch summed into one')
  check('the worst single first use is measured, not assumed', afterB.worstBuildMs >= 12,
    'worst single first use reads ' + afterB.worstBuildMs.toFixed(2) + 'ms for a prologue that costs 12ms')

  // --- a first use that arrives mid-drain is still drained --------------------------------------
  const c = arm({ buildMs: 8 })
  installDeferredFirstUsePipelines(c.renderer)
  const roC0 = renderObject('objC0')
  const roC1 = renderObject('objC1')
  // The second object is enqueued from inside the first one's build, which is the only moment the
  // drain is provably mid-slice: the queue is being consumed while a new first use arrives.
  c.backend.onFirstBuild = () => { c.pipelines.updateForRender(roC1) }
  c.pipelines.updateForRender(roC0)
  await sleep(300)
  check('an object enqueued mid-drain is still drained', c.backend.built.includes('objC0') && c.backend.built.includes('objC1'),
    'the drain built ' + c.backend.built.join(', ') + ' and left ' + state().queued + ' queued')
  check('and the drain finishes, rather than looping forever', state().queued === 0,
    state().queued + ' object(s) left queued after a mid-drain enqueue')

  // --- a ready object is never deferred --------------------------------------------------------
  const d = arm()
  installDeferredFirstUsePipelines(d.renderer)
  const roD = renderObject('objD')
  d.pipelines.updateForRender(roD)
  await sleep(YIELD_MS)
  const builtBefore = d.backend.built.length
  const deferredBefore = state().deferred
  // The second call is what a steady frame does for a visible object, every frame.
  d.pipelines.updateForRender(roD)
  check('a ready object is never deferred', d.backend.built.length === builtBefore && state().deferred === deferredBefore,
    'a ready object went back through the deferral: deferred ' + deferredBefore + ' -> ' + state().deferred)

  // --- the reproduction switch puts it back on the draw path ------------------------------------
  globalThis.window.__spointDeferFirstUse = false
  const e = arm()
  installDeferredFirstUsePipelines(e.renderer)
  const roE = renderObject('objE')
  e.pipelines.updateForRender(roE)
  check('the reproduction switch puts a first use back on the draw path', e.backend.built.length === 1,
    'with __spointDeferFirstUse=false the draw path built ' + e.backend.built.length + ' pipeline(s), so the switch cannot reproduce the stall')
  globalThis.window.__spointDeferFirstUse = undefined

  // --- a build that never succeeds cannot become a per-frame retry ------------------------------
  const h = arm({ throwOnBuild: true, uniqueKeys: true })
  installDeferredFirstUsePipelines(h.renderer)
  const beforeH = snapshot()
  h.pipelines.updateForRender(renderObject('objH'))
  await sleep(300)
  const afterH = snapshot()
  say('failing arm: ' + (afterH.buildFailed - beforeH.buildFailed) + ' failed, ' + afterH.queued + ' queued')
  check('a build that never succeeds stops being retried', afterH.queued === 0 && afterH.buildFailed - beforeH.buildFailed === 3,
    'a throwing prologue was attempted ' + (afterH.buildFailed - beforeH.buildFailed) + ' time(s) and left ' + afterH.queued + ' queued')
  check('and it never reaches the draw path while it fails', h.backend.built.length === 0,
    'the draw path built ' + h.backend.built.length + ' pipeline(s) for a prologue that throws')

  // --- a bundle being encoded is never deferred -------------------------------------------------
  // A render bundle is encoded once and replayed forever, so an object left out of it is missing
  // for good; it has no later frame to be caught up on.
  const g = arm()
  installDeferredFirstUsePipelines(g.renderer)
  g.renderer._currentRenderBundle = {}
  const roG = renderObject('objG')
  g.pipelines.updateForRender(roG)
  check('an object inside a render bundle is built where it is asked for', g.backend.built.length === 1,
    'a bundle being encoded deferred its object, so that object is missing from the bundle for good')

  // --- it refuses to bind where it has not been measured ----------------------------------------
  const f = arm()
  f.renderer.backend = { isWebGPUBackend: false }
  check('it refuses to bind a backend it has never measured', installDeferredFirstUsePipelines(f.renderer) === false,
    'it bound a renderer whose backend is not the one this file measured')
  check('and an absent Pipelines is refused too', installDeferredFirstUsePipelines({ backend: { isWebGPUBackend: true } }) === false,
    'it bound a renderer with no _pipelines')
}

await run()
console.log(`RESULT: ${failures.length === 0 ? 'PASS' : 'FAIL'} -- ${checks.length} check(s), ${failures.length} failure(s)`)
if (failures.length > 0) for (const f of failures) console.log('  FAIL ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
