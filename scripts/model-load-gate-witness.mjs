import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { prefetchModel, modelLoadRefusal, runModelLoadGate } from '../client/core/modelLoadGate.js'

assert.equal(await prefetchModel('arena.glb', async url => url), 'arena.glb')
const cause = new Error('404 Not Found')
await assert.rejects(
  () => prefetchModel('missing.glb', async () => { throw cause }),
  e => e.reasonCode === 'model-load-failed' && e.url === 'missing.glb' && e.cause === cause,
)
const refusal = modelLoadRefusal('missing.glb', cause)
assert.equal(refusal.reasonCode, 'model-load-failed')
assert.equal(refusal.url, 'missing.glb')
assert.match(refusal.message, /404 Not Found/)
await assert.rejects(() => prefetchModel('', async () => {}), e => e.reasonCode === 'model-prefetch-url-invalid')
await assert.rejects(() => prefetchModel('x', null), e => e.reasonCode === 'model-prefetch-load-invalid')

const emptyMarks = []
const empty = await runModelLoadGate({ urls: [], prefetch: async () => {}, sendMark: m => emptyMarks.push(m) })
assert.equal(empty.ok, true)
assert.deepEqual(emptyMarks, ['MODELS_DONE'])

const okMarks = []
let prefetched = null
const ok = await runModelLoadGate({ urls: ['a.glb', 'b.glb'], prefetch: async urls => { prefetched = urls }, sendMark: m => okMarks.push(m) })
assert.equal(ok.ok, true)
assert.deepEqual(okMarks, ['MODELS_DONE'])
assert.deepEqual(prefetched, ['a.glb', 'b.glb'])

const failMarks = []
const failures = []
const failed = await runModelLoadGate({
  urls: ['bad.glb'],
  prefetch: async () => { throw modelLoadRefusal('bad.glb', new Error('network down')) },
  sendMark: m => failMarks.push(m),
  onFailure: e => failures.push(e),
})
assert.equal(failed.ok, false)
assert.equal(failed.mark, null)
assert.deepEqual(failMarks, [], 'a failed prefetch must not release the loading gate')
assert.equal(failures.length, 1)
assert.equal(failures[0].reasonCode, 'model-load-failed')
assert.equal(failures[0].url, 'bad.glb')

const plain = await runModelLoadGate({ urls: ['plain.glb'], prefetch: async () => { throw new Error('boom') }, sendMark: () => { throw new Error('must not mark') } })
assert.equal(plain.ok, false)
assert.equal(plain.refusal.reasonCode, 'model-load-failed')
assert.equal(plain.refusal.url, 'plain.glb')

await assert.rejects(() => runModelLoadGate({ urls: 'x', prefetch: async () => {}, sendMark: () => {} }), e => e.reasonCode === 'model-gate-urls-invalid')
await assert.rejects(() => runModelLoadGate({ urls: [], prefetch: null, sendMark: () => {} }), e => e.reasonCode === 'model-gate-hooks-invalid')
await assert.rejects(() => runModelLoadGate({ urls: [], prefetch: async () => {}, sendMark: () => {}, onFailure: 1 }), e => e.reasonCode === 'model-gate-failure-hook-invalid')

const loaderSrc = readFileSync('client/EntityLoader.js', 'utf8')
const appSrc = readFileSync('client/app.js', 'utf8')
assert.match(loaderSrc, /import \{ prefetchModel, refuseModelLoad \} from '\.\/core\/modelLoadGate\.js'/)
assert.match(loaderSrc, /await prefetchModel\(url, async \(\) =>/)
assert.match(loaderSrc, /const refusal = refuseModelLoad\(url, err\); console\.error\('\[gltf\]'/)
assert.match(appSrc, /import \{ runModelLoadGate, refuseModelLoad, shouldSendEnvironmentDone \} from '\.\/core\/modelLoadGate\.js'/)
assert.match(appSrc, /sendMark: \(\) => loadingMachine\.send\('MODELS_DONE'\)/)
assert.equal(appSrc.includes("prefetchModels(modelUrls).catch(() => {})"), false)
assert.equal(appSrc.includes("prefetchModels([u]).catch(() => {})"), false)

console.log('RESULT: PASS model load gate refuses coded failures, withholds MODELS_DONE, and EntityLoader/app.js no longer swallow 404s')
