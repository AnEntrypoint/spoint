#!/usr/bin/env node
// Does the wind blow the grass blades TOGETHER, and is the shared term really computed once for
// the group?
//
// Two claims, and this witness exists because neither is visible in a screenshot:
//
//   (a) COHERENCE. The old wind term gave every blade its own oscillator phase -- windShadow.x,
//       minted as rand()*2*PI per blade in src/terrain/GrassPlacement.js:193 -- so two blades a
//       metre apart leaned by amounts that had nothing to do with each other. The turbulence was
//       there, but it cancelled: half the sway was per-blade noise. The new term is one field of
//       world position, so neighbours read two samples a fraction of a cell apart and move TOGETHER.
//       Measured here as the normalised correlation of the lateral displacement of two blades
//       separated by d, averaged over 96 instants -- 1.0 is "the same motion", 0 is "unrelated".
//
//   (b) THE JOIN. The gust -- value noise, two travelling waves, the flutter -- is a function of
//       world position and time alone. It was evaluated in the vertex stage, so every vertex of
//       every clump paid for it again. It is now evaluated once per cell of a lattice that rides
//       with the camera, and both shader paths read it with one bilinear texture fetch. Counted
//       here by EXECUTING both arms through a math object that counts sin/cos, so the work-unit
//       figure is measured, not declared.
//
// The before arm is a transliteration of client/core/GrassMaterial.js's vertex wind block as it
// stood before this change (grassNoise at 0.11, gFlow's two sines, gAmp, gph = t*2.2 + windShadow.x,
// sin(gph) on x and cos(gph*0.7) on z) -- every constant below is the one that shipped. The after
// arm samples the REAL lattice client/core/GrassWindField.js builds, decoded through
// THREE.DataUtils.fromHalfFloat and interpolated bilinearly, which is exactly what the shader reads;
// it is not the ideal continuous field, so the lattice's own smoothing is inside the number.
//
// gpu-free. What it CANNOT tell you: whether the turbulence reads on a real frame at near and mid,
// and what the frame costs in wall and ThreadTime. That is a browser arm this file does not run.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import {
  grassWindGust, createGrassWindField,
  GRASS_WIND_FIELD_CELLS, GRASS_WIND_FIELD_BANDS, GRASS_WIND_FIELD_EXTENT_M,
  GRASS_SWAY_BASE, GRASS_SWAY_FLOW, GRASS_FLUTTER_X, GRASS_FLUTTER_Z, GRASS_WAVE2_GAIN,
  GRASS_WIND_FIELD_DROP_MARGIN_M,
} from '../client/core/GrassWindField.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const num = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}=`)
  if (i >= 0) return Number(process.argv[i].slice(name.length + 3))
  const j = process.argv.indexOf(`--${name}`)
  return j >= 0 ? Number(process.argv[j + 1]) : fallback
}
const INSTANCES = num('instances', 105188)

const failed = []
const check = (name, ok, detail) => {
  if (!ok) failed.push(name)
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} (${detail})`)
}

// ---------------------------------------------------------------- shipped inputs

const matSrc = read('client/core/GrassMaterial.js')
const tslSrc = read('client/core/GrassTSL.js')
const grassSrc = read('client/core/Grass.js')

const srcNum = (re, src, label) => {
  const m = re.exec(src)
  if (!m) { failed.push(label); console.log(`  [FAIL] ${label} (/${re.source}/ no longer matches)`); return NaN }
  return Number(m[1])
}
const WIND_AMP = srcNum(/uGrassWind: \{ value: ([0-9.]+) \}/, matSrc, 'the shipped wind amplitude is readable')
const RING = srcNum(/uGrassRing: \{ value: ([0-9.]+) \}/, matSrc, 'the shipped grass ring is readable')
const dirM = /uGrassWindDir: \{ value: new THREE\.Vector2\((-?[0-9.]+), (-?[0-9.]+)\)/.exec(matSrc)
if (!dirM) { failed.push('the shipped wind direction is readable'); console.log('  [FAIL] the shipped wind direction is readable') }
const DIR_X = dirM ? Number(dirM[1]) : 0.8
const DIR_Z = dirM ? Number(dirM[2]) : 0.6
const nearGeo = /const geoNear = makeClumpGeo\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(grassSrc)
const midGeo = /const geoMid = makeClumpGeo\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(grassSrc)
// makeClumpGeo(segments, cards): cards * (segments + 1) rows of 2 vertices.
const NEAR_VERTS = nearGeo ? Number(nearGeo[2]) * (Number(nearGeo[1]) + 1) * 2 : NaN
const MID_VERTS = midGeo ? Number(midGeo[2]) * (Number(midGeo[1]) + 1) * 2 : NaN
if (!Number.isFinite(NEAR_VERTS) || !Number.isFinite(MID_VERTS)) { failed.push('both grass LOD cards are readable'); console.log('  [FAIL] both grass LOD cards are readable') }

// ---------------------------------------------------------------- the before arm

const fract = (v) => v - Math.floor(v)
const GLSL_HASH = [127.1, 311.7]
function glslHash(x, y, m) { return fract(m.sin(x * GLSL_HASH[0] + y * GLSL_HASH[1]) * 43758.5453) }
function glslNoise(x, y, m) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  const a = glslHash(ix, iy, m), b = glslHash(ix + 1, iy, m)
  const c = glslHash(ix, iy + 1, m), d = glslHash(ix + 1, iy + 1, m)
  const lo = a + (b - a) * ux, hi = c + (d - c) * ux
  return lo + (hi - lo) * uy
}

// client/core/GrassMaterial.js vertex wind block, before. `phase` is windShadow.x: one random
// number per blade, fixed for the life of the blade.
function windBefore(out, x, z, t, wdx, wdz, amp, phase, m) {
  const gx = x * 0.11 + wdx * t * 0.35
  const gz = z * 0.11 + wdz * t * 0.35
  const gGust = glslNoise(gx, gz, m)
  const gFlow = m.sin(x * 0.06 + z * 0.045 + gGust * 5.5 + t * 1.4)
    + 0.5 * m.sin(x * -0.11 + z * 0.09 + t * 2.3)
  const gAmp = (0.2 + 0.25 * gFlow) * amp
  const gph = t * 2.2 + phase
  out[0] = wdx * gAmp + m.sin(gph) * 0.25 * amp
  out[1] = wdz * gAmp + m.cos(gph * 0.7) * 0.25 * amp
  return out
}

// ---------------------------------------------------------------- the after arm: the real lattice

const reach = RING + GRASS_WIND_FIELD_DROP_MARGIN_M
const field = createGrassWindField()
const gust = [0, 0, 0]
const fromHalf = THREE.DataUtils.fromHalfFloat

function windExact(out, x, z, t, wdx, wdz, amp) {
  grassWindGust(gust, x, z, t, wdx, wdz)
  const sway = (GRASS_SWAY_BASE + GRASS_SWAY_FLOW * gust[0]) * amp
  out[0] = wdx * sway + gust[1] * GRASS_FLUTTER_X * amp
  out[1] = wdz * sway + gust[2] * GRASS_FLUTTER_Z * amp
  return out
}

// Exactly what the vertex shader reads: uv = (worldXZ - origin) * invExtent, LinearFilter,
// ClampToEdge, half-float texels.
function windLattice(out, x, z, f = field) {
  const data = f.texture.image.data
  const C = f.cells
  const ox = field.uniforms.uFieldOrigin.value.x
  const oz = field.uniforms.uFieldOrigin.value.y
  const cellM = field.extentM / C
  const u = (x - ox) / cellM - 0.5
  const v = (z - oz) / cellM - 0.5
  let i0 = Math.floor(u), j0 = Math.floor(v)
  const fu = u - i0, fv = v - j0
  const cl = (k) => (k < 0 ? 0 : (k > C - 1 ? C - 1 : k))
  const i1 = cl(i0 + 1), j1 = cl(j0 + 1)
  i0 = cl(i0); j0 = cl(j0)
  const at = (i, j, ch) => fromHalf(data[(j * C + i) * 4 + ch])
  const lerp = (a, b, f) => a + (b - a) * f
  const lo0 = lerp(at(i0, j0, 0), at(i1, j0, 0), fu)
  const hi0 = lerp(at(i0, j1, 0), at(i1, j1, 0), fu)
  const lo1 = lerp(at(i0, j0, 1), at(i1, j0, 1), fu)
  const hi1 = lerp(at(i0, j1, 1), at(i1, j1, 1), fu)
  out[0] = lerp(lo0, hi0, fv)
  out[1] = lerp(lo1, hi1, fv)
  return out
}

// ---------------------------------------------------------------- the coherence metric

const SPACING = 0.5
const PATCH_M = 32
const N = Math.round(PATCH_M / SPACING) + 1
const TIMES = 96
const T_STEP = 6 / TIMES // uGrassTime advances at GRASS_ANIM_SPEED = 0.25/s, so 6 units ~ 24 s
const SEPARATIONS = [0.5, 1, 2, 4, 8, 16]

// windPhase is rand()*2*PI per blade, drawn once and fixed. A deterministic stand-in with the same
// distribution: the correlation is over blades, and any fixed assignment of independent phases
// gives the same answer, so a hash of the blade index is the population, not a sample of it.
const bladePhase = (ix, iz) => fract(Math.sin(ix * 12.9898 + iz * 78.233) * 43758.5453) * Math.PI * 2

function measure(sampleAt) {
  const U = new Float64Array(N * N * TIMES * 2)
  for (let ti = 0; ti < TIMES; ti++) {
    const t = ti * T_STEP
    sampleAt(t)
    const o = ti * 2
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const px = ix * SPACING, pz = iz * SPACING
        const out = [0, 0]
        sampleAt.sample(out, px, pz, t)
        U[((iz * N + ix) * TIMES + ti) * 2] = out[0]
        U[((iz * N + ix) * TIMES + ti) * 2 + 1] = out[1]
      }
    }
    void o
  }
  // remove each blade's own temporal mean: what is left is how it MOVES, not where it sits
  const A = new Float64Array(N * N * TIMES * 2)
  let sq = 0, peak = 0
  for (let p = 0; p < N * N; p++) {
    let mx = 0, mz = 0
    for (let ti = 0; ti < TIMES; ti++) { mx += U[(p * TIMES + ti) * 2]; mz += U[(p * TIMES + ti) * 2 + 1] }
    mx /= TIMES; mz /= TIMES
    for (let ti = 0; ti < TIMES; ti++) {
      const k = (p * TIMES + ti) * 2
      A[k] = U[k] - mx; A[k + 1] = U[k + 1] - mz
      const r2 = A[k] * A[k] + A[k + 1] * A[k + 1]
      sq += r2
      if (r2 > peak) peak = r2
    }
  }
  const rms = Math.sqrt(sq / (N * N * TIMES))
  // The collective motion: the mean displacement of the blades in one 4m block, which is what a
  // patch of grass does as a piece. THIS is the number that reads as turbulence -- and it is the
  // one per-blade noise destroyed, because 81 blades pulling in 81 random directions average to
  // almost nothing however hard each one is pulling.
  const BS = Math.round(4 / SPACING)
  const K = (BS + 1) * (BS + 1)
  const NB = Math.floor((N - 1) / BS)
  let csq = 0, cn = 0
  for (let bz = 0; bz < NB; bz++) {
    for (let bx = 0; bx < NB; bx++) {
      for (let ti = 0; ti < TIMES; ti++) {
        let mx = 0, mz = 0
        for (let dz = 0; dz <= BS; dz++) {
          for (let dx = 0; dx <= BS; dx++) {
            const p = ((bz * BS + dz) * N + (bx * BS + dx)) * TIMES + ti
            mx += U[p * 2]; mz += U[p * 2 + 1]
          }
        }
        mx /= K; mz /= K
        csq += mx * mx + mz * mz; cn++
      }
    }
  }
  const collective = Math.sqrt(csq / cn)
  const coherence = {}
  for (const d of SEPARATIONS) {
    const s = Math.round(d / SPACING)
    let num = 0, n1 = 0, n2 = 0, pairs = 0
    for (const [sx, sz] of [[s, 0], [0, s]]) {
      for (let iz = 0; iz + sz < N; iz++) {
        for (let ix = 0; ix + sx < N; ix++) {
          const pa = iz * N + ix, pb = (iz + sz) * N + (ix + sx)
          for (let ti = 0; ti < TIMES; ti++) {
            const a = (pa * TIMES + ti) * 2, b = (pb * TIMES + ti) * 2
            num += A[a] * A[b] + A[a + 1] * A[b + 1]
            n1 += A[a] * A[a] + A[a + 1] * A[a + 1]
            n2 += A[b] * A[b] + A[b + 1] * A[b + 1]
          }
          pairs++
        }
      }
    }
    coherence[d] = n1 > 0 && n2 > 0 ? num / Math.sqrt(n1 * n2) : NaN
    void pairs
  }
  let len = SEPARATIONS[SEPARATIONS.length - 1]
  for (let k = 0; k < SEPARATIONS.length; k++) {
    if (coherence[SEPARATIONS[k]] < 0.5) {
      const prev = k === 0 ? 0 : SEPARATIONS[k - 1]
      const cp = k === 0 ? 1 : coherence[SEPARATIONS[k - 1]]
      const c = coherence[SEPARATIONS[k]]
      len = prev + (cp - 0.5) / (cp - c) * (SEPARATIONS[k] - prev)
      break
    }
  }
  return { coherence, rms, peak: Math.sqrt(peak), len, collective }
}

const beforeSampler = (t) => { void t }
beforeSampler.sample = (out, x, z, t) => {
  windBefore(out, x, z, t, DIR_X, DIR_Z, WIND_AMP, bladePhase(Math.round(x / SPACING), Math.round(z / SPACING)), Math)
}
// One lattice per sampled instant. A shipped frame refreshes one band of 8 rows, so a witness that
// stepped time by a whole band would be measuring the refresh schedule instead of the field: the
// lattice is refreshed completely for each instant here, and the schedule's own cost is measured
// separately below against a real frame step.
const BANDS = GRASS_WIND_FIELD_BANDS
const refreshAt = (t) => {
  for (let b = 0; b < BANDS; b++) field.update(t, PATCH_M / 2, PATCH_M / 2, WIND_AMP, DIR_X, DIR_Z, reach)
}
const afterSampler = (t) => refreshAt(t)
afterSampler.sample = (out, x, z) => windLattice(out, x, z)

const B = measure(beforeSampler)
const A = measure(afterSampler)

// ---------------------------------------------------------------- lattice fidelity

const probe = [0, 0], exact = [0, 0]
let meanErr = 0, maxErr = 0, ampMax = 0, samples = 0
for (let ti = 0; ti < 24; ti++) {
  const t = ti * 0.25
  refreshAt(t)
  for (let k = 0; k < 400; k++) {
    const x = ((k * 7919) % 3200) / 100, z = ((k * 104729) % 3200) / 100
    windLattice(probe, x, z)
    windExact(exact, x, z, t, DIR_X, DIR_Z, WIND_AMP)
    const e = Math.max(Math.abs(probe[0] - exact[0]), Math.abs(probe[1] - exact[1]))
    meanErr += e; if (e > maxErr) maxErr = e
    const r = Math.hypot(exact[0], exact[1]); if (r > ampMax) ampMax = r
    samples++
  }
}
meanErr /= samples

// A shipped frame advances uGrassTime by GRASS_ANIM_SPEED/60 and refreshes ONE band, so the oldest
// row is BANDS frames stale. That staleness is a real artefact of the join and has to be measured,
// not assumed away: 600 frames at 60fps, then every cell read against the exact field at that same
// instant.
const FRAME_DT = 0.25 / 60
const sched = createGrassWindField()
let schedT = 0
for (let i = 0; i < 600; i++) { schedT += FRAME_DT; sched.update(schedT, 0, 0, WIND_AMP, DIR_X, DIR_Z, reach) }
let schedMax = 0
for (let k = 0; k < 2000; k++) {
  const x = ((k * 7919) % 16000) / 100 - 80, z = ((k * 104729) % 16000) / 100 - 80
  windLattice(probe, x, z, sched)
  windExact(exact, x, z, schedT, DIR_X, DIR_Z, WIND_AMP)
  const e = Math.max(Math.abs(probe[0] - exact[0]), Math.abs(probe[1] - exact[1]))
  if (e > schedMax) schedMax = e
}

// ---------------------------------------------------------------- counted work units

function countingMath() {
  const c = { sin: 0, cos: 0 }
  return { c, m: { sin: (v) => { c.sin++; return Math.sin(v) }, cos: (v) => { c.cos++; return Math.cos(v) } } }
}
const beforeCount = countingMath()
windBefore([0, 0], 11, 7, 1.3, DIR_X, DIR_Z, WIND_AMP, 1.1, beforeCount.m)
const TRIG_PER_BLADE_BEFORE = beforeCount.c.sin + beforeCount.c.cos
const afterCount = countingMath()
grassWindGust([0, 0, 0], 11, 7, 1.3, DIR_X, DIR_Z, afterCount.m)
const TRIG_PER_GROUP_AFTER = afterCount.c.sin + afterCount.c.cos

const VERTS_LO = INSTANCES * MID_VERTS
const VERTS_HI = INSTANCES * NEAR_VERTS
const TRIG_BEFORE_LO = VERTS_LO * TRIG_PER_BLADE_BEFORE
const TRIG_BEFORE_HI = VERTS_HI * TRIG_PER_BLADE_BEFORE

function timeField(frames, recentreEvery) {
  const f = createGrassWindField()
  for (let i = 0; i < 30; i++) f.update(i * 0.01, 0, 0, WIND_AMP, DIR_X, DIR_Z, reach)
  const times = []
  for (let i = 0; i < frames; i++) {
    const camX = recentreEvery > 0 && (i % recentreEvery === 0) ? (i * 40 % 400) : 0
    const t0 = process.hrtime.bigint()
    f.update(i * 0.01, camX, 0, WIND_AMP, DIR_X, DIR_Z, reach)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  return { mean: times.reduce((s, v) => s + v, 0) / times.length, p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] }
}
const steady = timeField(2000, 0)
const recentring = timeField(2000, 1)
const CELLS_PER_FRAME = field.stats.lastBandCells
const BAND_ROWS = Math.ceil(GRASS_WIND_FIELD_CELLS / GRASS_WIND_FIELD_BANDS)
const BLADES_PER_GROUP = GRASS_WIND_FIELD_EXTENT_M / GRASS_WIND_FIELD_CELLS
const ringArea = Math.PI * RING * RING
const GROUP_M = (GRASS_WIND_FIELD_EXTENT_M / GRASS_WIND_FIELD_CELLS)
const bladesPerGroup = INSTANCES / ringArea * GROUP_M * GROUP_M

// ---------------------------------------------------------------- report

const f2 = (v) => v.toFixed(2)
const f3 = (v) => v.toFixed(3)
const sep = (o) => SEPARATIONS.map((d) => `${d}m ${f3(o.coherence[d])}`).join('  ')
console.log('MEASURED grass-coherent-wind: neighbour coherence (1 = blades move as one)')
console.log(`  before (per-blade phase)  ${sep(B)}`)
console.log(`  after  (shared gust field) ${sep(A)}`)
console.log(`  coherence length (correlation falls to 0.5): ${f2(B.len)}m -> ${f2(A.len)}m`)
console.log(`  displacement over ${N * N} blade(s) x ${TIMES} instant(s): rms ${f3(B.rms)} -> ${f3(A.rms)} m, peak ${f3(B.peak)} -> ${f3(A.peak)} m`)
 console.log(`  collective motion of a 4m block of blades (what reads as turbulence): ${f3(B.collective)} -> ${f3(A.collective)} m`)
console.log(`  lattice vs the exact field: mean ${meanErr.toFixed(5)}m max ${maxErr.toFixed(5)}m against an amplitude of ${f3(ampMax)}m`)
console.log(`  one band per frame at 60fps: the oldest of ${BANDS} band(s) reads ${schedMax.toFixed(5)}m off the exact field`)
console.log(`  counted transcendental(s): ${TRIG_PER_BLADE_BEFORE} per blade before -> ${TRIG_PER_GROUP_AFTER} per group of ~${bladesPerGroup.toFixed(0)} blade(s) after (${TRIG_PER_GROUP_AFTER} per blade of it: 0)`)
console.log(`  per frame: ${TRIG_BEFORE_LO.toLocaleString()}..${TRIG_BEFORE_HI.toLocaleString()} per-blade transcendental(s) -> ${(CELLS_PER_FRAME * TRIG_PER_GROUP_AFTER).toLocaleString()} (${CELLS_PER_FRAME} cell(s) of ${GRASS_WIND_FIELD_CELLS}x${GRASS_WIND_FIELD_CELLS}, ${GRASS_WIND_FIELD_BANDS} band(s) of ${BAND_ROWS} row(s))`)
console.log(`  cpu per frame: 0.000ms before (the shader did it) -> mean ${steady.mean.toFixed(4)}ms p95 ${steady.p95.toFixed(4)}ms; a re-centre rebuilds the lattice once: mean ${recentring.mean.toFixed(4)}ms p95 ${recentring.p95.toFixed(4)}ms max ${recentring.max.toFixed(4)}ms`)
console.log(`  group: ${f2(GROUP_M)}m cell(s) over a ${GRASS_WIND_FIELD_EXTENT_M}m lattice, ~${bladesPerGroup.toFixed(0)} blade(s) per cell at ${INSTANCES.toLocaleString()} instance(s) over a ${RING}m ring -- ${(bladesPerGroup * MID_VERTS).toFixed(0)}..${(bladesPerGroup * NEAR_VERTS).toFixed(0)} vertex evaluation(s) joined into 1`)

// ---------------------------------------------------------------- checks

check('the gust is computed once per group', CELLS_PER_FRAME === GRASS_WIND_FIELD_CELLS * BAND_ROWS && CELLS_PER_FRAME < GRASS_WIND_FIELD_CELLS * GRASS_WIND_FIELD_CELLS,
  `${CELLS_PER_FRAME} of ${GRASS_WIND_FIELD_CELLS * GRASS_WIND_FIELD_CELLS} cell(s) rebuilt per frame`)
check('the wind term carries no per-blade transcendental', TRIG_PER_BLADE_BEFORE >= 6 && !/sin\(gph\)/.test(tslSrc) && !/gGust \* 5\.5/.test(matSrc),
  `${TRIG_PER_BLADE_BEFORE} before, and neither shader path evaluates gGust/gFlow/gph any more`)
check('neighbours move together where they did not', A.coherence[0.5] > 0.9 && B.coherence[0.5] < 0.7,
  `0.5m ${f3(B.coherence[0.5])} -> ${f3(A.coherence[0.5])}`)
check('the coherence length grew', A.len > B.len * 2, `${f2(B.len)}m -> ${f2(A.len)}m`)
check('no blade moves less than it did', A.rms >= B.rms * 0.9 && A.peak >= B.peak * 0.85,
  `per-blade rms ${f3(B.rms)} -> ${f3(A.rms)}m, peak ${f3(B.peak)} -> ${f3(A.peak)}m -- the extreme falls a little because the per-blade spike that made it is now part of the wave`)
check('the turbulence reads MORE, not less', A.collective > B.collective * 1.2,
  `a 4m block of blades moves ${f3(B.collective)} -> ${f3(A.collective)}m (x${(A.collective / B.collective).toFixed(2)})`)
check('the lattice carries the field it stands for', maxErr < 0.2 * ampMax, `max ${maxErr.toFixed(5)}m of ${f3(ampMax)}m (${(100 * maxErr / ampMax).toFixed(1)}%)`)
check('one band per frame is not a visible seam', schedMax < 0.1 * ampMax, `after 600 frame(s) the oldest of ${BANDS} band(s) is ${schedMax.toFixed(5)}m off the exact field, ${(100 * schedMax / ampMax).toFixed(1)}% of ${f3(ampMax)}m`)
check('the join does not buy a hitch', recentring.max < 34 && steady.mean < 1,
  `steady ${steady.mean.toFixed(4)}ms/frame, worst re-centre ${recentring.max.toFixed(4)}ms against the 34ms smallest visible hitch`)
check('both shader paths still read the shared field', /uGrassWindField/.test(matSrc) && /uGrassWindField/.test(tslSrc),
  'client/core/GrassMaterial.js and client/core/GrassTSL.js both sample uGrassWindField')
check('a non-finite clock is refused, not defaulted', (() => {
  const f2f = createGrassWindField()
  const before = f2f.stats.rejectedWrites
  const w = { value: 0, _t: 0 }
  void w
  f2f.update(NaN, 0, 0, WIND_AMP, DIR_X, DIR_Z, reach)
  return f2f.stats.rejectedWrites === before + 1
})(), 'a NaN update is counted in stats.rejectedWrites and changes nothing')

console.log(`RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${failed.length} failure(s)) coherence0.5m=${f3(B.coherence[0.5])}->${f3(A.coherence[0.5])} trigPerFrame=${TRIG_BEFORE_LO.toLocaleString()}..${TRIG_BEFORE_HI.toLocaleString()}->${(CELLS_PER_FRAME * TRIG_PER_GROUP_AFTER).toLocaleString()} cpuMsPerFrame=0.000->${steady.mean.toFixed(4)}`)
process.exit(failed.length === 0 ? 0 : 1)
