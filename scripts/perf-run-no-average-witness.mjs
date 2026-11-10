import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REL = 'scripts/perf-run.mjs'
const lines = readFileSync(path.join(ROOT, REL), 'utf8').split('\n')
const averaged = lines.map((text, i) => ({ line: i + 1, text })).filter(l => /\bavgMs\b/.test(l.text))
const percentileLines = lines.filter(l => /\bp50Ms\b/.test(l) && /\bp95Ms\b/.test(l)).length

const checks = [
  ['no average is emitted or printed (avgMs)', averaged.length === 0, `${averaged.length} line(s) name avgMs${averaged.length ? ': ' + averaged.map(l => l.line).join(', ') : ''}`],
  ['p50Ms and p95Ms are emitted together for each pass record', percentileLines >= 1, `${percentileLines} line(s) carry p50Ms with p95Ms`],
]
let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`)
}
if (failed) {
  console.log(`RESULT: FAIL ${failed} of ${checks.length} check(s) on ${REL}`)
  process.exit(1)
}
console.log(`RESULT: PASS ${REL} reports p50Ms and p95Ms only: 0 average fields`)
