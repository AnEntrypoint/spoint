#!/usr/bin/env node
// Decides whether the ground-height memo may quantise its key, and prices the alternatives.
//
// Quantising the memo key only buys hits if the sampler is asked for NEARLY the same point twice;
// it is only legal if two points inside one quantum cell have the SAME height. This witness
// measures both halves against the real mapspinner CPU height sampler and the real PlanetFrame:
//
//   1. height spread inside a spatial quantum (a property of the terrain, not of any call
//      pattern): over random centres and random offsets inside radius q, the max and p99 of
//      |groundHeightLocal(x,z) - groundHeightLocal(x+dx,z+dz)|.
//   2. the cost of one miss, decomposed into solve evaluations, so a change that lowers the
//      evaluation count can be priced without changing a height.
//   3. the dedupable fraction of a replay-shaped ask stream: L steps re-walked every frame from a
//      base that advances one tick and jitters by the reconciliation error.
//
// Nothing here writes to the repo and nothing here changes a height.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { flagNumber } from './lib/witness-args.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLANET_FRAME = resolve(ROOT, 'src/terrain/PlanetFrame.js')
const HEIGHT_CPU = resolve(ROOT, 'node_modules/mapspinner/src/height-cpu.js')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const RADIUS = flagNumber(flag, 'radius', 63600, argv)
const SEED = flagNumber(flag, 'seed', 1337, argv)
const CENTRES = Math.round(flagNumber(flag, 'centres', 400, argv))
const OFFSETS = Math.round(flagNumber(flag, 'offsets', 8, argv))
const REPLAY_FRAMES = Math.round(flagNumber(flag, 'replay-frames', 600, argv))
const REPLAY_LEN = Math.round(flagNumber(flag, 'replay-len', 16, argv))
const REPLAY_ERR_M = flagNumber(flag, 'replay-err', 0.015, argv)
const SPEED_MPS = flagNumber(flag, 'speed', 5, argv)
const FPS = flagNumber(flag, 'fps', 60, argv)

// SURFACE_SOLVE_TOLERANCE_M (1e-4) is what the solve converges to; a quantisation whose spread is
// not below it moves a height by more than the solver's own error bar.
const SOLVE_TOLERANCE_M = 1e-4
const QUANTA = [1e-4, 1e-3, 1e-2, 0.05, 0.25, 1]

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)

// Deterministic LCG so the witness is reproducible run to run.
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

function pct(list, p) {
  if (!list.length) return NaN
  const s = list.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

async function main() {
  const { createHeightSampler } = await import(pathToFileURL(HEIGHT_CPU).href)
  const M = await import(pathToFileURL(PLANET_FRAME).href)
  const sampler = createHeightSampler({ radius: RADIUS, seed: SEED, reliefScale: 0.01, hashVersion: 2 })
  console.log(`[ground-quantum] sampler hashVersion=${sampler.hashVersion} radius=${RADIUS} seed=${SEED}`)
  const frame = M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  for (let i = 0; i < 200; i++) frame.groundHeightLocal(i * 3, -i * 2)

  const rand = rng(0x5eed)
  const spread = {}
  for (const q of QUANTA) {
    const diffs = []
    let pairs = 0
    for (let c = 0; c < CENTRES; c++) {
      const cx = (rand() * 2 - 1) * 400
      const cz = (rand() * 2 - 1) * 400
      const base = frame.groundHeightLocal(cx, cz)
      if (!Number.isFinite(base)) continue
      for (let o = 0; o < OFFSETS; o++) {
        const ang = rand() * Math.PI * 2
        const r = Math.sqrt(rand()) * q
        const h = frame.groundHeightLocal(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r)
        if (!Number.isFinite(h)) continue
        diffs.push(Math.abs(h - base)); pairs++
      }
    }
    spread[q] = {
      pairs,
      maxAbsDiffM: Math.round(Math.max(...diffs) * 1e7) / 1e7,
      p99AbsDiffM: Math.round(pct(diffs, 0.99) * 1e7) / 1e7,
      meanAbsDiffM: Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 1e7) / 1e7,
    }
  }
  console.log('[ground-quantum] spread ' + JSON.stringify(spread, null, 2))

  // Cost of one miss, decomposed.
  M.resetGroundMemoStats(); M.resetSurfaceSolveStats()
  const N_MISS = 4096
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N_MISS; i++) frame.groundHeightLocal(1e4 + i * 0.37, -7e3 + i * 0.53)
  const missMs = Number(process.hrtime.bigint() - t0) / 1e6
  const solve = M.surfaceSolveStats()
  const memo = M.groundMemoStats()
  const usPerMiss = missMs * 1000 / Math.max(1, memo.misses)
  const evalsPerSolve = solve.evaluations / Math.max(1, solve.solves)
  const usPerEval = usPerMiss / evalsPerSolve
  console.log(`[ground-quantum] miss cost: ${Math.round(usPerMiss * 100) / 100} us/miss, ${Math.round(evalsPerSolve * 100) / 100} evals/solve, ${Math.round(usPerEval * 100) / 100} us/eval`)

  // Replay-shaped stream: every frame re-walks REPLAY_LEN steps from a base that advanced one tick
  // and sits REPLAY_ERR_M away from where the previous replay thought it was.
  const step = SPEED_MPS / FPS
  const dedup = {}
  const seenExact = new Set()
  let calls = 0, exactDup = 0
  const t1 = process.hrtime.bigint()
  for (let f = 0; f < REPLAY_FRAMES; f++) {
    const baseX = f * step, baseZ = f * step * 0.5
    const jx = baseX + (rand() * 2 - 1) * REPLAY_ERR_M
    const jz = baseZ + (rand() * 2 - 1) * REPLAY_ERR_M
    for (let k = 0; k < REPLAY_LEN; k++) {
      const x = jx + k * step, z = jz + k * step * 0.5
      calls++
      const key = x + ':' + z
      if (seenExact.has(key)) exactDup++
      else seenExact.add(key)
      frame.groundHeightLocal(x, z)
    }
  }
  const replayMs = Number(process.hrtime.bigint() - t1) / 1e6
  dedup.exact = Math.round((exactDup / calls) * 10000) / 100
  console.log(`[ground-quantum] replay stream: ${calls} calls over ${REPLAY_FRAMES} frames = ${Math.round((calls / REPLAY_FRAMES) * 100) / 100}/frame, ${Math.round((replayMs / REPLAY_FRAMES) * 10000) / 10000} ms/frame, exact-dup ${dedup.exact}%`)

  // How well-defined is "the height" at a point? solveSurfaceY is a seeded fixed point, so a
  // result is only meaningfully reproducible if the seed does not move it. Measure both halves:
  // the same seed twice (must be bit-identical) and a seed nudged by a known amount.
  const SEED_NUDGES = [0, 1e-3, 1e-2, 0.1, 1, 10]
  const seedSens = {}
  for (const n of SEED_NUDGES) seedSens[n] = { max: 0, meanSum: 0, n: 0 }
  const N_SEED = 300
  for (let i = 0; i < N_SEED; i++) {
    const x = (rand() * 2 - 1) * 400, z = (rand() * 2 - 1) * 400
    const g0 = frame.groundHeightLocal(x, z)
    if (!Number.isFinite(g0)) continue
    for (const nudge of SEED_NUDGES) {
      const a = frame.solveSurfaceY(x, z, frame.cpuElevationAtDir, SOLVE_TOLERANCE_M, g0)
      const b = frame.solveSurfaceY(x, z, frame.cpuElevationAtDir, SOLVE_TOLERANCE_M, g0 + nudge)
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const d = Math.abs(a - b)
      const rec = seedSens[nudge]
      if (d > rec.max) rec.max = d
      rec.meanSum += d; rec.n++
    }
  }
  const seedReport = {}
  for (const nudge of SEED_NUDGES) {
    const rec = seedSens[nudge]
    rec.mean = rec.n ? Math.round((rec.meanSum / rec.n) * 1e9) / 1e9 : NaN
    rec.max = Math.round(rec.max * 1e9) / 1e9
    delete rec.meanSum
    const tag = String(nudge).replace('.', 'p')
    seedReport[`seedNudge_${tag}_maxAbsDiffM`] = rec.max
  }
  console.log('[ground-quantum] seed sensitivity (nudge -> |result(g0) - result(g0+nudge)|) ' + JSON.stringify(seedSens, null, 2))

  const report = {
    samplerHashVersion: expect('samplerHashVersion', sampler.hashVersion, (v) => Number.isFinite(v) && v > 0),
    solveToleranceM: expect('solveToleranceM', SOLVE_TOLERANCE_M, (v) => v === 1e-4),
    usPerMiss: expect('usPerMiss', Math.round(usPerMiss * 100) / 100, (v) => finite(v) && v > 0),
    evalsPerSolve: expect('evalsPerSolve', Math.round(evalsPerSolve * 100) / 100, (v) => finite(v) && v > 0 && v <= 64),
    usPerEval: expect('usPerEval', Math.round(usPerEval * 100) / 100, (v) => finite(v) && v > 0),
    replay_callsPerFrame: expect('replay_callsPerFrame', Math.round((calls / REPLAY_FRAMES) * 100) / 100, (v) => finite(v) && v > 0),
    replay_msPerFrame: expect('replay_msPerFrame', Math.round((replayMs / REPLAY_FRAMES) * 10000) / 10000, (v) => finite(v) && v > 0),
    replay_exactDupPct: expect('replay_exactDupPct', dedup.exact, (v) => finite(v) && v >= 0 && v <= 100),
  }
  for (const q of QUANTA) {
    const s = spread[q]
    const tag = String(q).replace('.', 'p')
    report[`spread_${tag}_pairs`] = expect(`spread_${tag}_pairs`, s.pairs, (v) => Number.isFinite(v) && v > 0)
    report[`spread_${tag}_maxAbsDiffM`] = expect(`spread_${tag}_maxAbsDiffM`, s.maxAbsDiffM, (v) => finite(v) && v >= 0)
    report[`spread_${tag}_p99AbsDiffM`] = expect(`spread_${tag}_p99AbsDiffM`, s.p99AbsDiffM, (v) => finite(v) && v >= 0)
  }
  for (const key of Object.keys(seedReport)) {
    expect(key, seedReport[key], (v) => finite(v) && v >= 0)
    if (key === 'seedNudge_0_maxAbsDiffM') expect('seedNudge_zero_isZero', seedReport[key], (v) => v === 0)
    report[key] = seedReport[key]
  }
  // The decision this witness exists to make: a quantum is only legal while its spread is at or
  // under the solver's own tolerance. Report, do not assert, which quanta clear the bar.
  const legal = QUANTA.filter((q) => spread[q].maxAbsDiffM <= SOLVE_TOLERANCE_M)
  console.log('[ground-quantum] quanta whose max spread is <= the 1e-4 m solve tolerance: ' + JSON.stringify(legal))

  console.log('[ground-quantum] measurements ' + JSON.stringify(report, null, 2))
  for (const f of failures) console.log(`FAIL: ${f}`)
  if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
  else console.log('RESULT: PASS')
  process.exitCode = failures.length ? 1 : 0
}

main().catch((e) => {
  console.error('[ground-quantum] threw: ' + String((e && e.stack) || e))
  console.log('RESULT: FAIL (1 of 1 measurement(s))')
  process.exitCode = 1
})
