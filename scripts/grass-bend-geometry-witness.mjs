#!/usr/bin/env node
// How big is the near-LOD row-count change, in metres?
//
// client/core/Grass.js builds the grass card with makeClumpGeo(segments, cards): segments+1 rows
// of vertices down the card. Every wind displacement in client/core/GrassTSL.js's displacedPosition
// is proportional to gw = 0.45 * v^2, where v is the card's own height coordinate, and gw is
// evaluated PER VERTEX and then interpolated across the triangle. So the row count decides how well
// a piecewise-linear displacement approximates that quadratic, and dropping 3 rows to 2 moves every
// point of the card by a distance this witness can compute exactly from the shipped constants.
//
// This is gpu-free and node-side: it measures the shader's own arithmetic, not pixels. What it
// cannot tell you is whether that many millimetres is VISIBLE -- that needs a real frame -- so it
// prints the distance and the wind it holds at, and nothing else claims to be covered here.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const failed = []
const check = (name, ok, detail) => {
  if (!ok) failed.push(name)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}
const must = (src, re, label) => {
  const m = re.exec(src)
  if (!m) { failed.push(label); console.log(`  [FAIL] ${label} (the expression moved: /${re.source}/ no longer matches -- re-read client/core/GrassTSL.js before trusting any number here)`); return null }
  return m
}

const tsl = read('client/core/GrassTSL.js')
const mat = read('client/core/GrassMaterial.js')
const grass = read('client/core/Grass.js')

// The two call sites decide how many rows each LOD carries.
const nearCall = must(grass, /const geoNear = makeClumpGeo\(\s*(\d+)\s*,\s*(\d+)\s*\)/, 'geoNear call site is readable')
const midCall = must(grass, /const geoMid = makeClumpGeo\(\s*(\d+)\s*,\s*(\d+)\s*\)/, 'geoMid call site is readable')
const NEAR_ROWS = nearCall ? Number(nearCall[1]) : NaN
const MID_ROWS = midCall ? Number(midCall[1]) : NaN

// The bend itself: gw = gv*gv*0.45, and both displacement terms are proportional to it.
const gwM = must(tsl, /const gw = gv\.mul\(gv\)\.mul\(([0-9.]+)\)/, 'gw is quadratic in the card height coordinate')
const ampM = must(tsl, /const gAmp = float\(([0-9.]+)\)\.add\(gFlow\.mul\(([0-9.]+)\)\)\.mul\(gw\)\.mul\(uGrassWind\)/, 'the flow-driven bend term is proportional to gw')
const wobX = must(tsl, /sin\(gph\)\.mul\(gw\)\.mul\(([0-9.]+)\)\.mul\(uGrassWind\)/, 'the per-instance wobble term (x) is proportional to gw')
const wobZ = must(tsl, /cos\(gph\.mul\([0-9.]+\)\)\.mul\(gw\)\.mul\(([0-9.]+)\)\.mul\(uGrassWind\)/, 'the per-instance wobble term (z) is proportional to gw')
// gFlow is two sines, the second scaled by a coefficient; its envelope is 1 + that coefficient.
// The coefficient is the LAST .mul() of the statement -- a lazy match grabs gGust.mul(5.5) instead.
const flowStmt = /const gFlow = ([\s\S]*?)\n\s*const gAmp/.exec(tsl)
// The coefficient is the trailing `.mul(<n>))` that closes the statement -- any earlier .mul() in
// it is a noise scale or a time factor (gGust.mul(5.5), uGrassTime.mul(1.4)), not this envelope.
const envCoef = flowStmt ? Number((/\.mul\(([0-9.]+)\)\)\s*$/.exec(flowStmt[1].trimEnd()) || [])[1]) : NaN
const windM = must(mat, /uGrassWind: \{ value: ([0-9.]+) \}/, 'the shipped default wind is readable')
// The bender field displaces by gw too, and is NOT scaled by wind: bendXZ.mul(gw) on x and z.
const bendM = must(mat, /uGrassBendStrength: \{ value: ([0-9.]+) \}/, 'the bender strength is readable')

if (failed.length) {
  console.log(`RESULT: FAIL (${failed.length} unreadable input(s))`)
  process.exit(1)
}

const GW_K = Number(gwM[1])
const AMP_BASE = Number(ampM[1])
const AMP_FLOW = Number(ampM[2])
const WOBBLE = Number(wobX[1])
const WOBBLE_Z = Number(wobZ[1])
if (!Number.isFinite(envCoef)) { failed.push('gFlow envelope coefficient'); console.log('  [FAIL] gFlow envelope coefficient (second sine scale not readable -- re-read client/core/GrassTSL.js)') }
const FLOW_ENV = 1 + envCoef // |sin| <= 1, plus a second sine scaled by that coefficient
const DEFAULT_WIND = Number(windM[1])
const BEND_STRENGTH = Number(bendM[1])

check('near LOD is the 2-row card this change landed', NEAR_ROWS === 2, `geoNear=makeClumpGeo(${NEAR_ROWS}, ${nearCall[2]})`)
check('mid LOD is untouched by this change', MID_ROWS === 1, `geoMid=makeClumpGeo(${MID_ROWS}, ${midCall[2]})`)
check('the bend is quadratic in the card height coordinate', GW_K === 0.45, `gw = gv*gv*${GW_K}`)
check('both wobble axes use the same gw coefficient', WOBBLE === WOBBLE_Z, `x=${WOBBLE} z=${WOBBLE_Z}`)

// gw as the shader evaluates it, and as each row count carries it: gw is computed at each vertex
// and linearly interpolated between the rows, so a card with N segments carries the piecewise
// linear interpolant of the quadratic through its N+1 rows.
const gwTrue = (v) => GW_K * v * v
const gwWithRows = (N, v) => {
  const t = v * N
  const s = Math.min(N - 1, Math.floor(t))
  const f = t - s
  const a = gwTrue(s / N), b = gwTrue((s + 1) / N)
  return a + (b - a) * f
}

const SAMPLES = 20001
const maxErr = (N) => {
  let m = 0, at = 0
  for (let i = 0; i < SAMPLES; i++) {
    const v = i / (SAMPLES - 1)
    const e = Math.abs(gwWithRows(N, v) - gwTrue(v))
    if (e > m) { m = e; at = v }
  }
  return { err: m, at }
}
let maxDelta = 0, deltaAt = 0
for (let i = 0; i < SAMPLES; i++) {
  const v = i / (SAMPLES - 1)
  const d = Math.abs(gwWithRows(NEAR_ROWS, v) - gwWithRows(3, v))
  if (d > maxDelta) { maxDelta = d; deltaAt = v }
}
const before = maxErr(3)
const after = maxErr(NEAR_ROWS)

// Metres of displacement per unit of gw, per unit of wind. The flow term is a unit direction
// times (AMP_BASE + AMP_FLOW*gFlow); the wobble is a unit-ish vector (sin, cos) of length <= sqrt2.
const perGwPerWind = (Math.abs(AMP_BASE) + AMP_FLOW * FLOW_ENV) + WOBBLE * Math.SQRT2
const metres = (deltaGw, wind) => deltaGw * perGwPerWind * wind

console.log('[grass-bend] gw error against the true quadratic: 3 rows '
  + `${before.err.toFixed(6)} (worst at v=${before.at.toFixed(3)}), ${NEAR_ROWS} rows `
  + `${after.err.toFixed(6)} (worst at v=${after.at.toFixed(3)})`)
console.log(`[grass-bend] largest gw difference between 3 rows and ${NEAR_ROWS} rows: `
  + `${maxDelta.toFixed(6)} (worst at v=${deltaAt.toFixed(3)})`)
console.log(`[grass-bend] displacement per unit gw per unit wind: ${perGwPerWind.toFixed(6)} m `
  + `(flow ${(Math.abs(AMP_BASE) + AMP_FLOW * FLOW_ENV).toFixed(6)} + wobble ${(WOBBLE * Math.SQRT2).toFixed(6)})`)

const shipM = metres(maxDelta, DEFAULT_WIND)
const stressM = metres(maxDelta, 1)
const bendM2 = maxDelta * BEND_STRENGTH
console.log(`[grass-bend] the shipped card moves at most ${(shipM * 1000).toFixed(2)} mm at the default wind ${DEFAULT_WIND}`)
console.log(`[grass-bend] the shipped card moves at most ${(stressM * 1000).toFixed(2)} mm at wind 1`)
console.log(`[grass-bend] plus ${(bendM2 * 1000).toFixed(2)} mm per fully-engaged bender (bendXZ.mul(gw) is not scaled by wind, and benders can overlap), so ${((shipM + bendM2) * 1000).toFixed(2)} mm with one`)

// A real change, small at the wind that ships. These are bounds: worst case over v, over the flow
// envelope and over the wobble phase simultaneously, so a given blade at a given instant moves less.
check('the row count really does change the geometry', maxDelta > 0, `maxDeltaGw=${maxDelta.toFixed(6)}`)
check('the change is sub-centimetre at the wind that ships', shipM < 0.01, `${(shipM * 1000).toFixed(2)} mm at wind ${DEFAULT_WIND}`)
check('the change is under 2 cm with a bender standing in the grass', shipM + bendM2 < 0.02, `${((shipM + bendM2) * 1000).toFixed(2)} mm at wind ${DEFAULT_WIND}`)
check('the change stays under 3 cm at four times the wind', stressM < 0.03, `${(stressM * 1000).toFixed(2)} mm at wind 1`)

console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${failed.length} failure(s)) rowsBefore=3 rowsAfter=${NEAR_ROWS} maxDeltaGw=${maxDelta.toFixed(6)} mmAtDefaultWind=${(shipM * 1000).toFixed(2)} mmAtWind1=${(stressM * 1000).toFixed(2)}`)
process.exit(failed.length === 0 ? 0 : 1)
