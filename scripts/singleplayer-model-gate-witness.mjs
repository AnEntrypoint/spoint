import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runModelLoadGate } from '../client/core/modelLoadGate.js'

let resolveDeferred = null
const deferred = new Promise(resolve => { resolveDeferred = resolve })
const marks = []
const pending = runModelLoadGate({ urls: ['sp.glb'], prefetch: () => deferred, sendMark: m => marks.push(m) })
await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
assert.deepEqual(marks, [], 'singleplayer must not release MODELS_DONE before its deferred prefetch')
resolveDeferred()
const result = await pending
assert.equal(result.ok, true)
assert.deepEqual(marks, ['MODELS_DONE'])

let rejectDeferred = null
const failing = new Promise((_, reject) => { rejectDeferred = reject })
const failureMarks = []
const failingGate = runModelLoadGate({ urls: ['sp.glb'], prefetch: () => failing, sendMark: m => failureMarks.push(m) })
rejectDeferred(new Error('worker not ready'))
const failure = await failingGate
assert.equal(failure.ok, false)
assert.equal(failure.refusal.reasonCode, 'model-load-failed')
assert.deepEqual(failureMarks, [])

const src = readFileSync('client/app.js', 'utf8')
assert.match(src, /_spPrefetchPromise = new Promise/)
assert.match(src, /prefetch: urls => _isSingleplayer && _spPrefetchPromise \? _spPrefetchPromise : el\.prefetchModels\(urls\)/)
assert.match(src, /_pendingSpPrefetch = modelUrls/)
assert.match(src, /await Promise\.all\(urls\.map\(u => el\.prefetchModels\(\[u\]\)\)\)/)
console.log('RESULT: PASS singleplayer MODELS_DONE waits for the deferred prefetch and stays held on prefetch failure')
