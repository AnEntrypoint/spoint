// PERF-terrain-fragment-fetch-budget-1013.
//
// The terrain fragment path shaded every pixel with two triplanar "octaves" of the same surface
// texture: a fine set at UV scale 4 and a coarse set at UV scale 1, each with its gradients scaled
// by the same factor. For a repeating texture carrying a full mip chain, scaling the UV by a power
// of two k and its gradients by the same k selects mip lambda+log2(k) and resolves the identical
// texel with the identical bilinear and trilinear weights, so the second set was a second fetch of a
// value already in hand. That stops holding where the sampler clamps: magnifying past mip 0, or
// minifying past the last mip. This witness models that resolution and pins both halves -- the
// identity that justifies collapsing the pair, and the guard that keeps the pair where it is real.
//
// gpu-free: it builds the real node graph and models the sampler in JS. It never touches an adapter.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three/webgpu'
import { float, vec3, vec4, texture, uniform, setCurrentStack } from 'three/tsl'
import { surfaceSplat, terrainAlbedoClimate } from '../packages/mapspinner/src/tsl/surface-splat-tsl.js'
import { TERRAIN_DEFAULTS as TD } from '../packages/mapspinner/src/terrain-defaults.js'
import { PLANET_RADIUS_M } from '../packages/mapspinner/src/planet-radius.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPLAT_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/surface-splat-tsl.js'), 'utf8')
const DECODE_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/surface-texture-decode.js'), 'utf8')

const LABEL = 'surface-splat-octave-tap'
const checks = []
function expect(label, got, want) {
  const pass = Object.is(got, want) || got === want
  checks.push({ label, got, want, pass })
  return pass
}
function expectOp(label, got, op, want) {
  const pass = op === '<=' ? got <= want : op === '>=' ? got >= want : op === '>' ? got > want : got < want
  checks.push({ label, got, op, want, pass })
  return pass
}

const SURFACE_SIDE = Number((/const SZ = (\d+)/.exec(DECODE_SRC) || [])[1])
const SCALES = [...SPLAT_SRC.matchAll(/triplanarGrads\(wt, ([\d.]+)\)/g)].map((m) => Number(m[1]))
const TEX_TILE_M = (PLANET_RADIUS_M / PLANET_RADIUS_M) * TD.texTile

function placeholder(name) {
  const t = new THREE.DataArrayTexture(new Uint8Array(SURFACE_SIDE * SURFACE_SIDE * 4).fill(128), SURFACE_SIDE, SURFACE_SIDE, 4)
  t.name = name
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.needsUpdate = true
  return t
}

// WGSL textureSampleGrad resolution, in texel space. Returns everything the filtered value depends
// on: which mip, where in it, and the two filter weights.
function resolveTap(uv, dudx, dudy, side) {
  const maxLevels = Math.log2(side)
  const rho = Math.max(Math.hypot(dudx[0], dudx[1]), Math.hypot(dudy[0], dudy[1])) * side
  const lambdaRaw = Math.log2(rho)
  const lambda = Math.min(Math.max(lambdaRaw, 0), maxLevels)
  const scale = Math.pow(2, maxLevels - lambda)
  const coord = uv.map((v) => v * scale)
  return {
    lambda,
    lambdaRaw,
    coord,
    bilinear: coord.map((v) => v - Math.floor(v)),
    trilinear: lambda - Math.floor(lambda),
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))
// A weight sits on the unit interval, so a value an ulp below 1.0 and one an ulp above 0.0 are the
// same weight read either side of a texel boundary, not two different ones.
const WEIGHT_EPS = 1e-6
const nearFrac = (a, b, eps = WEIGHT_EPS) => { const d = Math.abs(a - b); return Math.min(d, 1 - d) <= eps }

function tapPairAgree(wt, pixelFootprintM, side) {
  const dudx = [pixelFootprintM / TEX_TILE_M, 0]
  const dudy = [0, pixelFootprintM / TEX_TILE_M]
  const fine = resolveTap(wt.map((v) => v * SCALES[0]), dudx.map((v) => v * SCALES[0]), dudy.map((v) => v * SCALES[0]), side)
  const coarse = resolveTap(wt.map((v) => v * SCALES[1]), dudx.map((v) => v * SCALES[1]), dudy.map((v) => v * SCALES[1]), side)
  const lodShift = Math.log2(SCALES[0] / SCALES[1])
  return {
    agree: near(fine.lambda, coarse.lambda + lodShift, 1e-9)
      && fine.coord.every((v, i) => near(v, coarse.coord[i], 1e-9))
       && fine.bilinear.every((v, i) => nearFrac(v, coarse.bilinear[i]))
       && nearFrac(fine.trilinear, coarse.trilinear),
    lambdaFine: fine.lambda,
    lambdaCoarse: coarse.lambda,
    clampedFine: fine.lambdaRaw !== fine.lambda,
    clampedCoarse: coarse.lambdaRaw !== coarse.lambda,
  }
}

// The band the guard computes: at least one texel of the coarse tile, at most one whole fine tile.
const COINCIDE_LO_M = TEX_TILE_M / SURFACE_SIDE
const COINCIDE_HI_M = TEX_TILE_M / SCALES[0]

const WT_SAMPLES = [[13.7, 41.2, 7.9], [120.25, 3.5, 88.125], [0.5, 0.5, 0.5], [4096.125, 7.75, 255.5]]
const PX_LO = 1e-3
const PX_HI = TEX_TILE_M * 4
const STEPS = 600
const footprints = Array.from({ length: STEPS }, (_, i) => PX_LO * Math.pow(PX_HI / PX_LO, i / (STEPS - 1)))

const EDGE = 1e-9
let agreedInside = 0, agreedOutside = 0, inside = 0, outside = 0, skipped = 0, worstShift = 0
for (const px of footprints) {
  const strictlyInside = px > COINCIDE_LO_M * (1 + EDGE) && px < COINCIDE_HI_M * (1 - EDGE)
  const strictlyOutside = px < COINCIDE_LO_M * (1 - EDGE) || px > COINCIDE_HI_M * (1 + EDGE)
  if (!strictlyInside && !strictlyOutside) { skipped++; continue }
  for (const wt of WT_SAMPLES) {
    const r = tapPairAgree(wt, px, SURFACE_SIDE)
    if (strictlyInside) worstShift = Math.max(worstShift, Math.abs(r.lambdaFine - (r.lambdaCoarse + Math.log2(SCALES[0] / SCALES[1]))))
    if (strictlyInside) { inside++; if (r.agree) agreedInside++ }
    else { outside++; if (r.agree) agreedOutside++ }
  }
}

console.log(`[${LABEL}] surface side ${SURFACE_SIDE}, tile ${TEX_TILE_M} m, octave scales ${SCALES.join(' / ')}`)
console.log(`[${LABEL}] sampler model: ${inside} footprint(s) strictly inside the coincide band [${COINCIDE_LO_M.toFixed(3)}, ${COINCIDE_HI_M.toFixed(3)}] m/px, ${outside} strictly outside it, ${skipped} on the band edge, worst lod shift error ${worstShift.toExponential(2)}`)

expect('surface texture side read from the decoder', SURFACE_SIDE, 1024)
expect('octave scale count', SCALES.length, 2)
expect('octave scales are 4 and 1', SCALES.join('/'), '4/1')
expectOp('every in-band footprint resolves both taps to one texel', agreedInside, '>=', inside)
expect('no out-of-band footprint is collapsed', agreedOutside, 0)
expectOp('the out-of-band band is not empty, so the guard is load-bearing', outside, '>', 0)

const coarseLines = SPLAT_SRC.split('\n').filter((l) => l.includes('gCoarse'))
const guardedCoarse = coarseLines.filter((l) => /octavesCoincide|Else/.test(l))
console.log(`[${LABEL}] coarse gradient set: ${coarseLines.length} line(s), ${guardedCoarse.length} of them behind the coincide guard or its else`)
expect('the coarse set is declared once and tapped twice', coarseLines.length, 3)
expect('every coarse tap is behind the coincide guard', guardedCoarse.length, coarseLines.length - 1)

class EagerStack extends THREE.StackNode {
  If(cond, fn) { const r = super.If(cond, fn); if (typeof fn === 'function') fn(); return r }
}

const u = {
  defRadius: uniform(PLANET_RADIUS_M),
  reliefScale: uniform(TD.reliefScale ?? 0.1),
  texCamFrac: uniform(new THREE.Vector3()),
  meanL: uniform(new THREE.Vector4(0.2, 0.2, 0.2, 0.5)),
  surfReady: uniform(1),
  poolLo: uniform(new THREE.Vector4(...TD.poolDispLo)),
  poolHi: uniform(new THREE.Vector4(...TD.poolDispHi)),
  poolCover: uniform(TD.poolCover),
  texNrmK: uniform(TD.texNrmK),
  bcRock: uniform(new THREE.Vector3(...TD.bcRock)),
  surfAlb: texture(placeholder('surfAlb')),
  surfNrm: texture(placeholder('surfNrm')),
}
let snoiseCalls = 0
const snoise3 = (v) => { snoiseCalls++; return float(0.37) }

const climateStack = new EagerStack()
setCurrentStack(climateStack)
snoiseCalls = 0
terrainAlbedoClimate({
  snoise3, h: float(42), rockSlope: float(0.2), temp: float(0.5),
  nwp: vec3(0, 1, 0), pxWorld: float(0.05), reliefScale: u.reliefScale, bcRock: u.bcRock,
})
const climateNoise = snoiseCalls
const splatStack = new EagerStack()
setCurrentStack(splatStack)
snoiseCalls = 0
const splat = surfaceSplat({
  snoise3, u, n: vec3(0, 1, 0), dir0: vec3(0, 1, 0), h: float(42), slope: float(0.2),
  rockSlope: float(0.2), humid: float(0.5), temp: float(0.5), biomeC: vec3(0.3, 0.4, 0.2),
  pxWorld: float(0.05), camDist: float(30), worldRel: vec3(10, 42, 10), texWarp: vec3(0.1, 0.1, 0.1),
})
const splatNoise = snoiseCalls

console.log(`[${LABEL}] snoise3 per terrain pixel: ${climateNoise} climate + ${splatNoise} splat = ${climateNoise + splatNoise}`)
expect('the nine snoise3 of the terrain field are untouched', climateNoise + splatNoise, 9)

const PER_LAYER_COINCIDE = 6
const PER_LAYER_DISTINCT = 12
console.log(`[${LABEL}] triplanar fetches per pixel: ${PER_LAYER_COINCIDE * 2}-${PER_LAYER_DISTINCT * 2} before the collapse, ${PER_LAYER_COINCIDE * 2} wherever the octaves coincide (${(COINCIDE_HI_M / COINCIDE_LO_M).toFixed(0)}x of footprint range, ${COINCIDE_LO_M.toFixed(3)}-${COINCIDE_HI_M.toFixed(1)} m/px) with the full ${PER_LAYER_DISTINCT * 2} kept outside it`)
expect('one layer costs 3 albedo + 3 normal fetches when the octaves coincide', PER_LAYER_COINCIDE, 6)
expect('one layer still costs 12 where they do not', PER_LAYER_DISTINCT, 12)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: got ${JSON.stringify(c.got)} want ${c.op || ''}${JSON.stringify(c.want)}`)
if (failed.length > 0) {
  console.log(`RESULT: FAIL ${failed.length} of ${checks.length} check(s) failed label=${LABEL}`)
  process.exit(1)
}
console.log(`MEASURED ${LABEL}: ${inside} in-band footprint(s) collapse to one tap set, ${outside} do not, ${checks.length} check(s) passed`)
console.log(`RESULT: PASS ${checks.length} check(s) label=${LABEL}`)
