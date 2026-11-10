import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { percentile, summarizeFrames } from './lib/frame-percentile.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PERF_RUN = path.join(ROOT, 'scripts', 'perf-run.mjs')

const ramp = Array.from({ length: 100 }, (_, i) => i + 1)
const skewed = [16, 16, 16, 16, 16, 16, 16, 16, 16, 200]
const mean = skewed.reduce((a, b) => a + b, 0) / skewed.length
let seed = 11
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
const noisy = Array.from({ length: 500 }, () => 8 + random() * 40)
const summary = summarizeFrames(skewed)
const noisySummary = summarizeFrames(noisy)
const perfRunSource = readFileSync(PERF_RUN, 'utf8')
const localDefinition = /^function percentile\(/m.test(perfRunSource)
const averaged = perfRunSource.split('\n').filter(l => /\bavgMs\b/.test(l)).length

const checks = [
  ['an empty sample reads as 0 from percentile', percentile([], 0.5) === 0, `percentile([], 0.5) = ${percentile([], 0.5)}`],
  ['the index rule takes sorted[floor(p * n)] on a 1..100 ramp for p50', percentile(ramp, 0.5) === 51, `p50 = ${percentile(ramp, 0.5)}, expected 51`],
  ['the index rule takes sorted[floor(p * n)] on a 1..100 ramp for p95', percentile(ramp, 0.95) === 96, `p95 = ${percentile(ramp, 0.95)}, expected 96`],
  ['p=1 clamps to the last sample on a 1..100 ramp', percentile(ramp, 1) === 100, `p100 = ${percentile(ramp, 1)}, expected 100`],
  ['p50 of a skewed frame set is the typical frame, not the mean', summary.p50Ms === 16 && Math.abs(summary.p50Ms - mean) > 10, `p50Ms = ${summary.p50Ms}, mean ${mean.toFixed(2)}`],
  ['p95 of the skewed frame set reaches the long frame', summary.p95Ms === 200, `p95Ms = ${summary.p95Ms}, expected 200`],
  ['maxMs is the longest frame', summary.maxMs === 200, `maxMs = ${summary.maxMs}, expected 200`],
  ['fps is 1000 over the p50 frame time', summary.fps === 62.5, `fps = ${summary.fps}, expected 62.5 (1000 / 16)`],
  ['frame count is the number of deltas', summary.count === skewed.length, `count = ${summary.count}, expected ${skewed.length}`],
  ['summary ordering holds on a noisy sample: minMs <= p50Ms <= p95Ms <= p99Ms <= maxMs', noisySummary.minMs <= noisySummary.p50Ms && noisySummary.p50Ms <= noisySummary.p95Ms && noisySummary.p95Ms <= noisySummary.p99Ms && noisySummary.p99Ms <= noisySummary.maxMs, `min ${noisySummary.minMs} p50 ${noisySummary.p50Ms} p95 ${noisySummary.p95Ms} p99 ${noisySummary.p99Ms} max ${noisySummary.maxMs}`],
  ['summarizeFrames does not reorder the caller array', (() => { const d = [30, 10, 20]; summarizeFrames(d); return d[0] === 30 && d[1] === 10 && d[2] === 20 })(), 'input [30, 10, 20] keeps its order after the summary'],
  ['perf-run.mjs takes percentile from the shared lib, with no local definition', !localDefinition && /from '\.\/lib\/frame-percentile\.mjs'/.test(perfRunSource), `local percentile definition: ${localDefinition}`],
  ['perf-run.mjs emits no average field (avgMs)', averaged === 0, `${averaged} line(s) name avgMs`],
]

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
}
if (failed) {
  console.log(`RESULT: FAIL ${failed} of ${checks.length} check(s) on scripts/lib/frame-percentile.mjs`)
  process.exit(1)
}
console.log(`RESULT: PASS scripts/lib/frame-percentile.mjs: p50, p95, p99 and max follow the index rule on fixtures, and perf-run.mjs reports them from the shared lib with no average`)
