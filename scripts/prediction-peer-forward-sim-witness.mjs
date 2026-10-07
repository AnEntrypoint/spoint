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
const CONDITIONS = strArg(args.cond, '0/0/0;50/10/2;100/20/3').split(';')
const REPS = numArg(args.reps, 2)
const DURATION = strArg(args.duration, '15000')
const WORLD = strArg(args.world, 'arena')
const HOLD = strArg(args.hold, 'forward')
const ARMS = strArg(args.arms, 'push,control').split(',')
const MAX_ERR_CM = numArg(args.maxErrCm, Infinity)
const MAX_POPS = numArg(args.maxPops, Infinity)
const ROW = numArg(args.row, 2)

const ARM_FLAGS = { push: [], control: ['--peerSeparation=off'] }

function pct(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))]
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}

function runArm(cond, arm, repIdx) {
  const out = resolve(SDK_ROOT, 'data', 'netcode-harness', `witness-${process.pid}-${repIdx}.json`)
  const argv = [
    HARNESS,
    `--world=${WORLD}`,
    `--hold=${HOLD}`,
    '--precise',
    `--duration=${DURATION}`,
    '--predict=on',
    `--cond=${cond}`,
    `--out=${out}`,
    ...ARM_FLAGS[arm]
  ]
  execFileSync(process.execPath, argv, { cwd: SDK_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPOINT_NO_WATCH: '1', SPOINT_SKIP_PREWARM: '1' } })
  return out
}

function readArm(path) {
  return readFile(path, 'utf8').then(JSON.parse)
}

function metrics(result) {
  const m = result.mispredict || {}
  const ps = result.peerSeparation || {}
  const drawn = result.drawn || {}
  const ackCount = (m.errM && m.errM.n) || 0
  return {
    acks: ackCount,
    corrections: m.correctionsApplied || 0,
    corrPerAck: ackCount ? (m.correctionsApplied || 0) / ackCount : NaN,
    errP95Cm: (m.errM?.p95 ?? NaN) * 100,
    popsPerMin: result.localVisual?.popsPerMin ?? NaN,
    renderOffP95Cm: (drawn.renderOffsetM?.p95 ?? NaN) * 100,
    tickHz: result.ticks?.hz ?? NaN,
    snapHz: result.snapshots?.hz ?? NaN,
    downKBps: result.bandwidth?.downKBps ?? NaN,
    sepFiredFrac: ps.sepFiredFrac ?? NaN,
    sepPushP50Cm: (ps.sepPushM?.p50 ?? NaN) * 100,
    sepPushP95Cm: (ps.sepPushM?.p95 ?? NaN) * 100,
    peerMinDistP50M: ps.peerMinDistM?.p50 ?? NaN,
    leadP95Ticks: ps.stepLeadTicks?.p95 ?? NaN,
    leadMaxTicks: ps.stepLeadTicks?.max ?? NaN,
    horizonP95Ticks: ps.horizonTicks?.p95 ?? NaN
  }
}

function pool(rows) {
  const acks = rows.reduce((s, r) => s + r.acks, 0)
  const corrections = rows.reduce((s, r) => s + r.corrections, 0)
  return {
    acks, corrections,
    corrPerAck: acks ? corrections / acks : NaN,
    errP95Cm: median(rows.map(r => r.errP95Cm)),
    popsPerMin: median(rows.map(r => r.popsPerMin)),
    renderOffP95Cm: median(rows.map(r => r.renderOffP95Cm)),
    tickHz: median(rows.map(r => r.tickHz)),
    sepFiredFrac: median(rows.map(r => r.sepFiredFrac)),
    sepPushP50Cm: median(rows.map(r => r.sepPushP50Cm)),
    sepPushP95Cm: median(rows.map(r => r.sepPushP95Cm)),
    peerMinDistP50M: median(rows.map(r => r.peerMinDistP50M)),
    leadP95Ticks: median(rows.map(r => r.leadP95Ticks)),
    leadMaxTicks: Math.max(...rows.map(r => r.leadMaxTicks)),
    horizonP95Ticks: median(rows.map(r => r.horizonP95Ticks))
  }
}

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const outFiles = []
const table = []
const verdicts = []

for (const cond of CONDITIONS) {
  const pooled = {}
  for (const arm of ARMS) {
    const rows = []
    for (let rep = 0; rep < REPS; rep++) {
      const out = runArm(cond, arm, rep)
      outFiles.push(out)
      const j = await readArm(out)
      rows.push(metrics(j.results[0]))
    }
    pooled[arm] = { rows, agg: pool(rows) }
  }
  const push = pooled.push.agg, control = pooled.control.agg
  const fail = []
  if (!(push.corrPerAck < control.corrPerAck)) fail.push(`corr/ack ${fmt(push.corrPerAck)} is not below control ${fmt(control.corrPerAck)}`)
  if (!(push.errP95Cm <= control.errP95Cm)) fail.push(`errP95 ${fmt(push.errP95Cm, 2)}cm > control ${fmt(control.errP95Cm, 2)}cm`)
  if (!(push.errP95Cm <= MAX_ERR_CM)) fail.push(`errP95 ${fmt(push.errP95Cm, 2)}cm > cap ${MAX_ERR_CM}cm`)
  const rowOne = []
  if (!(push.popsPerMin <= control.popsPerMin)) rowOne.push(`pops/min ${fmt(push.popsPerMin, 1)} > control ${fmt(control.popsPerMin, 1)}`)
  if (!(push.renderOffP95Cm <= control.renderOffP95Cm)) rowOne.push(`renderOffP95 ${fmt(push.renderOffP95Cm, 2)}cm > control ${fmt(control.renderOffP95Cm, 2)}cm`)
  if (!(push.popsPerMin <= MAX_POPS)) rowOne.push(`pops/min ${fmt(push.popsPerMin, 1)} > cap ${MAX_POPS}`)
  if (ROW <= 1) fail.push(...rowOne)
  verdicts.push({ cond, push, control, fail })
  for (const arm of ARMS) {
    const a = pooled[arm].agg
    table.push(`| ${cond} | ${arm} | ${a.acks} | ${a.corrections} | ${fmt(a.corrPerAck)} | ${fmt(a.errP95Cm, 2)} | ${fmt(a.popsPerMin, 1)} | ${fmt(a.renderOffP95Cm, 2)} | ${fmt(a.tickHz, 1)} | ${fmt(a.sepFiredFrac * 100, 0)}% | ${fmt(a.sepPushP50Cm, 2)} | ${fmt(a.leadP95Ticks, 0)}/${fmt(a.leadMaxTicks, 0)} | ${fmt(a.peerMinDistP50M)} |`)
  }
}

const header = '| one-way ms/jitter/loss | arm | acks | corrections | corrections per ack | err p95 cm | pops/min | render offset p95 cm | tick Hz | sep fired % | sep push p50 cm | lead ticks p95/max | peer dist p50 m |\n|' + '---|'.repeat(13)
console.log('\n' + [header, ...table].join('\n') + '\n')
const ROW_AXES = ROW <= 1 ? 'corrections/ack, err p95, pops/min, rendered-offset p95 (row 1 bar)' : 'corrections/ack, err p95 (row 2 bar)'
console.log('per-condition verdict (push vs --peerSeparation=off control), gated on ' + ROW_AXES + ':')
for (const v of verdicts) {
  console.log(`  ${v.cond}: corrections/ack ${fmt(v.push.corrPerAck)} vs control ${fmt(v.control.corrPerAck)} | errP95 ${fmt(v.push.errP95Cm, 2)} vs ${fmt(v.control.errP95Cm, 2)} cm | pops/min ${fmt(v.push.popsPerMin, 1)} vs ${fmt(v.control.popsPerMin, 1)} | renderOffP95 ${fmt(v.push.renderOffP95Cm, 2)} vs ${fmt(v.control.renderOffP95Cm, 2)} cm | ${v.fail.length ? 'FAIL: ' + v.fail.join('; ') : 'PASS'}`)
}
for (const f of outFiles) await rm(f, { force: true })
const failed = verdicts.filter(v => v.fail.length)
if (failed.length) { console.error(`\n[prediction-peer-forward-sim-witness] RESULT: FAIL (${failed.length}/${verdicts.length} condition(s))`); process.exit(1) }
console.log('\n[prediction-peer-forward-sim-witness] RESULT: PASS')
process.exit(0)
