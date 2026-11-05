import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const FAILURE = {
  isTrusted: true,
  message: 'Failed to load module script: Expected a JavaScript module script but the server responded with MIME type text/html',
  lineno: 3,
  colno: 7,
}

class FailingWorker {
  constructor(url) {
    this.url = String(url)
    setTimeout(() => this.onerror?.({ ...FAILURE, filename: this.url }), 0)
  }
  postMessage() {}
  terminate() {}
}

class BootErrorWorker {
  constructor() {
    setTimeout(() => this.onmessage?.({
      data: {
        type: 'BOOT_ERROR',
        message: 'Failed to fetch dynamically imported module: http://127.0.0.1/src/sdk/WorkerEntry.js',
        stack: 'TypeError: Failed to fetch dynamically imported module',
      },
    }), 0)
  }
  postMessage() {}
  terminate() {}
}

globalThis.fetch = async () => ({ ok: true, json: async () => ({ apps: [] }), text: async () => '' })

const { BrowserServer } = await import('../client/BrowserServer.js')

async function rejectionFor(WorkerClass) {
  globalThis.Worker = WorkerClass
  const client = new BrowserServer({ worldDef: { entities: [] } })
  try {
    await client.connect()
    return null
  } catch (err) {
    return err
  }
}

const workerLoad = await rejectionFor(FailingWorker)
assert.ok(workerLoad instanceof Error, 'a worker ErrorEvent must become an Error, not a trusted DOM Event')
assert.equal(workerLoad.reasonCode, 'worker-load-error')
assert.match(workerLoad.message, /\[browser-server\] worker failed to load/)
assert.match(workerLoad.message, /Failed to load module script/)
assert.match(workerLoad.message, /WorkerBoot\.js:3:7/)
assert.equal(workerLoad.lineno, 3)
assert.match(workerLoad.filename, /WorkerBoot\.js$/)

const moduleLoad = await rejectionFor(BootErrorWorker)
assert.ok(moduleLoad instanceof Error, 'BOOT_ERROR must become an Error')
assert.equal(moduleLoad.reasonCode, 'worker-module-error')
assert.match(moduleLoad.message, /\[browser-server\] worker module failed to load/)
assert.match(moduleLoad.message, /Failed to fetch dynamically imported module/)
assert.match(moduleLoad.message, /TypeError/)

console.log('RESULT: PASS worker load refusal carries reasonCode, message, filename and lineno; module load refusal carries the real cause')
