import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runModelLoadGate, takeModelLoadErrors } from '../client/core/modelLoadGate.js'

takeModelLoadErrors()
const marks = []
const result = await runModelLoadGate({ urls: ['bad.glb'], prefetch: async () => { throw new Error('boom') }, sendMark: m => marks.push(m) })
assert.equal(result.ok, false)
assert.deepEqual(marks, [])
assert.equal(result.refusal.url, 'bad.glb')
assert.equal(takeModelLoadErrors().length, 1)
const src = readFileSync('client/app.js', 'utf8')
assert.match(src, /onFailure: err => \{ loadingMachine\.send\('MODEL_LOAD_FAILED'/)
assert.match(src, /const refusal = refuseModelLoad\('<gate>', err\); loadingMachine\.send\('MODEL_LOAD_FAILED'/)
assert.equal(src.includes("console.error('[model-load] gate failed:', err?.message || err)"), false)
console.log('RESULT: PASS app.js model-load gate failures are recorded and sent as MODEL_LOAD_FAILED, not just logged')
