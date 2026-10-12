#!/usr/bin/env node
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

const FRAMES = flagNumber(flag, 'frames', 600, argv)
const PER_FRAME = flagNumber(flag, 'per-frame', 64, argv)
const STEP_M = flagNumber(flag, 'step', 2, argv)
const METRES_PER_FRAME = flagNumber(flag, 'speed', 5, argv) / 60
const RADIUS = flagNumber(flag, 'radius', 63600, argv)
const SEED = flagNumber(flag, 'seed', 1337, argv)

const MIN_FRAMES = 600
const MIN_SAMPLES = 1

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

function gridSamples(centerX, centerZ, n, step) {
  const side = Math.round(Math.sqrt(n))
  const out = []
  const half = (side - 1) / 2
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      out.push([centerX + (i - half) * step, centerZ + (j - half) * step])
    }
  }
  return out
}

function walkPath(frame, frames, perFrame, step, metresPerFrame) {
  const seen = new Set()
  let idealHits = 0
  let calls = 0
  let x = 0, z = 0
  const t0 = process.hrtime.bigint()
  for (let f = 0; f < frames; f++) {
    x += metresPerFrame
    z += metresPerFrame * 0.5
    const pts = gridSamples(x, z, perFrame, step)
    for (let i = 0; i < pts.length; i++) {
      calls++
      const k = pts[i][0] + ':' + pts[i][1]
      if (seen.has(k)) idealHits++
      else seen.add(k)
      frame.groundHeightLocal(pts[i][0], pts[i][1])
    }
  }
  const ns = Number(process.hrtime.bigint() - t0)
  return { calls, idealHits, ms: ns / 1e6 }
}

async function main() {
  const { createHeightSampler } = await import(pathToFileURL(HEIGHT_CPU).href)
  const M = await import(pathToFileURL(PLANET_FRAME).href)
  const sampler = createHeightSampler({ radius: RADIUS, seed: SEED, reliefScale: 0.01, hashVersion: 2 })
  console.log(`[terrain-memo-node] sampler hashVersion=${sampler.hashVersion} radius=${RADIUS} seed=${SEED}`)

  const frame = M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  for (let i = 0; i < 200; i++) frame.groundHeightLocal(i * 3, -i * 2)

  M.resetGroundMemoStats()
  M.resetSurfaceSolveStats()
  const run = walkPath(frame, FRAMES, PER_FRAME, STEP_M, METRES_PER_FRAME)
  const memo = M.groundMemoStats()
  const solve = M.surfaceSolveStats()
  const total = memo.hits + memo.misses
  const perFrame = (n) => Math.round((n / FRAMES) * 10000) / 10000

  const probePts = []
  for (let i = 0; i < 512; i++) probePts.push([-400 + i * 1.37, 250 - i * 0.91])
  const coldA = new Float64Array(probePts.length)
  const freshA = M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  for (let i = 0; i < probePts.length; i++) coldA[i] = freshA.groundHeightLocal(probePts[i][0], probePts[i][1])
  const warm = new Float64Array(probePts.length)
  for (let i = 0; i < probePts.length; i++) warm[i] = freshA.groundHeightLocal(probePts[i][0], probePts[i][1])
  const coldB = new Float64Array(probePts.length)
  const freshB = M.createPlanetFrame({ sampler, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.01 })
  for (let i = 0; i < probePts.length; i++) coldB[i] = freshB.groundHeightLocal(probePts[i][0], probePts[i][1])

  const report = {
    frames: expect('frames', FRAMES, (v) => v >= MIN_FRAMES),
    samplerHashVersion: expect('samplerHashVersion', sampler.hashVersion, (v) => v > 0),
    memo_samples: expect('memo_samples', total, (v) => v >= MIN_SAMPLES),
    memo_hits: expect('memo_hits', memo.hits, (v) => v >= 0),
    memo_misses: expect('memo_misses', memo.misses, (v) => v > 0),
    memo_hitRatePct: expect('memo_hitRatePct', Math.round((memo.hits / total) * 10000) / 100, (v) => finite(v) && v >= 0 && v <= 100),
    memo_idealHitRatePct: expect('memo_idealHitRatePct', Math.round((run.idealHits / run.calls) * 10000) / 100, (v) => finite(v) && v >= 0 && v <= 100),
    memo_evictions: expect('memo_evictions', memo.evictions, finite),
    memo_epochStale: expect('memo_epochStale', memo.epochStale, (v) => v === 0),
    memo_cellCollisions: expect('memo_cellCollisions', memo.cellCollisions, finite),
    solve_solvesPerFrame: expect('solve_solvesPerFrame', perFrame(solve.solves), (v) => finite(v) && v > 0),
    solve_evaluationsPerFrame: expect('solve_evaluationsPerFrame', perFrame(solve.evaluations), (v) => finite(v) && v > 0),
    solve_evalsPerSolve: expect('solve_evalsPerSolve', Math.round((solve.evaluations / solve.solves) * 100) / 100, (v) => finite(v) && v > 0 && v <= 64),
    groundHeightLocal_callsPerFrame: expect('groundHeightLocal_callsPerFrame', perFrame(run.calls), (v) => finite(v) && v > 0),
    groundHeightLocal_msPerFrame: expect('groundHeightLocal_msPerFrame', Math.round((run.ms / FRAMES) * 10000) / 10000, (v) => finite(v) && v > 0),
    usPerMiss: expect('usPerMiss', Math.round((run.ms * 1000 / memo.misses) * 100) / 100, (v) => finite(v) && v > 0),
    memo_warmBitsEqualCold: expect('memo_warmBitsEqualCold', Buffer.from(warm.buffer).equals(Buffer.from(coldA.buffer)), (v) => v === true),
    memo_coldBitsReproducible: expect('memo_coldBitsReproducible', Buffer.from(coldB.buffer).equals(Buffer.from(coldA.buffer)), (v) => v === true),
  }
  console.log('[terrain-memo-node] measurements ' + JSON.stringify(report, null, 2))
  for (const f of failures) console.log(`FAIL: ${f}`)
  if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
  else console.log('RESULT: PASS')
  process.exitCode = failures.length ? 1 : 0
}

main().catch((e) => {
  console.error('[terrain-memo-node] threw: ' + String((e && e.stack) || e))
  console.log('RESULT: FAIL (1 of 1 measurement(s))')
  process.exitCode = 1
})
