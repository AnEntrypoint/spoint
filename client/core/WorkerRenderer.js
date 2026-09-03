// WorkerRenderer.js -- main-thread side of the real worker-hosted render loop
// (offscreencanvas-worker-migration-followup epic, first functional slice).
//
// The prior session (SceneSetup.probeOffscreenCanvasWorkerRendering, see AGENTS.md
// offscreencanvas-worker-rendering) only detected feature support. This module is the actual
// mechanism: transfers a real <canvas> to a dedicated module Worker via transferControlToOffscreen,
// which then runs a real THREE.WebGLRenderer render loop (client/workers/OffscreenRenderWorker.js)
// entirely off the main thread, proxying resize events back in.
//
// SCOPE: this drives an ISOLATED diagnostic canvas with its own small demo scene -- it does NOT
// replace or touch the main game's render path (RenderGraph/ShadowPipeline/mapspinner). Migrating the
// real game loop needs the full DOM/window proxy layer the audit scoped (mapspinner's window.__* reads,
// MobileControls, HUD DOM writes) -- explicitly out of this slice's bounded scope, re-filed as sibling
// PRD rows. This module proves the transfer+worker-draw+resize-proxy+teardown mechanism actually works,
// live, so the real migration has a working foundation to build on instead of just a detection flag.
//
// Usage:
//   const wr = createWorkerRenderer(canvasEl)
//   await wr.start()          // resolves once the worker posts 'ready' (or rejects on error/timeout)
//   wr.resize(w, h, dpr)      // proxy a resize into the worker
//   wr.getStats()             // last {frame, ms, drawCalls, triangles} telemetry the worker posted
//   wr.stop()                 // tears down the worker + releases the canvas control

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
    // Terminate shortly after asking it to stop cleanly -- bounded, does not depend on the worker
    // acking (a crashed/unresponsive worker must not leak).
    setTimeout(() => { if (worker) { worker.terminate(); worker = null } }, 250)
    started = false
  }

  function getStats() { return lastStats }
  function getLastError() { return lastError }
  function isRunning() { return started }

  return { start, resize, stop, getStats, getLastError, isRunning }
}
