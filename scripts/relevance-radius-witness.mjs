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
const COUNTS = strArg(args.counts, '8,24,64').split(',').map(Number).filter(Number.isFinite)
const RADIUS = numArg(args.radius, 120)
const REPS = numArg(args.reps, 2)
const DURATION = strArg(args.duration, '10000')
const COND = strArg(args.cond, '0/0/0')
const TICK = numArg(args.tick, 60)
const TICK_WINDOW_HZ = numArg(args.tickWindowHz, 3)
const WORTH_PCT = numArg(args.worthPct, 25)
const WORLD = strArg(args.world, 'arena')
const AT = strArg(args.at, '0,1.2,-95')

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-')
const outFiles = []

async function collect(tag, bots, extraFlags) {
  const out = resolve(SDK_ROOT, 'data', 'netcode-harness', `relevance-${process.pid}-${tag}.json`)
  const argv = [
    HARNESS,
    `--world=${WORLD}`,
    '--precise',
    `--tick=${TICK}`,
    `--duration=${DURATION}`,
    '--predict=off',
    '--kinds=off',
    `--cond=${COND}`,
    `--bots=${bots}`,
    `--out=${out}`,
    `--at=${AT}`,
    ...extraFlags,
  ]
  execFileSync(process.execPath, argv, { cwd: SDK_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPOINT_NO_WATCH: '1', SPOINT_SKIP_PREWARM: '1' } })
  outFiles.push(out)
  return JSON.parse(await readFile(out, 'utf8')).results[0]
}

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return NaN
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}

function metrics(r) {
  return {
    tickHz: r.ticks?.hz ?? NaN,
    snapHz: r.snapshots?.hz ?? NaN,
    downKBps: r.bandwidth?.downKBps ?? NaN,
    snapshotBytesAvg: r.bandwidth?.snapshotBytesAvg ?? NaN,
    shotCount: r.hitReg?.shots ?? 0,
    hitRate: r.hitReg?.hitRate ?? NaN,
    remotePops: r.remotePops?.pops ?? NaN,
  }
}

const failures = []
const table = []
const decisions = []

for (const count of COUNTS) {
  const bots = Math.max(0, count - 2)
  const rows = {}
  for (const arm of ['off', 'on']) {
    const list = []
    for (let rep = 0; rep < REPS; rep++) {
      const r = await collect(`${count}-${arm}-${rep}`, bots, arm === 'on' ? [`--relevance=${RADIUS}`] : [])
      const m = metrics(r)
      if (Math.abs(m.tickHz - TICK) > TICK_WINDOW_HZ) { list.push(null); continue }
      list.push(m)
    }
    const kept = list.filter(Boolean)
    rows[arm] = {
      kept: kept.length,
      tickHz: median(kept.map(m => m.tickHz)),
      snapHz: median(kept.map(m => m.snapHz)),
      downKBps: median(kept.map(m => m.downKBps)),
      snapshotBytesAvg: median(kept.map(m => m.snapshotBytesAvg)),
      hitRate: median(kept.map(m => m.hitRate)),
      shotCount: kept.reduce((s, m) => s + m.shotCount, 0),
      remotePops: median(kept.map(m => m.remotePops)),
    }
    if (kept.length === 0) failures.push(`${count} player(s), relevance ${arm}: no rep landed within ${TICK}+-${TICK_WINDOW_HZ} Hz, so this arm is unmeasured`)
  }
  const off = rows.off, on = rows.on
  const bytePct = (off.snapshotBytesAvg > 0 && Number.isFinite(on.snapshotBytesAvg)) ? (1 - on.snapshotBytesAvg / off.snapshotBytesAvg) * 100 : NaN
  const downPct = (off.downKBps > 0 && Number.isFinite(on.downKBps)) ? (1 - on.downKBps / off.downKBps) * 100 : NaN
  const worthIt = Number.isFinite(bytePct) && bytePct >= WORTH_PCT && (on.hitRate >= off.hitRate - 0.01)
  decisions.push({ count, bytePct, downPct, worthIt, off, on })
  for (const arm of ['off', 'on']) {
    const a = rows[arm]
    table.push(`| ${count} | ${arm === 'on' ? `${RADIUS} m` : 'off'} | ${a.kept}/${REPS} | ${fmt(a.tickHz, 1)} | ${fmt(a.snapHz, 1)} | ${fmt(a.snapshotBytesAvg, 0)} | ${fmt(a.downKBps, 2)} | ${fmt(a.hitRate, 3)} | ${fmt(a.remotePops, 1)} |`)
  }
}

console.log(`\nrelevance radius ${RADIUS} m vs off, world "${WORLD}", cond ${COND}, tick ${TICK} Hz, ${REPS} rep(s) of ${DURATION} ms`)
console.log('| players | relevance | reps kept | tick Hz | snap Hz | snap bytes/snapshot | KB/s down (mover) | hit rate | remote pops |')
console.log('|' + '---|'.repeat(9))
for (const line of table) console.log(line)
console.log('\nper-count decision (counted units: bytes per snapshot at the mover, downstream KB/s at the mover):')
for (const d of decisions) {
  console.log(`  ${d.count} player(s): snapshot bytes ${fmt(d.off.snapshotBytesAvg, 0)} -> ${fmt(d.on.snapshotBytesAvg, 0)} (${fmt(d.bytePct, 1)}% cut), downstream ${fmt(d.off.downKBps, 2)} -> ${fmt(d.on.downKBps, 2)} KB/s (${fmt(d.downPct, 1)}% cut), hit rate ${fmt(d.off.hitRate, 3)} -> ${fmt(d.on.hitRate, 3)} -- ${d.worthIt ? `WORTH ENABLING at >=${WORTH_PCT}%` : `NOT worth enabling at >=${WORTH_PCT}%`}`)
}
const anyWorth = decisions.filter(d => d.worthIt)
console.log(`\nDECISION: interest management ${anyWorth.length ? `earns its complexity at ${anyWorth.map(d => d.count).join(', ')} player(s)` : `does not reach the ${WORTH_PCT}% byte cut at any measured count (${COUNTS.join(', ')}), so leaving relevanceRadius off by default is the honest default at these world sizes`}`)

for (const f of outFiles) await rm(f, { force: true })
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`\nRESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
console.log('\nRESULT: PASS')
process.exit(0)
