const TERMINATE_AFTER_STOP_REQUEST_MS = 250

export function createWorkerRenderer(canvasEl, opts = {}) {
  if (!canvasEl || typeof canvasEl.transferControlToOffscreen !== 'function') {
    throw new Error('createWorkerRenderer: canvas does not support transferControlToOffscreen')
  }
  const readyTimeoutMs = opts.readyTimeoutMs || 5000

  let worker = null
  let started = false
  let lastStats = null
  let lastError = null
  const onStats = opts.onStats || null
  const onError = opts.onError || null

  function start() {
    if (started) return Promise.resolve()
    return new Promise((resolve, reject) => {
      try {
        const workerUrl = new URL('../workers/OffscreenRenderWorker.js', import.meta.url)
        worker = new Worker(workerUrl, { type: 'module' })
      } catch (e) {
        reject(e); return
      }

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error('OffscreenRenderWorker did not become ready within ' + readyTimeoutMs + 'ms'))
      }, readyTimeoutMs)

      worker.onmessage = (e) => {
        const msg = e.data || {}
        if (msg.type === 'ready') {
          if (!settled) { settled = true; clearTimeout(timer); started = true; resolve() }
        } else if (msg.type === 'frame') {
          lastStats = msg
          if (onStats) onStats(msg)
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
    if (!worker) return
    try { worker.postMessage({ type: 'stop' }) } catch (_) {}
    setTimeout(() => { if (worker) { worker.terminate(); worker = null } }, TERMINATE_AFTER_STOP_REQUEST_MS)
    started = false
  }

  function getStats() { return lastStats }
  function getLastError() { return lastError }
  function isRunning() { return started }

  return { start, resize, stop, getStats, getLastError, isRunning }
}
