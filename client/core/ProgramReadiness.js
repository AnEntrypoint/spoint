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

export function pendingProgramCount(renderer) {
  const programs = renderer.info && renderer.info.programs
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
//     array, which selects device.createRenderPipelineAsync() over device.createRenderPipeline(),
//     and Renderer.compileAsync() is the only caller that hands one over.
//
// So the fix is to hand the render path a promises sink too: creation leaves the main thread's
// critical path and the object is simply not drawn for the frames until its pipeline resolves. This
// sheds no quality and widens no distance band -- the same objects draw, a frame or two later.
// ---------------------------------------------------------------------------
const asyncPipelineState = { installed: false, requested: 0, resolved: 0, rejected: 0, pending: 0 }

export function installAsyncRenderPipelines(renderer) {
  const pipelines = renderer && renderer._pipelines
  if (!pipelines) return false
  const proto = Object.getPrototypeOf(pipelines)
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'getForRender') : null
  if (!desc || typeof desc.value !== 'function') return false
  if (desc.value.__spointAsyncRenderPipelines === true) { asyncPipelineState.installed = true; return true }
  const orig = desc.value
  const sink = {
    push: (p) => {
      asyncPipelineState.requested++
      asyncPipelineState.pending++
      const settle = (failed) => {
        asyncPipelineState.pending--
        if (failed) asyncPipelineState.rejected++
        else asyncPipelineState.resolved++
      }
      Promise.resolve(p).then(() => settle(false), () => settle(true))
    },
  }
  const wrapped = function (renderObject, promises) {
    return orig.call(this, renderObject, promises == null ? sink : promises)
  }
  wrapped.__spointAsyncRenderPipelines = true
  // Kept so a witness can restore the un-wrapped original and re-measure the stall this removes.
  // A fix that cannot be reverted cannot be shown to be what changed the measurement.
  wrapped.__spointOriginalGetForRender = orig
  Object.defineProperty(proto, 'getForRender', { value: wrapped, writable: true, configurable: true })
  asyncPipelineState.installed = true
  if (typeof window !== 'undefined') window.__asyncRenderPipelines = asyncPipelineState
  return true
}

export function takeDeferredDraws(renderer) {
  const n = renderer.deferredProgramDraws || 0
  renderer.deferredProgramDraws = 0
  renderer.lastDeferredDraws = n
  return n
}
