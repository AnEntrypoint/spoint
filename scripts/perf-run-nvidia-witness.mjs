import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LABEL = 'nvidia-witness'
const OUT = path.join(ROOT, 'data', 'perf-run', `${LABEL}.json`)

if (process.platform !== 'win32') {
  console.log(`RESULT: BLOCKED perf-run NVIDIA measurement: this host is ${process.platform}, not win32, and perf-run needs a DirectX NVIDIA adapter. Run it on a Windows host with an NVIDIA GPU from the repo root with: node scripts/perf-run-nvidia-witness.mjs`)
  process.exit(2)
}

const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'perf-run.mjs'), '--gpu=nvidia', '--expect-vendor=nvidia', `--label=${LABEL}`], { cwd: ROOT, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024 })
if (run.error || run.status !== 0) {
  console.log((run.stdout || '').slice(-4000))
  console.error(run.stderr || run.error?.message || `perf-run exited ${run.status}`)
  console.log(`RESULT: FAIL perf-run NVIDIA measurement: perf-run exited ${run.status}`)
  process.exit(1)
}
if (!existsSync(OUT)) {
  console.log(`RESULT: FAIL perf-run NVIDIA measurement: ${path.relative(ROOT, OUT)} was not written`)
  process.exit(1)
}

const result = JSON.parse(readFileSync(OUT, 'utf8'))
const f = result.frames || {}
const hasAverage = (node) => node && typeof node === 'object' && Object.entries(node).some(([k, v]) => k === 'avgMs' || hasAverage(v))
const checks = [
  ['frames were counted', f.count > 0, `count ${f.count}`],
  ['p50Ms <= p95Ms <= p99Ms <= maxMs', f.p50Ms <= f.p95Ms && f.p95Ms <= f.p99Ms && f.p99Ms <= f.maxMs, `p50 ${f.p50Ms} p95 ${f.p95Ms} p99 ${f.p99Ms} max ${f.maxMs}`],
  ['fps follows the p50 frame time', f.fps > 0 && Math.abs(f.fps - 1000 / f.p50Ms) < 0.5, `fps ${f.fps}, p50 ${f.p50Ms}`],
  ['the result carries no average field (avgMs)', !hasAverage(result), 'recursive key scan of the perf-run result'],
]
let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
}
console.log(failed
  ? `RESULT: FAIL perf-run NVIDIA measurement: ${failed} of ${checks.length} check(s) failed on ${path.relative(ROOT, OUT)}`
  : `RESULT: PASS perf-run NVIDIA measurement: ${f.count} frames, p50Ms ${f.p50Ms}, p95Ms ${f.p95Ms}, p99Ms ${f.p99Ms}, maxMs ${f.maxMs}`)
process.exit(failed ? 1 : 0)
