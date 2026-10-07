#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { parseArgs, numArg, strArg } from './lib/witness-args.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = resolve(SDK_ROOT, 'scripts', 'netcode-conditioner-harness.mjs')

const args = parseArgs(process.argv.slice(2))
const WORLD = strArg(args.world, 'slope')
const WANT_KIND = strArg(args.kind, 'slope')
const TICK = numArg(args.tick, 60)
const TICK_WINDOW_HZ = numArg(args.tickWindowHz, 2)
const REPS = numArg(args.reps, 3)
const MAX_ATTEMPTS = numArg(args.maxAttempts, 8)
const DURATION = strArg(args.duration, '12000')
const COND = strArg(args.cond, '0/0/0')
const MIN_KIND_ACKS = numArg(args.minKindAcks, 50)
const HOLD = strArg(args.hold, 'forward')

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const outFiles = []

async function collect(repIdx, extraFlags) {
  const out = resolve(SDK_ROOT, 'data', 'netcode-harness', `slope-${process.pid}-${repIdx}.json`)
  const argv = [
    HARNESS,
    `--world=${WORLD}`,
    `--hold=${HOLD}`,
    '--precise',
    `--tick=${TICK}`,
    `--duration=${DURATION}`,
    '--predict=on',
    `--cond=${COND}`,
    `--out=${out}`,
    ...extraFlags,
  ]
  execFileSync(process.execPath, argv, { cwd: SDK_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPOINT_NO_WATCH: '1', SPOINT_SKIP_PREWARM: '1' } })
  outFiles.push(out)
  return JSON.parse(await readFile(out, 'utf8'))
}

function kindStats(result) {
  const byKind = result.mispredict?.byKind || {}
  const keys = Object.keys(byKind).filter(k => k.includes(WANT_KIND))
  const acks = keys.reduce((s, k) => s + (byKind[k].acks || 0), 0)
  const mis = keys.reduce((s, k) => s + (byKind[k].mis || 0), 0)
  const p95 = Math.max(...keys.map(k => byKind[k].errM?.p95 ?? NaN))
  return { keys, acks, misRate: acks ? mis / acks : NaN, errP95Cm: Number.isFinite(p95) ? p95 * 100 : NaN }
}

const failures = []
const accepted = []
const discarded = []
let attempt = 0

while (accepted.length < REPS && attempt < MAX_ATTEMPTS) {
  attempt++
  const j = await collect(attempt, [])
  const r = j.results[0]
  const hz = r.ticks?.hz ?? NaN
  const ok = Math.abs(hz - TICK) <= TICK_WINDOW_HZ
  const row = { attempt, hz, errP95Cm: (r.mispredict?.errM?.p95 ?? NaN) * 100, corrPerAck: r.mispredict?.correctionRate ?? NaN, kinds: kindStats(r) }
  if (!ok) { discarded.push({ ...row, why: `tick ${fmt(hz, 1)} Hz is outside ${TICK}+-${TICK_WINDOW_HZ} Hz` }); continue }
  accepted.push(row)
}

const inert = []
for (let i = 0; i < REPS; i++) {
  const j = await collect(1000 + i, ['--kinds=off'])
  const r = j.results[0]
  inert.push({ attempt: 1000 + i, hz: r.ticks?.hz ?? NaN, errP95Cm: (r.mispredict?.errM?.p95 ?? NaN) * 100, corrPerAck: r.mispredict?.correctionRate ?? NaN })
}
const inertInWindow = inert.filter(r => Math.abs(r.hz - TICK) <= TICK_WINDOW_HZ)

const spread = rows => (rows.length ? Math.max(...rows.map(r => r.errP95Cm)) - Math.min(...rows.map(r => r.errP95Cm)) : NaN)
const median = rows => { const v = rows.map(r => r.errP95Cm).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN }

const totalKindAcks = accepted.reduce((s, r) => s + r.kinds.acks, 0)
const kindKeys = [...new Set(accepted.flatMap(r => r.kinds.keys))].sort()
const noiseFloorCm = spread(accepted)
const inertMedianCm = median(inertInWindow)
const armMedianCm = median(accepted)
const inertDeltaCm = Math.abs(inertMedianCm - armMedianCm)

console.log(`\nworld "${WORLD}" at --tick=${TICK} (+-${TICK_WINDOW_HZ} Hz window), cond ${COND}, hold ${HOLD}`)
console.log(`accepted ${accepted.length}/${REPS} rep(s) after ${attempt} attempt(s); discarded ${discarded.length}`)
for (const d of discarded) console.log(`  discarded attempt ${d.attempt}: ${d.why}`)
console.log('| rep | tick Hz | kind acks | kind keys | kind misRate | kind err p95 cm | all err p95 cm | corr/ack |')
console.log('|' + '---|'.repeat(8))
for (const r of accepted) console.log(`| ${r.attempt} | ${fmt(r.hz, 1)} | ${r.kinds.acks} | ${r.kinds.keys.join('+') || '-'} | ${fmt(r.kinds.misRate)} | ${fmt(r.kinds.errP95Cm, 2)} | ${fmt(r.errP95Cm, 2)} | ${fmt(r.corrPerAck)} |`)
console.log(`\nmatched-rate noise floor (spread of errP95 across accepted reps at the same tick rate): ${fmt(noiseFloorCm, 2)} cm`)
console.log(`known-inert arm (--kinds=off changes instrumentation only): errP95 ${fmt(inertMedianCm, 2)} cm vs ${fmt(armMedianCm, 2)} cm, delta ${fmt(inertDeltaCm, 2)} cm over ${inertInWindow.length} in-window rep(s)`)

if (accepted.length === 0) failures.push(`no rep ran at ${TICK}+-${TICK_WINDOW_HZ} Hz after ${attempt} attempt(s), so the arm has no stable-tick-rate measurement`)
if (totalKindAcks < MIN_KIND_ACKS) failures.push(`the "${WANT_KIND}" contact regime produced ${totalKindAcks} acked step(s) across ${accepted.length} rep(s), below the ${MIN_KIND_ACKS} needed to count as coverage (kind keys seen: ${kindKeys.join(', ') || 'none'})`)
if (kindKeys.length === 0) failures.push(`no byKind key containing "${WANT_KIND}" was produced, so the world does not exercise the regime`)
if (inertInWindow.length === 0) failures.push(`no --kinds=off rep landed inside the tick window, so the noise floor is undemonstrated`)
else if (inertDeltaCm > Math.max(noiseFloorCm, 0.5)) failures.push(`a known-inert change moved errP95 by ${fmt(inertDeltaCm, 2)} cm, more than the ${fmt(Math.max(noiseFloorCm, 0.5), 2)} cm same-rate floor, so the tick window is not holding the arm stable`)

for (const f of outFiles) await rm(f, { force: true })
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`\nRESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
const medianTick = (() => { const v = accepted.map(r => r.hz).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : NaN })()
console.log(`\nRESULT: PASS -- "${WANT_KIND}" contact covered by ${totalKindAcks} acked step(s) over ${accepted.length} rep(s) at ${fmt(medianTick, 1)} Hz, kinds ${kindKeys.join('+')}`)
process.exit(0)
