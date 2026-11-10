import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { sampleTerrainGridChunked, timeFieldSteps } = await import(pathToFileURL(join(ROOT, 'src', 'terrain', 'HeightfieldStreamer.js')).href)

const negative = process.argv.includes('--neg')
const mode = negative ? 'negative' : 'positive'
const failures = []
const report = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

const N = 33, extent = 256, cornerX = -128, cornerZ = -128
const heightFn = (x, z) => Math.sin(x * 0.01) * 4 + z * 0.001

const stub = ({ delayMs = 0, bodyId = 7 } = {}) => {
  const calls = []
  return {
    calls,
    addHeightField(samples, n, scale, origin) {
      calls.push({ samples, n, scale, origin })
      if (delayMs > 0) {
        const until = Date.now() + delayMs
        while (Date.now() < until);
      }
      return bodyId
    },
  }
}

const delayMs = negative ? 0 : 30
const physics = stub({ delayMs })
const out = await timeFieldSteps({ physics, heightFn, N, extent, cornerX, cornerZ })

report('body-id-returned', out.bodyId === 7, `bodyId=${out.bodyId}`)
report('one-add-call', physics.calls.length === 1, `addHeightField calls=${physics.calls.length}`)
const call = physics.calls[0] ?? {}
report('field-size-passed', call.n === N && call.samples?.length === N * N, `n=${call.n} samples=${call.samples?.length} expected ${N * N}`)
report('field-scale-passed', call.scale?.[0] === extent / (N - 1) && call.scale?.[1] === 1, `scale=${JSON.stringify(call.scale)}`)
report('field-origin-passed', call.origin?.[0] === cornerX && call.origin?.[2] === cornerZ, `origin=${JSON.stringify(call.origin)}`)

const finite = [out.sampleMs, out.addMs, out.totalMs].every(v => Number.isFinite(v) && v >= 0)
report('steps-finite-nonnegative', finite, `sampleMs=${out.sampleMs} addMs=${out.addMs} totalMs=${out.totalMs}`)
report('total-is-sum-of-steps', Math.abs(out.totalMs - (out.sampleMs + out.addMs)) < 1e-9, `total=${out.totalMs} sum=${out.sampleMs + out.addMs}`)
report('add-step-timed', out.addMs >= 25, `addMs=${out.addMs} with a ${delayMs} ms Jolt step (expect >= 25)`)

const reference = await sampleTerrainGridChunked({ heightFn, N, spacing: extent / (N - 1), cornerX, cornerZ, budgetMs: 2 })
const sameSamples = reference.samples.length === call.samples.length && reference.samples.every((v, i) => v === call.samples[i])
report('samples-match-streamer-law', sameSamples, `${call.samples.length} samples compared with sampleTerrainGridChunked`)

const nanPhysics = stub()
await timeFieldSteps({ physics: nanPhysics, heightFn: () => NaN, N: 9, extent: 64, cornerX: 0, cornerZ: 0 })
const nanSamples = nanPhysics.calls[0].samples
report('non-finite-height-fallback', nanSamples.every(v => v === -1000), `min=${Math.min(...nanSamples)} max=${Math.max(...nanSamples)} expected -1000`)

const refusedPhysics = { addHeightField: () => null }
const refused = await timeFieldSteps({ physics: refusedPhysics, heightFn, N: 9, extent: 64, cornerX: 0, cornerZ: 0 })
report('refusal-passes-through', refused.bodyId === null && Number.isFinite(refused.addMs), `bodyId=${refused.bodyId} addMs=${refused.addMs}`)

if (failures.length === 0) console.log(`RESULT: PASS ${mode}: all checks ok`)
else console.log(`RESULT: FAIL ${mode}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
