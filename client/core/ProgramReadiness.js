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

export function pendingProgramCount(renderer) {
  const pipelines = renderer && renderer._pipelines
  if (pipelines) return pendingPipelineCount(pipelines)
  const programs = renderer && renderer.info && renderer.info.programs
  if (!programs) return 0
  let n = 0
  for (const p of programs) if (typeof p.isReady === 'function' && !p.isReady()) n++
  return n
}

export function whenProgramsReady(renderer, maxWaitMs) {
  const t0 = performance.now()
  return new Promise((resolve) => {
    const poll = () => {
      const pending = pendingProgramCount(renderer)
      if (pending === 0) { resolve(0); return }
      if (performance.now() - t0 >= maxWaitMs) { console.warn(`[shader] ${pending} program(s) still compiling after ${maxWaitMs}ms`); resolve(pending); return }
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
// most a steady frame can carry is one slice plus the one prologue that overshoots it.
//
// Two properties hold by construction, not by tuning:
//   * a queued object is drained to ready whether or not anything is rendering -- the drain
//     reschedules itself on a MessageChannel until the queue is empty, so it cannot strand an
//     object the way an unanswered async creation can;
//   * a drain slice always builds at least one object, so a prologue longer than the slice cannot
//     starve the queue.
// ---------------------------------------------------------------------------
const FIRST_USE_SLICE_MS = 4
const FIRST_USE_PREWARM_SLICE_MS = 96
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
    // The slice is wide while the world is still behind the loading screen -- a long slice there is
    // a slice nobody sees, and the point of the wide slice is that the scenery is complete by the
    // time it is revealed -- and narrow from the reveal onwards. client/app.js stamps
    // `__app.revealedAt` at exactly that moment, so the budget needs no call site of its own.
    if (firstUseState.prewarm && typeof window !== 'undefined' && window.__app && window.__app.revealedAt) firstUseState.prewarm = false
    const budget = firstUseState.prewarm ? FIRST_USE_PREWARM_SLICE_MS : FIRST_USE_SLICE_MS
    const sliceStart = performance.now()
    let built = 0
    let failed = 0
    // `failed` bounds the slice as well as the object. A build that throws is re-queued for another
    // slice, so without a per-slice bound the queue would be shifted and re-pushed inside one slice
    // forever; without a per-object bound the draw path would re-enqueue a hopeless object every
    // frame, which is a new hitch made out of a build that never succeeds.
    while (queue.length > 0 && failed < FIRST_USE_MAX_ATTEMPTS && (built === 0 || performance.now() - sliceStart < budget)) {
      const renderObject = queue.shift()
      queued.delete(renderObject)
      firstUseState.queued = queue.length
      if (pipelines.isReady(renderObject)) { firstUseState.skippedReady++; continue }
      const attempt = (attempts.get(renderObject) || 0) + 1
      attempts.set(renderObject, attempt)
      const t0 = performance.now()
      try {
        // A non-null sink is what selects createRenderPipelineAsync over createRenderPipeline, and
        // installAsyncRenderPipelines escorts everything added to it.
        pipelines.getForRender(renderObject, [])
      } catch (e) {
        failed++
        firstUseState.buildFailed++
        if (attempt < FIRST_USE_MAX_ATTEMPTS) enqueue(renderObject)
        continue
      }
      const ms = performance.now() - t0
      if (ms > firstUseState.worstBuildMs) firstUseState.worstBuildMs = ms
      firstUseState.drained++
      built++
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
