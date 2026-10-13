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
// cannot tell you is whether that much movement is VISIBLE -- that needs a real frame -- so it
// prints the distance and the wind it holds at, and nothing else claims to be covered here.
//
// The distance is a fraction of the card's own height, not a number of metres. makeClumpGeo builds
// the card one unit tall (v runs 0..1, GrassTSL clamps transformed.y to it), so every displacement
// the shader adds is in card heights; the instance scale that turns a card height into metres is
// Grass.js's business, not this witness's, and calling the raw number "mm" over-reads it. The
// budget is therefore a fraction of the card -- the one length the row count actually controls --
// so it holds for any uGrassWind, gAmp or uGrassBendStrength the grass lanes ship.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// The wind term itself now lives in client/core/GrassWindField.js, which evaluates it once per cell
// of a lattice instead of once per vertex. Its coefficients are that module's, so they are read
// there rather than parsed out of a shader expression that no longer exists.
import {
  GRASS_SWAY_BASE, GRASS_SWAY_FLOW, GRASS_FLUTTER_X, GRASS_FLUTTER_Z, GRASS_WAVE2_GAIN,
} from '../client/core/GrassWindField.js'

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
// The wiring contract for the wind: the joined gust still enters the position as a vector TIMES gw
// on both axes, so every displacement in the shader is still proportional to the card-height
// envelope this witness is about.
const swayM = must(tsl, /transformed\.x\.addAssign\(gGust\.x\.mul\(gw\)\)\s*\n\s*transformed\.z\.addAssign\(gGust\.y\.mul\(gw\)\)/, 'the gust is still applied through gw on both axes')
const windM = must(mat, /uGrassWind: \{ value: ([0-9.]+) \}/, 'the shipped default wind is readable')
// The bender field displaces by gw too, and is NOT scaled by wind: bendXZ.mul(gw) on x and z.
const bendM = must(mat, /uGrassBendStrength: \{ value: ([0-9.]+) \}/, 'the bender strength is readable')

if (failed.length) {
  console.log(`RESULT: FAIL (${failed.length} unreadable input(s))`)
  process.exit(1)
}

const GW_K = Number(gwM[1])
const AMP_BASE = GRASS_SWAY_BASE
const AMP_FLOW = GRASS_SWAY_FLOW
const WOBBLE = GRASS_FLUTTER_X
const WOBBLE_Z = GRASS_FLUTTER_Z
// gFlow is two sines, the second scaled by GRASS_WAVE2_GAIN; its envelope is 1 + that coefficient.
const FLOW_ENV = 1 + GRASS_WAVE2_GAIN
const DEFAULT_WIND = Number(windM[1])
const BEND_STRENGTH = Number(bendM[1])
void swayM

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
let dropDelta = 0
for (let i = 0; i < SAMPLES; i++) {
  const v = i / (SAMPLES - 1)
  const d = Math.abs(gwWithRows(NEAR_ROWS - 1, v) - gwWithRows(NEAR_ROWS, v))
  if (d > dropDelta) dropDelta = d
}
const before = maxErr(3)
const after = maxErr(NEAR_ROWS)

// Displacement per unit of gw, per unit of wind, in CARD HEIGHTS: the flow term is a unit direction
// times (AMP_BASE + AMP_FLOW*gFlow); the wobble is a unit-ish vector (sin, cos) of length <= sqrt2.
const perGwPerWind = (Math.abs(AMP_BASE) + AMP_FLOW * FLOW_ENV) + WOBBLE * Math.SQRT2
// makeClumpGeo puts v at 0..1 down the card, so the card is exactly one unit tall in shader space.
const CARD_HEIGHT = 1
const ofCard = (deltaGw, wind) => deltaGw * perGwPerWind * wind / CARD_HEIGHT

console.log('[grass-bend] gw error against the true quadratic: 3 rows '
  + `${before.err.toFixed(6)} (worst at v=${before.at.toFixed(3)}), ${NEAR_ROWS} rows `
  + `${after.err.toFixed(6)} (worst at v=${after.at.toFixed(3)})`)
console.log(`[grass-bend] largest gw difference between 3 rows and ${NEAR_ROWS} rows: `
  + `${maxDelta.toFixed(6)} (worst at v=${deltaAt.toFixed(3)})`)
console.log(`[grass-bend] displacement per unit gw per unit wind: ${perGwPerWind.toFixed(6)} card `
  + `(flow ${(Math.abs(AMP_BASE) + AMP_FLOW * FLOW_ENV).toFixed(6)} + wobble ${(WOBBLE * Math.SQRT2).toFixed(6)})`)

const shipFrac = ofCard(maxDelta, DEFAULT_WIND)
const stressFrac = ofCard(maxDelta, DEFAULT_WIND * 4)
const bendFrac = maxDelta * BEND_STRENGTH / CARD_HEIGHT
// The row-count cost as a fraction of the card's own full deflection: cost and deflection both
// scale with uGrassWind and with the gAmp amplitudes, so this ratio depends on the row count
// alone. It is the one bound here that no grass lane can break by moving a wind knob.
const GW_MAX = GW_K
const ofDeflection = (deltaGw) => deltaGw / GW_MAX
const pct = (f) => `${(f * 100).toFixed(2)}%`
console.log(`[grass-bend] the shipped card moves at most ${pct(shipFrac)} of the card height at the default wind ${DEFAULT_WIND}`)
console.log(`[grass-bend] the shipped card moves at most ${pct(stressFrac)} of the card height at four times that wind`)
console.log(`[grass-bend] plus ${pct(bendFrac)} per fully-engaged bender (bendXZ.mul(gw) is not scaled by wind, and benders can overlap), so ${pct(shipFrac + bendFrac)} with one`)

// A real change, small against the card it moves. These are bounds: worst case over v, over the flow
// envelope and over the wobble phase simultaneously, so a given blade at a given instant moves less.
check('the row count really does change the geometry', maxDelta > 0, `maxDeltaGw=${maxDelta.toFixed(6)}`)
check('the change is under 8% of the card height at the wind that ships', shipFrac < 0.08, `${pct(shipFrac)} at wind ${DEFAULT_WIND}`)
check('the change is under 12% with a bender standing in the grass', shipFrac + bendFrac < 0.12, `${pct(shipFrac + bendFrac)} at wind ${DEFAULT_WIND}`)
check('the change stays under 20% at four times the wind', stressFrac < 0.20, `${pct(stressFrac)} at wind ${(DEFAULT_WIND * 4).toFixed(4)}`)
// Non-vacuous, and the only check here that holds at any wind: one segment fewer must blow the
// row-count budget, which is the claim Grass.js makes above makeClumpGeo -- two segments is the
// fewest that still carries the curve. At wind 0.25 every card-height figure is under 8%, so the
// card-height gate alone cannot tell 2 segments from 1; this ratio can.
check('the row-count cost is under 8% of the card\'s own deflection', ofDeflection(maxDelta) < 0.08, `${pct(ofDeflection(maxDelta))} of ${GW_MAX} gw`)
check('one segment fewer would break that budget', ofDeflection(dropDelta) > 0.08, `${pct(ofDeflection(dropDelta))} for the ${NEAR_ROWS - 1}-segment card`)

console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${failed.length} failure(s)) rowsBefore=3 rowsAfter=${NEAR_ROWS} maxDeltaGw=${maxDelta.toFixed(6)} pctAtDefaultWind=${(shipFrac * 100).toFixed(2)} pctAtWind4x=${(stressFrac * 100).toFixed(2)}`)
process.exit(failed.length === 0 ? 0 : 1)
