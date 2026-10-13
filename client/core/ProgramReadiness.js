const READY_POLL_MS = 16

export function renderDeferringUnreadyPrograms(renderer, scene, camera) {
  const prev = renderer.deferUnreadyPrograms
  renderer.deferredProgramDraws = renderer.deferredProgramDraws || 0
  renderer.deferUnreadyPrograms = true
  try { renderer.render(scene, camera) } finally { renderer.deferUnreadyPrograms = prev }
}

export function runWarmPasses(renderPass, passes = 2) {
  const attempted = Math.max(0, passes | 0)
  let succeeded = 0
  let error = null
  for (let i = 0; i < attempted; i++) {
    try {
      renderPass()
      succeeded++
    } catch (e) {
      if (!error) error = e instanceof Error ? e : new Error(String(e))
    }
  }
  return { attempted, succeeded, failed: attempted - succeeded, error }
}

// three's common renderer -- the TSL path, on either backend -- keeps no `info.programs` at all:
// common/Info.js counts programs as a NUMBER under `info.memory`, so the reader below used to read
// `undefined` and answer 0 for every state the renderer could be in. What the common renderer does
// keep is the live Pipelines object, and its isReady() reads exactly one thing: whether the backend
// has assigned a GPU pipeline yet. An async creation assigns it when it resolves and nowhere else,
// so a cache entry whose backend holds no pipeline is a compilation still outstanding.
function pendingPipelineCount(pipelines) {
  const caches = pipelines.caches
  const backend = pipelines.backend
  if (!caches || !backend || typeof backend.get !== 'function') return 0
  let n = 0
  for (const pipeline of caches.values()) {
    const data = backend.get(pipeline)
    if (data.pipeline !== undefined && data.pipeline !== null) continue
    // A creation three has already reported as failed is finished however it finished: three
    // re-latches the error from its own popErrorScope callback and nothing assigns a pipeline
    // afterwards, so counting it would spend the whole boot budget on a shader that cannot compile.
    if (data.error === true) continue
    n++
  }
  return n
}

// Reproduction switch, not a tuning knob: `window.__spointProgramReadinessVacuous = true` restores
// the reader this file shipped with -- it skips the pipeline cache and falls through to
// `info.programs`, which the common renderer never defines, so it answers 0 in every state and the
// boot warm wait resolves on its first poll. It is what lets one witness measure the wait's cost
// against the pre-fix behaviour on the same box and the same bundle.
function vacuousProgramReadiness() {
  return typeof window !== 'undefined' && window.__spointProgramReadinessVacuous === true
}

export function pendingProgramCount(renderer) {
  const pipelines = vacuousProgramReadiness() ? null : renderer && renderer._pipelines
  if (pipelines) return pendingPipelineCount(pipelines)
  const programs = renderer && renderer.info && renderer.info.programs
  if (!programs) return 0
  let n = 0
  for (const p of programs) if (typeof p.isReady === 'function' && !p.isReady()) n++
  return n
}

// The warm wait's own cost, published where a boot witness can read it: what was outstanding when
// the wait was entered, how long the wait itself took, and what was still outstanding when it gave
// up. Without it the wait is invisible -- it is neither a mark nor a console line -- so its cost
// could not be told apart from the rest of the boot.
const warmWait = { calls: 0, pendingAtStart: null, waitedMs: null, resolvedPending: null, vacuous: false, maxWaitMs: null }

function recordWarmWait(pendingAtStart, waitedMs, resolvedPending, maxWaitMs) {
  warmWait.calls++
  warmWait.pendingAtStart = pendingAtStart
  warmWait.waitedMs = waitedMs
  warmWait.resolvedPending = resolvedPending
  warmWait.vacuous = vacuousProgramReadiness()
  warmWait.maxWaitMs = maxWaitMs
  if (typeof window !== 'undefined') window.__programReadinessWait = { ...warmWait }
}

export function whenProgramsReady(renderer, maxWaitMs) {
  const t0 = performance.now()
  const pendingAtStart = pendingProgramCount(renderer)
  return new Promise((resolve) => {
    const poll = () => {
      const pending = pendingProgramCount(renderer)
      const waitedMs = performance.now() - t0
      if (pending === 0) { recordWarmWait(pendingAtStart, waitedMs, 0, maxWaitMs); resolve(0); return }
      if (waitedMs >= maxWaitMs) {
        console.warn(`[shader] ${pending} program(s) still compiling after ${maxWaitMs}ms`)
        recordWarmWait(pendingAtStart, waitedMs, pending, maxWaitMs)
        resolve(pending)
        return
      }
      setTimeout(poll, READY_POLL_MS)
    }
    poll()
  })
}

// ---------------------------------------------------------------------------
// WebGPU: keep render pipeline creation off the draw path.
//
// three mints a render pipeline synchronously inside Renderer._renderObjectDirect -- Pipelines
// .updateForRender -> getForRender -> backend.createRenderPipeline -> device.createRenderPipeline --
// the first time a render object is drawn. Scenery streams in batches, so a batch of newly visible
// objects compiles every one of its pipelines inside a single frame's render() call; measured at
// 17-35 pipelines and 0.24-1.08s of main thread in one render:scene-color frame while walking.
//
// three already carries the remedy and already wires it into the draw path:
//   - Renderer._renderObjectDirect only draws when this._pipelines.isReady( renderObject );
//   - Pipelines.isReady() is false exactly while a pipeline is still compiling asynchronously;
//   - a pipeline only compiles asynchronously when getForRender() is handed a non-null `promises`
//     array, which selects device.createRenderPipelineAsync() over device.createRenderPipeline().
//     Before this file, Renderer.compileAsync() was the only caller that handed one over; the draw
//     path now does too, so both callers are in play and both need the escort below.
//
// So the fix is to hand the render path a promises sink too: creation leaves the main thread's
// critical path and the object is simply not drawn for the frames until its pipeline resolves. This
// sheds no quality and widens no distance band -- the same objects draw, a frame or two later.
//
// THE PROPERTY THAT HAS TO HOLD AS WELL. An async creation that never produces a pipeline is not
// "a frame or two later", it is never: three assigns the backend's pipeline from the awaited
// creation and from nowhere else, so a creation that yields no pipeline leaves `isReady()` false
// for the life of the process and `_renderObjectDirect` skips that render object on every frame
// after it. The synchronous path cannot do that -- `device.createRenderPipeline` always returns a
// pipeline object -- so the async path is the only one that can strand an object. Every request
// therefore gets a bounded escort, and if the object is STILL not ready when it fires the pipeline
// is created synchronously. That keeps both properties: the compile stays off the draw path for
// every pipeline that resolves on its own, and no object can be left permanently undrawn by one
// that does not.
//
// Two details that decide whether the escort is a fix or a second copy of the stall:
//
//   * it covers BOTH callers, not just the draw path. `Renderer.compileAsync()` is the other
//     caller that hands getForRender() a promises array, and client/app.js warms the whole scene
//     through it; escorting only the draw path leaves every warmed-up object strippable.
//   * a rescue is a synchronous `device.createRenderPipeline`, and N of those in one frame is
//     exactly the stall this file exists to remove (measured: 17-35 pipelines and 0.24-1.08s of
//     main thread inside a single render:scene-color frame). Rescues are therefore drained ONE
//     PER FRAME, so the stranding is bounded -- one frame per stranded object -- without ever
//     putting a batch of compiles back on the draw path.
// ---------------------------------------------------------------------------
const ASYNC_PIPELINE_ESCORT_MS = 1500

const asyncPipelineState = {
  installed: false, requested: 0, resolved: 0, rejected: 0, pending: 0,
  escorted: 0, rescued: 0, rescueFailed: 0, dropped: 0,
}

// Reproduction switch, not a tuning knob: `window.__spointAsyncPipelineEscort = false` turns the
// escort off, which is exactly the behaviour this file had before the escort existed. It is what
// lets a witness show the stranding against shipped bytes instead of against a rebuilt bundle --
// a fix whose failure mode cannot be reproduced is a fix that cannot be shown to be the fix.
function escortEnabled() {
  return typeof window === 'undefined' || window.__spointAsyncPipelineEscort !== false
}

export function installAsyncRenderPipelines(renderer) {
  const pipelines = renderer && renderer._pipelines
  if (!pipelines) return false
  const proto = Object.getPrototypeOf(pipelines)
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'getForRender') : null
  if (!desc || typeof desc.value !== 'function') return false
  if (desc.value.__spointAsyncRenderPipelines === true) { asyncPipelineState.installed = true; return true }
  const orig = desc.value

  const rescueNow = (renderObject) => {
    asyncPipelineState.escorted++
    const pipeline = pipelines.get(renderObject).pipeline
    // three drops a render object's DataMap entry when the object goes away, and isReady() then
    // reads false forever. Those objects are not in the draw set at all, so there is nothing to
    // rescue; creating a pipeline for one is a wasted compile.
    if (pipeline === undefined) { asyncPipelineState.dropped++; return }
    // WebGPUBackend.draw() returns early, for the life of the process, once pipelineData.error is
    // true -- and the failed creation this rescue is answering is exactly what set it. So
    // assigning a pipeline is not enough on its own: the latch has to come off too, or the object
    // is ready and still never drawn. (A shader that fails validation for real re-latches it in
    // the popErrorScope callback, which is correct: an invalid shader cannot draw.)
    const pipelineData = pipelines.backend.get(pipeline)
    try {
      pipelineData.error = false
      pipelines.backend.createRenderPipeline(renderObject, null)
      pipelineData.error = false
    } catch (e) {
      asyncPipelineState.rescueFailed++
      return
    }
    if (pipelines.isReady(renderObject)) asyncPipelineState.rescued++
    else asyncPipelineState.rescueFailed++
  }

  const nextFrame = (fn) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn)
    else setTimeout(fn, 16)
  }
  const rescueQueue = []
  const queued = new Set()
  let draining = false
  const drain = () => {
    const renderObject = rescueQueue.shift()
    if (renderObject) {
      queued.delete(renderObject)
      if (!pipelines.isReady(renderObject)) rescueNow(renderObject)
    }
    if (rescueQueue.length > 0) nextFrame(drain)
    else draining = false
  }

  const rescue = (renderObject) => {
    if (!escortEnabled()) return
    // A render object three has dropped is not one three would draw, so it is not one that is
    // stranded -- isReady() reads false for it and there is nothing to put right.
    if (pipelines.get(renderObject).pipeline === undefined) return
    if (pipelines.isReady(renderObject)) return
    if (queued.has(renderObject)) return
    queued.add(renderObject)
    rescueQueue.push(renderObject)
    if (draining) return
    draining = true
    nextFrame(drain)
  }

  const escort = (promise, renderObject) => {
    asyncPipelineState.requested++
    asyncPipelineState.pending++
    let settled = false
    let timer = 0
    const done = (failed) => {
      settled = true
      clearTimeout(timer)
      asyncPipelineState.pending--
      if (failed) asyncPipelineState.rejected++
      else asyncPipelineState.resolved++
      // The promise is not the thing that can strand the object: three's own promise always
      // resolves, even when the creation it escorted rejected. isReady() is.
      rescue(renderObject)
    }
    timer = setTimeout(() => { if (!settled) rescue(renderObject) }, ASYNC_PIPELINE_ESCORT_MS)
    Promise.resolve(promise).then(() => done(false), () => done(true))
  }

  const wrapped = function (renderObject, promises) {
    // `compileAsync` brings its own array and awaits it; the draw path brings none. Either way
    // three assigns the backend's pipeline from the awaited creation and from nowhere else, so an
    // unescorted async creation leaves isReady() false forever -- on the draw path OR in the
    // whole-scene compileAsync warm-up client/app.js runs. So both are escorted, and only the
    // promises this call added are: a caller's array already holds the earlier ones.
    const sink = promises == null ? [] : promises
    const from = sink.length
    const out = orig.call(this, renderObject, sink)
    for (let i = from; i < sink.length; i++) escort(sink[i], renderObject)
    return out
  }
  wrapped.__spointAsyncRenderPipelines = true
  // Kept so a witness can restore the un-wrapped original and re-measure the stall this removes.
  // A fix that cannot be reverted cannot be shown to be what changed the measurement.
  wrapped.__spointOriginalGetForRender = orig
  Object.defineProperty(proto, 'getForRender', { value: wrapped, writable: true, configurable: true })
  asyncPipelineState.installed = true
  // The async sink only moves the LAST step. Binding the deferral here as well is what keeps the
  // rest of a first use -- node graph build, createShaderModule, the layouts -- out of the frame
  // that needs it, and it is bound from here so the two halves cannot be installed apart.
  installDeferredFirstUsePipelines(renderer)
  if (typeof window !== 'undefined') window.__asyncRenderPipelines = asyncPipelineState
  return true
}

export function takeDeferredDraws(renderer) {
  const n = renderer.deferredProgramDraws || 0
  renderer.deferredProgramDraws = 0
  renderer.lastDeferredDraws = n
  return n
}

// ---------------------------------------------------------------------------
// WebGPU: the frame that FIRST needs a render object must not be the frame that builds it.
//
// installAsyncRenderPipelines moves the LAST step of a first use -- device.createRenderPipeline --
// off the draw path. Everything three does before that step is still synchronous and still inside
// the frame: the TSL node graph build, device.createShaderModule for both stages, every
// createBindGroupLayout and the createPipelineLayout. Those have no async form, so a batch of
// newly streamed scenery still lands the whole prologue of every one of its objects in one frame.
//
// three's draw path already answers "not yet" for free: `Renderer._renderObjectDirect` calls
// `Pipelines.updateForRender(renderObject)` and then only draws when
// `Pipelines.isReady(renderObject)`, and isReady() reads false while `get(renderObject).pipeline`
// is undefined. `updateForRender` has exactly one caller in three -- that draw path -- so not
// calling it is a complete answer: the object is not drawn this frame and nothing is built.
//
// So the frame that first needs an object now enqueues it instead of building it, and a drain
// builds queued objects off the draw path in bounded slices, yielding on a MessageChannel so the
// browser can present a frame between slices. N first uses can no longer sum into one frame; the
// most a steady frame can carry is one first use.
//
// Two properties hold by construction, not by tuning:
//   * a queued object is drained to ready whether or not anything is rendering -- the drain
//     reschedules itself on a MessageChannel until the queue is empty, so it cannot strand an
//     object the way an unanswered async creation can;
//   * a drain slice always builds at least one object, so a prologue longer than the slice cannot
//     starve the queue.
//
// THE SLICE IS ONE FIRST USE, and that is a shape rather than a number. This drain used to carry a
// millisecond budget -- 96 ms while the world was still behind the loading screen, 4 ms after the
// reveal -- and to accumulate it ACROSS first uses:
//     while (queue.length && failed < MAX && (built === 0 || now - sliceStart < budget))
// A budget accumulated that way is read only BETWEEN two first uses, so the block it bounded was the
// budget plus one more first use, and a single first use longer than the budget was never cut at all
// -- the prologue ran to completion inside whichever slice happened to reach it. Lowering the
// constant would have moved the number and kept the defect, so the constant is gone instead: a slice
// builds one queued object and then yields, and the yield sits after that object rather than after a
// budget.
//
// One first use is the smallest piece available, because there is no phase inside one to yield
// between: the node graph build, both shader modules, every bind group layout and the pipeline layout
// are synchronous in three and have no async form. So the block the main thread takes is one
// prologue, which is the floor, instead of one prologue plus everything the budget let in beside it.
// ---------------------------------------------------------------------------
const FIRST_USE_MAX_ATTEMPTS = 3

const firstUseState = {
  installed: false, prewarm: true, deferred: 0, drained: 0, skippedReady: 0,
  buildFailed: 0, slices: 0, worstSliceMs: 0, worstBuildMs: 0, queued: 0,
}

function yieldToBrowser(fn) {
  if (typeof MessageChannel === 'undefined') { setTimeout(fn, 0); return }
  const channel = new MessageChannel()
  channel.port1.onmessage = () => { channel.port1.close(); fn() }
  channel.port2.postMessage(null)
}

// Reproduction switch, not a tuning knob: `window.__spointDeferFirstUse = false` puts every first
// use back on the draw path, which is exactly the behaviour before this deferral existed. It is
// what lets one witness measure both arms against the same bundle and the same box.
function deferEnabled() {
  return typeof window === 'undefined' || window.__spointDeferFirstUse !== false
}

export function endPipelinePrewarm() {
  firstUseState.prewarm = false
}

export function installDeferredFirstUsePipelines(renderer) {
  const pipelines = renderer && renderer._pipelines
  // Scoped to the WebGPU backend: the row this answers is the TSL/WGSL one, and the legacy path
  // compiles a different program model that this file has never measured.
  if (!pipelines || !renderer.backend || renderer.backend.isWebGPUBackend !== true) return false
  const proto = Object.getPrototypeOf(pipelines)
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'updateForRender') : null
  if (!desc || typeof desc.value !== 'function') return false
  if (desc.value.__spointDeferredFirstUse === true) { firstUseState.installed = true; return true }
  const orig = desc.value

  const queue = []
  const queued = new Set()
  const attempts = new Map()
  let draining = false

  const drain = () => {
    // `prewarm` is the boot/steady-state marker a boot witness reads off firstUseState. It sized the
    // slice once; it no longer does, because there is no slice left to size -- only the one first use
    // the slice now is.
    if (firstUseState.prewarm && typeof window !== 'undefined' && window.__app && window.__app.revealedAt) firstUseState.prewarm = false
    const sliceStart = performance.now()
    // ONE first use, then out. The budget this slice used to accumulate is gone on purpose: it was
    // read only between two first uses, so what it bounded was the budget plus one more first use,
    // and a prologue longer than the budget was never cut. The slice is the first use instead, so the
    // block is the prologue and the yield sits after it.
    const renderObject = queue.shift()
    queued.delete(renderObject)
    firstUseState.queued = queue.length
    if (pipelines.isReady(renderObject)) {
      firstUseState.skippedReady++
    } else {
      const attempt = (attempts.get(renderObject) || 0) + 1
      attempts.set(renderObject, attempt)
      const t0 = performance.now()
      let built = true
      try {
        // A non-null sink is what selects createRenderPipelineAsync over createRenderPipeline, and
        // installAsyncRenderPipelines escorts everything added to it.
        pipelines.getForRender(renderObject, [])
      } catch (e) {
        built = false
        firstUseState.buildFailed++
        // A build that throws is re-queued, bounded per object: without that bound the draw path
        // would re-enqueue a hopeless object every frame, which is a new hitch made out of a build
        // that never succeeds.
        if (attempt < FIRST_USE_MAX_ATTEMPTS) enqueue(renderObject)
      }
      // A build that threw built nothing, so it is not a measured first use and not a drained one:
      // what decides its draw is three's own isReady() gate, exactly as before.
      if (built) {
        const ms = performance.now() - t0
        if (ms > firstUseState.worstBuildMs) firstUseState.worstBuildMs = ms
        firstUseState.drained++
      }
    }
    const sliceMs = performance.now() - sliceStart
    if (sliceMs > firstUseState.worstSliceMs) firstUseState.worstSliceMs = sliceMs
    firstUseState.slices++
    if (queue.length > 0) yieldToBrowser(drain)
    else draining = false
  }

  const enqueue = (renderObject) => {
    if (queued.has(renderObject)) return
    queued.add(renderObject)
    queue.push(renderObject)
    firstUseState.queued = queue.length
    firstUseState.deferred++
    if (draining) return
    draining = true
    yieldToBrowser(drain)
  }

  const wrapped = function (renderObject) {
    // A render bundle is encoded once and replayed forever, so an object that is not ready when its
    // bundle is encoded is missing from that bundle for good -- there is no later frame to catch it
    // up on. Those objects are built where they are asked for.
    if (renderer._currentRenderBundle != null) { orig.call(this, renderObject); return }
    // Only a first use is deferred. An object whose pipeline exists is either ready or already
    // compiling asynchronously, and in both cases three's own isReady() gate decides the draw.
    if (deferEnabled() && pipelines.get(renderObject).pipeline === undefined) { enqueue(renderObject); return }
    orig.call(this, renderObject)
  }
  wrapped.__spointDeferredFirstUse = true
  wrapped.__spointOriginalUpdateForRender = orig
  Object.defineProperty(proto, 'updateForRender', { value: wrapped, writable: true, configurable: true })
  firstUseState.installed = true
  if (typeof window !== 'undefined') window.__deferredFirstUsePipelines = firstUseState
  return true
}
