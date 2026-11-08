import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const USE_HEAD = process.argv.includes('--head')
const GL_RENDER = 'packages/mapspinner/src/gl-render.js'
const LUT_JOB = 'packages/mapspinner/src/atmosphere-lut-job.js'

const failures = []
function check(label, ok, detail) {
  console.log(`[lut-worker-await] ${label}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
  if (!ok) failures.push(label)
}

function sourceOf(rel) {
  if (!USE_HEAD) return execFileSync('cat', [resolve(ROOT, rel)], { encoding: 'utf8' })
  return execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`], { encoding: 'utf8' })
}

const glSource = sourceOf(GL_RENDER)
check('gl-render awaits the LUT worker through the helper', /await awaitLutBakeWorker\(_lutJob\)/.test(glSource))
check('gl-render has no bare await of the LUT worker', !/await _lutJob\s*;/.test(glSource))

const replies = []
class StubWorker {
  constructor(url) {
    this.name = basename(new URL(String(url)).pathname)
    this.terminated = false
  }
  postMessage() {
    const reply = replies.shift() ?? { ok: false, error: 'no stub reply' }
    setTimeout(() => { if (this.onmessage) this.onmessage({ data: reply }) }, 0)
  }
  terminate() { this.terminated = true }
}
globalThis.Worker = StubWorker

const lutJob = await import(resolve(ROOT, LUT_JOB)).catch((err) => ({ importError: String(err && err.message || err) }))
if (lutJob.importError) {
  check('atmosphere-lut-job imports', false, lutJob.importError)
} else {
  const { startLutBakeWorker } = lutJob
  const awaitLutBakeWorker = lutJob.awaitLutBakeWorker
  check('awaitLutBakeWorker is exported', typeof awaitLutBakeWorker === 'function')
  if (typeof awaitLutBakeWorker === 'function') {
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
    try {
      replies.push({ ok: false, error: 'stub LUT failure' })
      const failed = await awaitLutBakeWorker(startLutBakeWorker())
      check('ok:false LUT reply resolves to null', failed === null, `value=${String(failed)}`)
      check('ok:false LUT reply is reported with its code', warnings.some(w => w.includes('WORKER_JOB_FAILED') && w.includes('stub LUT failure')), warnings.join(' | ').slice(0, 200))

      replies.push({ ok: true, trans: 'T', scat: 'S' })
      const good = await awaitLutBakeWorker(startLutBakeWorker())
      check('ok:true LUT reply still resolves to the baked pair', good && good.trans === 'T' && good.scat === 'S', JSON.stringify(good))

      let rethrown = null
      try { await awaitLutBakeWorker(Promise.reject(new TypeError('not a worker failure'))) } catch (err) { rethrown = err }
      check('a non-worker error is rethrown, not swallowed', rethrown instanceof TypeError, String(rethrown))
    } finally {
      console.warn = realWarn
    }
  }
}

if (failures.length) {
  console.log(`RESULT: FAIL ${failures.length} check(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log(`RESULT: PASS every LUT worker reply is handled through awaitLutBakeWorker${USE_HEAD ? ' (HEAD sources)' : ''}`)
process.exit(0)
