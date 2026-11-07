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

function pendingPipelineCount(pipelines) {
  const caches = pipelines.caches
  const backend = pipelines.backend
  if (!caches || !backend || typeof backend.get !== 'function') return 0
  let n = 0
  for (const pipeline of caches.values()) {
    const data = backend.get(pipeline)
    if (data.pipeline !== undefined && data.pipeline !== null) continue
    if (data.error === true) continue
    n++
  }
  return n
}

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

const ASYNC_PIPELINE_ESCORT_MS = 1500

const asyncPipelineState = {
  installed: false, requested: 0, resolved: 0, rejected: 0, pending: 0,
  escorted: 0, rescued: 0, rescueFailed: 0, dropped: 0,
}

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
    if (pipeline === undefined) { asyncPipelineState.dropped++; return }
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
      rescue(renderObject)
    }
    timer = setTimeout(() => { if (!settled) rescue(renderObject) }, ASYNC_PIPELINE_ESCORT_MS)
    Promise.resolve(promise).then(() => done(false), () => done(true))
  }

  const wrapped = function (renderObject, promises) {
    const sink = promises == null ? [] : promises
    const from = sink.length
    const out = orig.call(this, renderObject, sink)
    for (let i = from; i < sink.length; i++) escort(sink[i], renderObject)
    return out
  }
  wrapped.__spointAsyncRenderPipelines = true
  wrapped.__spointOriginalGetForRender = orig
  Object.defineProperty(proto, 'getForRender', { value: wrapped, writable: true, configurable: true })
  asyncPipelineState.installed = true
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

function deferEnabled() {
  return typeof window === 'undefined' || window.__spointDeferFirstUse !== false
}

export function endPipelinePrewarm() {
  firstUseState.prewarm = false
}

export function installDeferredFirstUsePipelines(renderer) {
  const pipelines = renderer && renderer._pipelines
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
    if (firstUseState.prewarm && typeof window !== 'undefined' && window.__app && window.__app.revealedAt) firstUseState.prewarm = false
    const sliceStart = performance.now()
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
        pipelines.getForRender(renderObject, [])
      } catch (e) {
        built = false
        firstUseState.buildFailed++
        if (attempt < FIRST_USE_MAX_ATTEMPTS) enqueue(renderObject)
      }
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
    if (renderer._currentRenderBundle != null) { orig.call(this, renderObject); return }
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
