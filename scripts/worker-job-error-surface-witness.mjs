import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const modulePath = resolve(repoRoot, 'packages/mapspinner/src/worker-job.js')
const { runModuleWorkerJob } = await import(pathToFileURL(modulePath).href)

class FakeWorker {
  static reply = null
  constructor(url, options) {
    this.url = url
    this.options = options
    this.terminated = false
  }
  postMessage(message) {
    this.message = message
    const reply = FakeWorker.reply
    setTimeout(() => {
      if (this.onmessage) this.onmessage({ data: reply })
    }, 0)
  }
  terminate() {
    this.terminated = true
  }
}

globalThis.Worker = FakeWorker

const url = new URL('file:///stub/atmosphere-lut-worker.js')
const failure = 'transmittance bake ran out of memory'

FakeWorker.reply = { ok: false, error: failure }
const failed = await runModuleWorkerJob(url, { go: 1 }, (d) => ({ trans: d.trans }), 2000).then(
  (value) => ({ resolved: true, value }),
  (error) => ({ resolved: false, error })
)

const errorOk = failed.resolved === false
  && failed.error instanceof Error
  && failed.error.code === 'WORKER_JOB_FAILED'
  && failed.error.message.includes(failure)
console.log(`worker reply {ok:false,error} -> ${failed.resolved ? `resolved ${JSON.stringify(failed.value)}` : `rejected code=${failed.error && failed.error.code} message=${JSON.stringify(failed.error && failed.error.message)}`}`)

FakeWorker.reply = { ok: true, trans: 'T', scat: 'S' }
const succeeded = await runModuleWorkerJob(url, { go: 1 }, (d) => ({ trans: d.trans, scat: d.scat }), 2000).then(
  (value) => ({ resolved: true, value }),
  (error) => ({ resolved: false, error })
)
const successOk = succeeded.resolved === true
  && succeeded.value.trans === 'T'
  && succeeded.value.scat === 'S'
console.log(`worker reply {ok:true} -> ${succeeded.resolved ? `resolved ${JSON.stringify(succeeded.value)}` : `rejected ${succeeded.error && succeeded.error.message}`}`)

if (errorOk && successOk) {
  console.log('RESULT: PASS a worker reply with ok:false rejects with a WORKER_JOB_FAILED error carrying the worker message, and a successful reply still resolves')
  process.exit(0)
}
console.log('RESULT: FAIL a worker reply with ok:false must reject with a coded error carrying the worker message; a successful reply must still resolve')
process.exit(1)
