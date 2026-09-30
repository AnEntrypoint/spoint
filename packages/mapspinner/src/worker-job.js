const DEFAULT_WORKER_JOB_TIMEOUT_MS = 20000

export function runModuleWorkerJob(url, message, accept, timeoutMs = DEFAULT_WORKER_JOB_TIMEOUT_MS) {
  try {
    if (typeof Worker === 'undefined') return null
    const w = new Worker(url, { type: 'module' })
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { w.terminate() } catch (_) {} resolve(v) }
      const timer = setTimeout(() => {
        console.warn(`[mapspinner] worker job ${url} gave no reply within ${timeoutMs} ms, falling back to the in-page path`)
        finish(null)
      }, timeoutMs)
      w.onmessage = (ev) => { const d = ev.data; finish(d && d.ok ? accept(d) : null) }
      w.onerror = () => finish(null)
      w.onmessageerror = () => finish(null)
      w.postMessage(message)
    })
  } catch (_) { return null }
}
