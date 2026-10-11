const TERMINATE_AFTER_STOP_REQUEST_MS = 250
const WORKER_FRAME_LIVE_BOUND_MS = 1000
const WORKER_STOP_CONFIRM_TIMEOUT_MS = 1000

export function classifyWorkerFrameWindow(frames, waitStartMs, waitEndMs, pageVisible) {
  const arrivals = []
  for (const frame of frames || []) {
    const at = Number(frame && frame.at)
    if (Number.isFinite(at)) arrivals.push(at)
  }
  arrivals.sort((a, b) => a - b)

  const firstFrameDelayMs = arrivals.length ? arrivals[0] - waitStartMs : null
  const lastFrameAgeMs = arrivals.length ? waitEndMs - arrivals[arrivals.length - 1] : null
  const withinLiveBound = (ms) => ms !== null && ms >= -WORKER_FRAME_LIVE_BOUND_MS && ms <= WORKER_FRAME_LIVE_BOUND_MS
  const live = withinLiveBound(firstFrameDelayMs) && withinLiveBound(lastFrameAgeMs)
  const state = !pageVisible
    ? 'hidden'
    : (arrivals.length === 0 ? 'no-frames' : (live ? 'live' : 'throttled'))

  return {
    ok: state === 'live',
    state,
    measurable: state !== 'hidden',
    framesReported: arrivals.length,
    firstFrameDelayMs,
    lastFrameAgeMs,
    liveBoundMs: WORKER_FRAME_LIVE_BOUND_MS
  }
}

export function classifyWorkerRuntimeState(input) {
  const src = input || {}
  const liveBoundMs = Number.isFinite(src.liveBoundMs) ? src.liveBoundMs : WORKER_FRAME_LIVE_BOUND_MS
  const nowMs = Number(src.nowMs)
  const pageVisible = src.pageVisible !== false
  const refMs = Number.isFinite(src.lastFrameMs)
    ? src.lastFrameMs
    : (Number.isFinite(src.readyMs) ? src.readyMs : null)
  const ageMs = refMs === null ? null : nowMs - refMs

  let state
  if (src.stopped === true) state = 'stopped'
  else if (src.hasError === true) state = 'error'
  else if (src.stopRequested === true) state = 'stopping'
  else if (src.started !== true) state = 'idle'
  else if (!pageVisible) state = 'hidden'
  else state = (ageMs === null || ageMs < 0 || ageMs <= liveBoundMs) ? 'live' : 'stalled'

  return {
    running: state === 'live' || state === 'hidden',
    state,
    ageMs,
    stale: state === 'stalled' || state === 'error' || state === 'stopped',
    liveBoundMs
  }
}

export function createWorkerRenderer(canvasEl, opts = {}) {
  if (!canvasEl || typeof canvasEl.transferControlToOffscreen !== 'function') {
    throw new Error('createWorkerRenderer: canvas does not support transferControlToOffscreen')
  }
  const readyTimeoutMs = opts.readyTimeoutMs || 5000

  let worker = null
  let started = false
  let run = 0
  let acceptedSeq = 0
  let acceptedRun = null
  let staleGenerationRejected = 0
  let staleRunRejected = 0
  let outOfOrderRejected = 0
  let unstampedAccepted = 0
  let lastStats = null
  let lastError = null
  let readyAtMs = null
  let lastFrameAtMs = null
  let stopRequestedAtMs = null
  let stoppedAtMs = null
  let stoppedMessage = null
  const stopWaiters = []
  const onStats = opts.onStats || null
  const onError = opts.onError || null
  const onStopped = opts.onStopped || null

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()
  }
  function pageVisible() {
    return typeof document === 'undefined' ? true : document.hidden !== true
  }
  function runtimeState() {
    return classifyWorkerRuntimeState({
      started,
      stopRequested: stopRequestedAtMs !== null,
      stopped: stoppedAtMs !== null,
      hasError: lastError !== null,
      readyMs: readyAtMs,
      lastFrameMs: lastFrameAtMs,
      nowMs: nowMs(),
      pageVisible: pageVisible()
    })
  }

  function acceptWorkerMessage(msg, myRun) {
    if (myRun !== run) { staleGenerationRejected++; return false }
    const seq = Number(msg && msg.seq)
    const runStamp = Number(msg && msg.run)
    const hasSeq = Number.isFinite(seq)
    const hasRun = Number.isFinite(runStamp)
    if (hasRun && acceptedRun !== null && runStamp < acceptedRun) { staleRunRejected++; return false }
    if (hasSeq && seq <= acceptedSeq) { outOfOrderRejected++; return false }
    if (!hasSeq || !hasRun) unstampedAccepted++
    if (hasSeq) acceptedSeq = seq
    if (hasRun && (acceptedRun === null || runStamp > acceptedRun)) acceptedRun = runStamp
    return true
  }
  function orderState() {
    return {
      run,
      seq: acceptedSeq,
      workerRun: acceptedRun,
      staleGenerationRejected,
      staleRunRejected,
      outOfOrderRejected,
      unstampedAccepted
    }
  }

  function start() {
    if (started) return Promise.resolve()
    return new Promise((resolve, reject) => {
      stopRequestedAtMs = null
      stoppedAtMs = null
      stoppedMessage = null
      lastError = null
      try {
        const workerUrl = new URL('../workers/OffscreenRenderWorker.js', import.meta.url)
        worker = new Worker(workerUrl, { type: 'module' })
      } catch (e) {
        reject(e); return
      }

      const myRun = ++run
      acceptedSeq = 0
      acceptedRun = null

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('OffscreenRenderWorker did not become ready within ' + readyTimeoutMs + 'ms'))
      }, readyTimeoutMs)

      worker.onmessage = (e) => {
        const msg = e.data || {}
        if (!acceptWorkerMessage(msg, myRun)) return
        if (msg.type === 'ready') {
          if (!settled) { settled = true; clearTimeout(timer); readyAtMs = nowMs(); started = true; resolve() }
        } else if (msg.type === 'frame') {
          lastStats = msg
          lastFrameAtMs = nowMs()
          if (onStats) onStats(msg)
        } else if (msg.type === 'stopped') {
          stoppedAtMs = nowMs()
          stoppedMessage = msg
          started = false
          if (onStopped) onStopped(msg)
          const waiters = stopWaiters.splice(0, stopWaiters.length)
          for (const waiter of waiters) waiter(msg)
        } else if (msg.type === 'error') {
          lastError = msg
          if (onError) onError(msg)
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('worker init error: ' + msg.message)) }
        }
      }
      worker.onerror = (e) => {
        lastError = { message: e.message, filename: e.filename, lineno: e.lineno }
        if (onError) onError(lastError)
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('worker onerror: ' + e.message)) }
      }

      const rect = canvasEl.getBoundingClientRect ? canvasEl.getBoundingClientRect() : { width: canvasEl.width, height: canvasEl.height }
      const width = Math.max(1, Math.round(rect.width || canvasEl.width || 300))
      const height = Math.max(1, Math.round(rect.height || canvasEl.height || 150))
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1

      const offscreen = canvasEl.transferControlToOffscreen()
      worker.postMessage({ type: 'init', canvas: offscreen, width, height, dpr }, [offscreen])
    })
  }

  function resize(width, height, dpr) {
    if (!worker || !started) return
    worker.postMessage({ type: 'resize', width, height, dpr: dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1 })
  }

  function stop() {
    if (!worker) return Promise.resolve({ ok: false, reason: 'no-worker', ms: 0, message: null })
    const stopWorker = worker
    const stopRun = run
    stopRequestedAtMs = nowMs()
    try { stopWorker.postMessage({ type: 'stop' }) } catch (_) {}
    setTimeout(() => {
      const armedWorkerIsCurrent = worker === stopWorker && run === stopRun
      if (armedWorkerIsCurrent) { worker.terminate(); worker = null }
      else stopWorker.terminate()
      if (armedWorkerIsCurrent && stoppedAtMs === null) {
        stoppedAtMs = nowMs()
        stoppedMessage = { type: 'stop-terminated' }
        const waiters = stopWaiters.splice(0, stopWaiters.length)
        for (const waiter of waiters) waiter(stoppedMessage)
      }
    }, TERMINATE_AFTER_STOP_REQUEST_MS)
    started = false
    return awaitStopped()
  }

  function awaitStopped(timeoutMs) {
    if (stoppedAtMs !== null) {
      return Promise.resolve({ ok: true, reason: 'stopped', ms: 0, message: stoppedMessage })
    }
    const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : WORKER_STOP_CONFIRM_TIMEOUT_MS
    const requestedAtMs = stopRequestedAtMs === null ? nowMs() : stopRequestedAtMs
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = stopWaiters.indexOf(waiter)
        if (at >= 0) stopWaiters.splice(at, 1)
        resolve({ ok: false, reason: 'stop-timeout', ms: nowMs() - requestedAtMs, message: null })
      }, budget)
      const waiter = (msg) => {
        clearTimeout(timer)
        resolve({ ok: true, reason: 'stopped', ms: nowMs() - requestedAtMs, message: msg || null })
      }
      stopWaiters.push(waiter)
    })
  }

  function getStats() {
    const state = runtimeState()
    if (!lastStats) return { frame: null, ageMs: state.ageMs, stale: state.stale, state: state.state, order: orderState() }
    return { ...lastStats, ageMs: state.ageMs, stale: state.stale, state: state.state, order: orderState() }
  }
  function getOrder() { return orderState() }
  function getLastError() { return lastError }
  function getState() { return runtimeState() }
  function isRunning() { return runtimeState().running }

  return { start, resize, stop, getStats, getOrder, getLastError, isRunning, getState, awaitStopped }
}
