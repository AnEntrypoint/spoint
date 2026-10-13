// PERF-terrain-fragment-fetch-budget-1013-wall-unresolved-1013.
//
// The frame-wall arm of that row needs BOTH halves of the change in ONE page load: the collapsed
// fragment path and the pre-change path, measured interleaved so a drifting box cannot be read as a
// delta. `splatOctaveCollapse` is the reproduction switch that makes that possible -- a TSL uniform
// the fragment guard reads, so one page can be flipped between the two arms without a reload, a
// rebuild or a second tree.
//
// It is a uniform, not a varying or a derived per-pixel value, and that is load-bearing: WGSL takes
// one side of a uniform branch for the whole draw, so the arm that is not selected issues none of its
// fetches. A per-pixel condition would make BOTH arms pay both sets on a pixel that takes the other
// side, and the A/B would compare two identical shaders.
//
// What this witness pins, gpu-free:
//   1. the switch is a uniform node and its shipped value is 1, so the shipped fragment path is the
//      collapsed one and adding the switch changed no pixel;
//   2. the switch reaches the page -- terrain-material-tsl.js puts it in the `uniforms` object
//      planet-tsl.js publishes as `planet.uniforms`, so `window.__terrain.planet.uniforms
//      .splatOctaveCollapse.value` is the flip the browser arm writes;
//   3. the revert arm restores the pre-change budget: 12 triplanar fetches per layer on EVERY
//      footprint, not only the out-of-band ones -- so the arm labelled "before" really is before;
//   4. the two arms still cost the same nine snoise3 per terrain pixel, and the vertex stencil
//      (FD_TAPS) is untouched, so the arm pair differs by fetches and nothing else.
//
// gpu-free: it builds the real node graph and models the sampler in JS. It never touches an adapter.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three/webgpu'
import { float, vec3, texture, uniform, setCurrentStack } from 'three/tsl'
import { surfaceSplat, terrainAlbedoClimate, splatOctaveCollapse } from '../packages/mapspinner/src/tsl/surface-splat-tsl.js'
import { FD_TAPS } from '../packages/mapspinner/src/tsl/terrain-material-tsl.js'
import { TERRAIN_DEFAULTS as TD } from '../packages/mapspinner/src/terrain-defaults.js'
import { PLANET_RADIUS_M } from '../packages/mapspinner/src/planet-radius.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPLAT_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/surface-splat-tsl.js'), 'utf8')
const MATERIAL_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/terrain-material-tsl.js'), 'utf8')
const PLANET_TSL_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/planet-tsl.js'), 'utf8')
const DECODE_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/surface-texture-decode.js'), 'utf8')

const LABEL = 'surface-splat-octave-ab-switch'
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
const PRE_CHANGE_TAPS_PER_LAYER = 12
const COLLAPSED_TAPS_PER_LAYER = 6

// ---- 1. the switch is a uniform, and shipping it changes no pixel ------------------------------
expect('the switch is exported by the fragment surface', typeof splatOctaveCollapse, 'object')
expect('the switch is a TSL uniform node, so the branch is coherent for the whole draw', splatOctaveCollapse && splatOctaveCollapse.isUniformNode === true, true)
expect('the switch ships at 1, so the shipped fragment path is the collapsed one', splatOctaveCollapse && splatOctaveCollapse.value, 1)
const guardLines = SPLAT_SRC.split('\n').filter((l) => l.includes('splatOctaveCollapse'))
expect('the guard reads the switch exactly twice: its declaration and the band predicate', guardLines.length, 2)
expect('the switch enters the coincide predicate, not a second guard', /octavesCoincide[\s\S]*?splatOctaveCollapse/.test(SPLAT_SRC), true)

// ---- 2. the switch reaches the page ------------------------------------------------------------
// planet-tsl.js publishes `uniforms: u`, and `u` is the object literal terrain-material-tsl.js
// builds, so the browser arm's flip is `window.__terrain.planet.uniforms.splatOctaveCollapse.value`.
expect('terrain-material-tsl.js imports the switch from the fragment surface', /import \{[^}]*splatOctaveCollapse[^}]*\} from '\.\/surface-splat-tsl\.js'/.test(MATERIAL_SRC), true)
const materialLines = MATERIAL_SRC.split(/\r?\n/)
const uStart = materialLines.findIndex((l) => /^\s*const u = /.test(l))
let uEnd = -1
for (let i = uStart + 1; i < materialLines.length; i++) if (materialLines[i] === '  }') { uEnd = i; break; }
const uniformKeys = uEnd > uStart ? materialLines.slice(uStart, uEnd).join('\n') : ''
expect('the switch is a key of the uniforms object the material publishes', /(^|\n)\s*splatOctaveCollapse,\s*$/.test(uniformKeys), true)
expect('material creation returns that object as `uniforms`', /uniforms: u/.test(MATERIAL_SRC), true)
expect('planet-tsl.js republishes it, so the page can reach the node', /uniforms: u/.test(PLANET_TSL_SRC), true)

// ---- 3. the revert arm restores the pre-change budget ------------------------------------------
// The band is read out of the source, not restated, so a change to the predicate moves these counts.
const bandLo = TEX_TILE_M / SURFACE_SIDE
const bandHi = TEX_TILE_M / SCALES[0]
expect('the band predicate is the one the parent row pinned', `${bandLo.toFixed(3)}..${bandHi.toFixed(3)}`, `${(TEX_TILE_M / 1024).toFixed(3)}..${(TEX_TILE_M * 0.25).toFixed(3)}`)

function resolveTap(uv, dudx, dudy, side) {
  const maxLevels = Math.log2(side)
  const rho = Math.max(Math.hypot(dudx[0], dudx[1]), Math.hypot(dudy[0], dudy[1])) * side
  const lambdaRaw = Math.log2(rho)
  const lambda = Math.min(Math.max(lambdaRaw, 0), maxLevels)
  const scale = Math.pow(2, maxLevels - lambda)
  const coord = uv.map((v) => v * scale)
  return { lambda, lambdaRaw, coord, bilinear: coord.map((v) => v - Math.floor(v)), trilinear: lambda - Math.floor(lambda) }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))
const nearFrac = (a, b, eps = 1e-6) => { const d = Math.abs(a - b); return Math.min(d, 1 - d) <= eps }
function pairAgrees(wt, px) {
  const dudx = [px / TEX_TILE_M, 0]
  const dudy = [0, px / TEX_TILE_M]
  const fine = resolveTap(wt.map((v) => v * SCALES[0]), dudx.map((v) => v * SCALES[0]), dudy.map((v) => v * SCALES[0]), SURFACE_SIDE)
  const coarse = resolveTap(wt.map((v) => v * SCALES[1]), dudx.map((v) => v * SCALES[1]), dudy.map((v) => v * SCALES[1]), SURFACE_SIDE)
  return near(fine.lambda, coarse.lambda + Math.log2(SCALES[0] / SCALES[1]), 1e-9)
    && fine.coord.every((v, i) => near(v, coarse.coord[i], 1e-9))
    && fine.bilinear.every((v, i) => nearFrac(v, coarse.bilinear[i]))
    && nearFrac(fine.trilinear, coarse.trilinear)
}

const WT_SAMPLES = [[13.7, 41.2, 7.9], [120.25, 3.5, 88.125], [0.5, 0.5, 0.5], [4096.125, 7.75, 255.5]]
const STEPS = 600
const footprints = Array.from({ length: STEPS }, (_, i) => 1e-3 * Math.pow((TEX_TILE_M * 4) / 1e-3, i / (STEPS - 1)))
const EDGE = 1e-9
let revertTaps = 0, collapseTaps = 0, inBand = 0, outBand = 0
let collapseSavedWhereModelDisagrees = 0, bothKeptWhereModelAgrees = 0
for (const px of footprints) {
  const inside = px >= bandLo && px <= bandHi
  const strictlyInside = px > bandLo * (1 + EDGE) && px < bandHi * (1 - EDGE)
  const strictlyOutside = px < bandLo * (1 - EDGE) || px > bandHi * (1 + EDGE)
  if (strictlyInside) inBand++
  if (strictlyOutside) outBand++
  const perLayer = inside ? COLLAPSED_TAPS_PER_LAYER : PRE_CHANGE_TAPS_PER_LAYER
  collapseTaps += perLayer * WT_SAMPLES.length
  revertTaps += PRE_CHANGE_TAPS_PER_LAYER * WT_SAMPLES.length
  for (const wt of WT_SAMPLES) {
    const agrees = pairAgrees(wt, px)
    if (strictlyInside && !agrees) collapseSavedWhereModelDisagrees++
    if (strictlyOutside && agrees) bothKeptWhereModelAgrees++
  }
}

console.log(`[${LABEL}] band ${bandLo.toFixed(3)}-${bandHi.toFixed(3)} m/px over ${footprints.length} footprint(s) x ${WT_SAMPLES.length} sample(s): ${inBand} strictly in band, ${outBand} strictly out`)
console.log(`[${LABEL}] triplanar fetches per layer: collapse arm ${(collapseTaps / (footprints.length * WT_SAMPLES.length)).toFixed(2)} mean, revert arm ${(revertTaps / (footprints.length * WT_SAMPLES.length)).toFixed(2)} mean`)

expect('the revert arm pays the pre-change budget on every footprint', revertTaps / (footprints.length * WT_SAMPLES.length), PRE_CHANGE_TAPS_PER_LAYER)
expectOp('the collapse arm pays less than the revert arm', collapseTaps, '<', revertTaps)
expectOp('the sweep covers footprints inside the band', inBand, '>', 0)
expectOp('the sweep covers footprints outside it', outBand, '>', 0)
expect('no pixel is collapsed where the sampler model says the pair differs', collapseSavedWhereModelDisagrees, 0)
expect('no pixel keeps both where the sampler model says they resolve one texel', bothKeptWhereModelAgrees, 0)

// ---- 4. the pair differs by fetches and nothing else -------------------------------------------
function placeholder(name) {
  const t = new THREE.DataArrayTexture(new Uint8Array(SURFACE_SIDE * SURFACE_SIDE * 4).fill(128), SURFACE_SIDE, SURFACE_SIDE, 4)
  t.name = name
  t.format = THREE.RGBAFormat
  t.type = THREE.UnsignedByteType
  t.needsUpdate = true
  return t
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
class EagerStack extends THREE.StackNode {
  If(cond, fn) { const r = super.If(cond, fn); if (typeof fn === 'function') fn(); return r }
}
const noisePerArm = {}
for (const arm of [1, 0]) {
  splatOctaveCollapse.value = arm
  let snoiseCalls = 0
  const snoise3 = () => { snoiseCalls++; return float(0.37) }
  const climateStack = new EagerStack()
  setCurrentStack(climateStack)
  snoiseCalls = 0
  terrainAlbedoClimate({ snoise3, h: float(42), rockSlope: float(0.2), temp: float(0.5), nwp: vec3(0, 1, 0), pxWorld: float(0.05), reliefScale: u.reliefScale, bcRock: u.bcRock })
  const climateNoise = snoiseCalls
  const splatStack = new EagerStack()
  setCurrentStack(splatStack)
  snoiseCalls = 0
  surfaceSplat({
    snoise3, u, n: vec3(0, 1, 0), dir0: vec3(0, 1, 0), h: float(42), slope: float(0.2),
    rockSlope: float(0.2), humid: float(0.5), temp: float(0.5), biomeC: vec3(0.3, 0.4, 0.2),
    pxWorld: float(0.05), camDist: float(30), worldRel: vec3(10, 42, 10), texWarp: vec3(0.1, 0.1, 0.1),
  })
  noisePerArm[arm] = climateNoise + snoiseCalls
}
splatOctaveCollapse.value = 1
console.log(`[${LABEL}] snoise3 per terrain pixel: collapse arm ${noisePerArm[1]}, revert arm ${noisePerArm[0]}`)
expect('the collapse arm still costs nine snoise3', noisePerArm[1], 9)
expect('the revert arm costs the same nine snoise3, so the pair differs by fetches alone', noisePerArm[0], 9)
expect('the vertex stencil the row must not touch is still three taps', FD_TAPS, 3)
expect('the switch does not appear in planet-tsl.js, so the vertex path is untouched', PLANET_TSL_SRC.includes('splatOctaveCollapse'), false)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: got ${JSON.stringify(c.got)} want ${c.op || ''}${JSON.stringify(c.want)}`)
if (failed.length > 0) {
  console.log(`RESULT: FAIL ${failed.length} of ${checks.length} check(s) failed label=${LABEL}`)
  process.exit(1)
}
console.log(`MEASURED ${LABEL}: revert arm ${PRE_CHANGE_TAPS_PER_LAYER} triplanar fetch(es) per layer on all ${footprints.length * WT_SAMPLES.length} sample(s), collapse arm ${COLLAPSED_TAPS_PER_LAYER} on the ${inBand * WT_SAMPLES.length} in-band one(s), ${checks.length} check(s) passed`)
console.log(`RESULT: PASS ${checks.length} check(s) label=${LABEL}`)
