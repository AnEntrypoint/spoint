const TERMINATE_AFTER_STOP_REQUEST_MS = 250
const WORKER_FRAME_LIVE_BOUND_MS = 1000
const WORKER_STOP_CONFIRM_TIMEOUT_MS = 1000
const RUN_STATE_START_FAILED = 'start-failed'

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

  let current = null
  let runCount = 0
  const runRecords = new WeakMap()
  const onStats = opts.onStats || null
  const onError = opts.onError || null
  const onStopped = opts.onStopped || null

  function runHandleFor(record) {
    const handle = Object.freeze({ id: record.id })
    runRecords.set(handle, record)
    return handle
  }

  function resolveRun(handle) {
    if (handle === null || handle === undefined) return { kind: 'no-run', record: null }
    const record = runRecords.get(handle)
    if (record === undefined) return { kind: 'foreign-run', record: null }
    if (record !== current) return { kind: 'retired-run', record }
    return { kind: 'current', record }
  }

  function terminalStopResult(record) {
    if (record.state === 'stopped') return { ok: true, reason: 'stopped', ms: 0, message: record.stoppedMessage }
    if (record.state === RUN_STATE_START_FAILED) return { ok: false, reason: 'start-failed', ms: 0, message: null }
    return null
  }

  function createRunRecord(worker) {
    return {
      id: ++runCount,
      worker,
      state: 'starting',
      stopSettlement: null,
      acceptedSeq: 0,
      acceptedRun: null,
      unstampedRejected: 0,
      staleGenerationRejected: 0,
      staleRunRejected: 0,
      outOfOrderRejected: 0,
      readyAtMs: null,
      lastFrameAtMs: null,
      stopRequestedAtMs: null,
      stoppedMessage: null,
      lastError: null,
      lastRefusal: null,
      lastStats: null
    }
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now()
  }
  function pageVisible() {
    return typeof document === 'undefined' ? true : document.hidden !== true
  }
  function runtimeState() {
    const record = current
    return classifyWorkerRuntimeState({
      started: record !== null && record.state === 'running',
      stopRequested: record !== null && record.stopRequestedAtMs !== null,
      stopped: record !== null && record.state === 'stopped',
      hasError: record !== null && record.lastError !== null,
      readyMs: record === null ? null : record.readyAtMs,
      lastFrameMs: record === null ? null : record.lastFrameAtMs,
      nowMs: nowMs(),
      pageVisible: pageVisible()
    })
  }

  function parseWorkerStamp(msg) {
    if (msg === null || typeof msg !== 'object') return null
    const seq = msg.seq
    const run = msg.run
    if (!Number.isInteger(seq) || seq < 1) return null
    if (run !== 0 && run !== 1) return null
    return { seq, run }
  }

  function acceptWorkerMessage(record, msg) {
    if (record !== current) { record.staleGenerationRejected++; return false }
    const stamp = parseWorkerStamp(msg)
    if (stamp === null) { record.unstampedRejected++; return false }
    if (record.acceptedRun !== null && stamp.run < record.acceptedRun) { record.staleRunRejected++; return false }
    if (stamp.seq <= record.acceptedSeq) { record.outOfOrderRejected++; return false }
    record.acceptedSeq = stamp.seq
    record.acceptedRun = stamp.run
    return true
  }
  function orderState() {
    if (current === null) {
      return {
        run: 0,
        seq: 0,
        workerRun: null,
        unstampedRejected: 0,
        staleGenerationRejected: 0,
        staleRunRejected: 0,
        outOfOrderRejected: 0
      }
    }
    return {
      run: current.id,
      seq: current.acceptedSeq,
      workerRun: current.acceptedRun,
      unstampedRejected: current.unstampedRejected,
      staleGenerationRejected: current.staleGenerationRejected,
      staleRunRejected: current.staleRunRejected,
      outOfOrderRejected: current.outOfOrderRejected
    }
  }

  function start() {
    if (current !== null && current.state !== 'stopped') {
      return Promise.reject(new Error('createWorkerRenderer: start() refused while run ' + current.id + ' is ' + current.state + ' and still holds the canvas'))
    }
    const previous = current
    return new Promise((resolve, reject) => {
      let worker = null
      try {
        const workerUrl = new URL('../workers/OffscreenRenderWorker.js', import.meta.url)
        worker = new Worker(workerUrl, { type: 'module' })
      } catch (e) {
        reject(e); return
      }

      const record = createRunRecord(worker)
      const handle = runHandleFor(record)
      current = record

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('OffscreenRenderWorker did not become ready within ' + readyTimeoutMs + 'ms'))
      }, readyTimeoutMs)

      worker.onmessage = (e) => {
        const msg = e.data || {}
        if (!acceptWorkerMessage(record, msg)) return
        if (msg.type === 'ready') {
          if (record.state !== 'starting') return
          record.readyAtMs = nowMs()
          record.state = 'running'
          if (!settled) { settled = true; clearTimeout(timer); resolve(handle) }
        } else if (msg.type === 'frame') {
          if (record.state !== 'running') return
          record.lastStats = msg
          record.lastFrameAtMs = nowMs()
          if (onStats) onStats(msg)
        } else if (msg.type === 'stopped') {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('worker stopped before ready')) }
          finishStop(record, msg)
          if (onStopped) onStopped(msg)
        } else if (msg.type === 'error') {
          if (record.state === 'running') record.lastRefusal = msg
          else record.lastError = msg
          if (onError) onError(msg)
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('worker init error: ' + msg.message)) }
        }
      }
      worker.onerror = (e) => {
        record.lastError = { message: e.message, filename: e.filename, lineno: e.lineno }
        if (onError) onError(record.lastError)
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('worker onerror: ' + e.message)) }
      }

      const rect = canvasEl.getBoundingClientRect ? canvasEl.getBoundingClientRect() : { width: canvasEl.width, height: canvasEl.height }
      const width = Math.max(1, Math.round(rect.width || canvasEl.width || 300))
      const height = Math.max(1, Math.round(rect.height || canvasEl.height || 150))
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1

      let offscreen = null
      try {
        offscreen = canvasEl.transferControlToOffscreen()
      } catch (e) {
        settled = true
        clearTimeout(timer)
        abandonRun(record, previous)
        reject(startRefused(handle, e))
        return
      }
      worker.postMessage({ type: 'init', canvas: offscreen, width, height, dpr }, [offscreen])
    })
  }

  function abandonRun(record, restoreTo) {
    record.state = RUN_STATE_START_FAILED
    try { record.worker.terminate() } catch (_) {}
    current = restoreTo
  }

  function startRefused(handle, cause) {
    const err = new Error('createWorkerRenderer: start() refused: canvas control was already transferred (' + String((cause && cause.message) || cause) + ')')
    err.reason = 'canvas-already-transferred'
    err.runHandle = handle
    return err
  }

  function resize(width, height, dpr) {
    if (current === null || current.state !== 'running') return
    current.worker.postMessage({ type: 'resize', width, height, dpr: dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1 })
  }

  function finishStop(record, msg) {
    if (record.state === 'stopped') return
    record.state = 'stopped'
    record.stoppedMessage = msg
    try { record.worker.terminate() } catch (_) {}
    const settlement = record.stopSettlement
    if (settlement === null) return
    clearTimeout(settlement.timer)
    settlement.settle({ ok: true, reason: 'stopped', ms: nowMs() - settlement.requestedAtMs, message: msg || null })
  }

  function createStopSettlement(record) {
    let settle = null
    const promise = new Promise((resolve) => { settle = resolve })
    const requestedAtMs = record.stopRequestedAtMs
    const timer = setTimeout(() => {
      settle({ ok: false, reason: 'stop-timeout', ms: nowMs() - requestedAtMs, message: null })
    }, WORKER_STOP_CONFIRM_TIMEOUT_MS)
    return { promise, settle, timer, requestedAtMs }
  }

  function requestStop(record) {
    if (record.stopRequestedAtMs !== null) return
    record.stopRequestedAtMs = nowMs()
    record.state = 'stopping'
    record.stopSettlement = createStopSettlement(record)
    try { record.worker.postMessage({ type: 'stop' }) } catch (_) {}
    setTimeout(() => finishStop(record, { type: 'stop-terminated' }), TERMINATE_AFTER_STOP_REQUEST_MS)
  }

  function stopTarget(handle) {
    if (handle === undefined) {
      return current === null ? { kind: 'no-worker', record: null } : { kind: 'current', record: current }
    }
    return resolveRun(handle)
  }

  function stop(handle) {
    const target = stopTarget(handle)
    if (target.record === null) return Promise.resolve({ ok: false, reason: target.kind, ms: 0, message: null })
    const terminal = terminalStopResult(target.record)
    if (terminal !== null) return Promise.resolve(terminal)
    if (target.kind === 'retired-run') return Promise.resolve({ ok: false, reason: 'retired-run', ms: 0, message: null })
    requestStop(target.record)
    return target.record.stopSettlement.promise
  }

  function awaitStopped(handle) {
    const target = resolveRun(handle)
    if (target.record === null) return Promise.resolve({ ok: false, reason: target.kind, ms: 0, message: null })
    const terminal = terminalStopResult(target.record)
    if (terminal !== null) return Promise.resolve(terminal)
    if (target.kind === 'retired-run') return Promise.resolve({ ok: false, reason: 'retired-run', ms: 0, message: null })
    if (target.record.stopSettlement !== null) return target.record.stopSettlement.promise
    return Promise.resolve({ ok: false, reason: 'not-stopping', ms: 0, message: null })
  }

  function getStats() {
    const state = runtimeState()
    const lastStats = current === null ? null : current.lastStats
    if (!lastStats) return { frame: null, ageMs: state.ageMs, stale: state.stale, state: state.state, order: orderState() }
    return { ...lastStats, ageMs: state.ageMs, stale: state.stale, state: state.state, order: orderState() }
  }
  function getOrder() { return orderState() }
  function getLastError() { return current === null ? null : current.lastError }
  function getState() { return runtimeState() }
  function isRunning() { return runtimeState().running }

  return { start, resize, stop, getStats, getOrder, getLastError, isRunning, getState, awaitStopped }
}
