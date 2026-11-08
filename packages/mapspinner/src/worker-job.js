const DEFAULT_WORKER_JOB_TIMEOUT_MS = 20000

export class WorkerJobError extends Error {
  constructor(url, detail) {
    super(`worker job ${url} failed: ${detail}`)
    this.name = 'WorkerJobError'
    this.code = 'WORKER_JOB_FAILED'
  }
}

export function reportWorkerJobFallback(err, label) {
  if (!(err instanceof WorkerJobError)) throw err
  console.warn(`[mapspinner] ${label} failed, running the in-page fallback: ${err.code}: ${err.message}`)
}

export function runModuleWorkerJob(url, message, accept, timeoutMs = DEFAULT_WORKER_JOB_TIMEOUT_MS) {
  try {
    if (typeof Worker === 'undefined') return null
    const w = new Worker(url, { type: 'module' })
    return new Promise((resolve, reject) => {
      let done = false
      const settle = (settleFn, v) => { if (done) return; done = true; clearTimeout(timer); try { w.terminate() } catch (_) {} settleFn(v) }
      const finish = (v) => settle(resolve, v)
      const fail = (err) => settle(reject, err)
      const timer = setTimeout(() => {
        console.warn(`[mapspinner] worker job ${url} gave no reply within ${timeoutMs} ms, falling back to the in-page path`)
        finish(null)
      }, timeoutMs)
      w.onmessage = (ev) => {
        const d = ev.data
        if (d && d.ok) finish(accept(d))
        else fail(new WorkerJobError(url, d && d.error != null ? String(d.error) : 'reply without ok'))
      }
      w.onerror = () => finish(null)
      w.onmessageerror = () => finish(null)
      w.postMessage(message)
    })
  } catch (_) { return null }
}
