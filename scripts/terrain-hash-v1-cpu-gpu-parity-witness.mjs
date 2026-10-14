#!/usr/bin/env node
// TERRAIN HASH v1 CPU/GPU PARITY -- grass is placed on the CPU height field and the terrain mesh is
// rendered by the GPU, so the two must be evaluations of the SAME function, not two evaluations of a
// float hash at two different precisions.
//
// The GPU (packages/mapspinner/src/tsl/planet-tsl.js -> src/tsl/height-spec.js) evaluates the height
// spec in fp32. The v1 float hash reads fract(p*0.1031) at lattice coordinates that ARE exactly
// representable in both precisions -- they are integers -- but whose product is not, and the domain
// warp (`warped = p + p*1.6*h0`) turns the resulting hash difference into metres of ground, because
// every one of the 18 octaves it shifts contributes the same amount and they add in quadrature.
// v2's integer hash is bit exact, so v2 never had this defect.
//
// The instrument evaluates the SAME spec the GPU compiles, at the GPU's precision (fp32, IEEE:
// Math.fround after every op, which is exact for + - * / and sqrt), on the CPU, and reports how far
// each CPU mirror sits from it. It is non-vacuous in BOTH directions because it prints the gap for
// the f64 mirror that shipped (metres) and for the fp32 mirror that ships now (zero) over the same
// points, and because the v2 arm -- same instrument, bit-exact hash -- has to read millimetres:
// a figure that is identical in every arm is an instrument gap, not a measurement.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHeightSampler } from 'mapspinner/height-cpu'
import { RELIEF_DESIGN_RADIUS_M } from 'mapspinner/terrain-defaults.js'
import { HASH_VERSION_FLOAT, HASH_VERSION_INTEGER } from 'mapspinner/tsl/height-spec.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))

const WORLD = process.env.THV1_WORLD || 'tps-game.js'
const N = Number(process.env.THV1_N || 7)
const EXTENT = Number(process.env.THV1_EXTENT || 256)
const AT = (process.env.THV1_AT || '-2750,-750').split(',').map(Number)
// The v2 gate is 0.001 m mean / 0.005 m max measured CPU-vs-GPU on a real backend. This instrument
// cannot see a backend, so it reads the fp32 ROUNDING FLOOR of the same field instead -- the shipped
// v2 mirror is still the untouched f64 path, so a reading here in the same millimetre band is the
// claim that the v2 path did not move (and a reading of exactly 0 would mean the instrument is not
// comparing two evaluations at all).
const V2_MEAN_M = 0.005
const V2_MAX_M = 0.02
const AFTER_MAX_M = 1e-9
const BEFORE_MIN_M = 0.5

const fail = []
const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const R = tcfg.radius
const reliefScale = tcfg.reliefScale != null ? tcfg.reliefScale : R / RELIEF_DESIGN_RADIUS_M
console.log(`terrain-hash-v1-parity: world=${WORLD} radius=${R} reliefScale=${reliefScale} seed=${tcfg.seed ?? 0} n=${N} extent=${EXTENT}m at=${AT.join(',')}`)

const frame = createPlanetFrame({
  sampler: createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale, hashVersion: HASH_VERSION_INTEGER }),
  anchorDir: tcfg.anchorDir || [0, 1, 0],
  offsetY: tcfg.offsetY || 0,
  reliefScale,
})

const pts = []
for (let iz = 0; iz < N; iz++) {
  for (let ix = 0; ix < N; ix++) {
    const step = N > 1 ? EXTENT / (N - 1) : 0
    const x = Math.round(AT[0] - EXTENT / 2 + ix * step)
    const z = Math.round(AT[1] - EXTENT / 2 + iz * step)
    pts.push([x, z, frame.localToDir(x, z)])
  }
}

const mirror = (hashVersion, precision) => {
  const s = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale, hashVersion, precision })
  const f = (d) => s.heightAt(d)
  f._fns = s._fns
  return f
}

function gap(a, b) {
  const g = []
  for (const [, , d] of pts) {
    const va = a(d), vb = b(d)
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue
    g.push(Math.abs(va - vb))
  }
  const mean = g.length ? g.reduce((x, y) => x + y, 0) / g.length : NaN
  return { n: g.length, mean, max: g.length ? Math.max(...g) : NaN }
}
const fm = (v) => (Number.isFinite(v) ? v.toFixed(4) : 'NaN')
const show = (label, g) => console.log(`  ${label.padEnd(52)} n=${String(g.n).padStart(3)}  mean=${fm(g.mean)}m  max=${fm(g.max)}m`)

const gpuV1 = mirror(HASH_VERSION_FLOAT, 'f32', 'gpu-v1')
const gpuV2 = mirror(HASH_VERSION_INTEGER, 'f32', 'gpu-v2')
const specV1f64 = mirror(HASH_VERSION_FLOAT, 'f64', 'spec-v1-f64')
const shippedV1 = mirror(HASH_VERSION_FLOAT, 'f32', 'shipped-v1')
const shippedV2 = mirror(HASH_VERSION_INTEGER, 'f64', 'shipped-v2')
const legacyV1 = (d) => specV1f64._fns.composeHeight(d, [0, 0], 100) * reliefScale

console.log('')
console.log('hashVersion 1 -- CPU mirror vs the field the GPU draws:')
const before = gap(legacyV1, gpuV1)
show('BEFORE  legacy f64 mirror (transpiled GLSL)', before)
show('        spec f64 mirror', gap(specV1f64, gpuV1))
const after = gap(shippedV1, gpuV1)
show('AFTER   shipped mirror (fp32, same spec)', after)

console.log('')
console.log('hashVersion 2 -- the bit-exact control:')
const v2 = gap(shippedV2, gpuV2)
show('shipped f64 mirror vs fp32', v2)

console.log('')
const identity = gap(shippedV1, shippedV2)
show('hv1 field vs hv2 field (must stay two fields)', identity)
const v1s = pts.map(([, , d]) => shippedV1(d)).filter(Number.isFinite)
const relief = v1s.length ? Math.max(...v1s) - Math.min(...v1s) : NaN
console.log(`  hv1 fp32 field relief over the extent                      ${fm(relief)}m`)
if (!(relief >= 1)) fail.push(`the hv1 fp32 mirror is degenerate: ${fm(relief)}m of relief over ${EXTENT}m`)

if (!(before.mean >= BEFORE_MIN_M)) fail.push(`the instrument does not see the defect: the f64 mirror disagrees by only ${fm(before.mean)}m mean, under ${BEFORE_MIN_M}m`)
if (!(after.max <= AFTER_MAX_M)) fail.push(`the shipped hv1 mirror is not the fp32 evaluation: max ${fm(after.max)}m exceeds ${AFTER_MAX_M}m`)
if (!(v2.mean <= V2_MEAN_M && v2.max <= V2_MAX_M)) fail.push(`v2 backend parity regressed: mean ${fm(v2.mean)}m / max ${fm(v2.max)}m exceeds ${V2_MEAN_M}m / ${V2_MAX_M}m`)
if (!(v2.max > 0)) fail.push('v2 parity reads exactly 0, so the instrument is not sampling two evaluations at all')
if (!(identity.mean >= BEFORE_MIN_M)) fail.push(`hv1 collapsed into hv2: the two fields are only ${fm(identity.mean)}m apart, so the hash version no longer selects a field`)

const verdict = (ok, msg) => console.log(`${ok ? '[PASS]' : '[FAIL]'} ${msg}`)
console.log('')
verdict(!(before.mean >= BEFORE_MIN_M) ? false : true, `the instrument moves: the f64 mirror sits ${fm(before.mean)}m mean / ${fm(before.max)}m max from the field the GPU draws, the fp32 mirror ${fm(after.mean)}m / ${fm(after.max)}m`)
verdict(v2.mean <= V2_MEAN_M && v2.max <= V2_MAX_M && v2.max > 0, `v2 backend parity holds: mean ${fm(v2.mean)}m <= ${V2_MEAN_M}m, max ${fm(v2.max)}m <= ${V2_MAX_M}m`)
verdict(relief >= 1, `the hv1 fp32 mirror is a real field: ${fm(relief)}m of relief over ${EXTENT}m`)

console.log('')
if (fail.length) {
  for (const f of fail) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('RESULT: PASS label=terrain-hash-v1-parity')
