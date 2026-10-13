#!/usr/bin/env node
// Pins the terrain vertex stage's height/normal stencil without a GPU.
//
// packages/mapspinner/src/tsl/terrain-material-tsl.js builds the per-vertex normal from a finite
// difference over the height field. It used to be a CENTRAL stencil: five taps, four of them spent
// on offsets the vertex's grid neighbours already occupy. It is now a FORWARD stencil: three taps,
// two offsets. The height tap (i = 0) is the same call in both, so vTerrH and every height the
// mesh mirror, the collider and placement read are bit-identical; only the shading normal moves.
// This witness is the claim that the normal did not move enough to be seen:
//
//   1. it counts the snoise3 the height field actually evaluates, by executing the project's own
//      CPU mirror (ops-jsgen compileHeightSpec, the v2 parity backend) with the noise function
//      wrapped in a counter -- a count, not a literal restated from the source;
//   2. it evaluates BOTH stencils over the real height field at the real patch steps, on all six
//      cube faces, and reports the angle between the two normals.
//
// No GPU, no browser: deterministic, and it runs in the gpu-free arm of scripts/check.mjs.
import { createHeightSampler } from '../packages/mapspinner/src/height-cpu.js'
import { createAnchorField } from '../packages/mapspinner/src/anchor-field.js'
import { FACE_FRAME } from '../packages/mapspinner/src/planet-orchestrator-cull.js'
import { TERRAIN_DEFAULTS as TD } from '../packages/mapspinner/src/terrain-defaults.js'
import { compileHeightSpec } from '../packages/mapspinner/src/tsl/ops-jsgen.js'
import { OCTAVE_ROTATION_COS, OCTAVE_ROTATION_SIN } from '../packages/mapspinner/src/tsl/height-spec.js'
import { FD_TAPS } from '../packages/mapspinner/src/tsl/terrain-material-tsl.js'

const RADIUS_M = 6360000.0
const HPF_RES = 128
const SEED = 1337
const GRID = TD.gridMeshSize
const QUARTER_PI = 0.7853981634
// The warp taps the vertex stage pays for on top of the stencil (terrain-material-tsl.js vWarp).
const WARP_SNOISE3 = 3
// The bar is not an absolute angle: a stencil move is called invisible when it stays inside the
// variation the shading normal ALREADY has from one vertex to the next, which this witness measures
// alongside it. An absolute bar would either be below the mesh's own noise (and fail every stencil,
// including the one being replaced) or above the change (and pass anything).
const RATIO_BAR = 1.0

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

let failures = 0
let checks = 0
function check(label, problems) {
  checks++
  if (problems.length) { failures++; console.log(`  FAIL ${label}: ${problems.join('; ')}`) } else console.log(`  ok   ${label}`)
  return problems.length === 0
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]

// The vertex stage's own map from face-local metres to a world direction, verbatim:
//   fl = tan(absLocal / R * QUARTER_PI) * R ;  d = normalize(fu*fl.x + fv*fl.y + fc*R)
function dirAt(face, u, v) {
  const F = FACE_FRAME[face]
  const flx = Math.tan((u / RADIUS_M) * QUARTER_PI) * RADIUS_M
  const fly = Math.tan((v / RADIUS_M) * QUARTER_PI) * RADIUS_M
  return norm([
    F.u[0] * flx + F.v[0] * fly + F.c[0] * RADIUS_M,
    F.u[1] * flx + F.v[1] * fly + F.c[1] * RADIUS_M,
    F.u[2] * flx + F.v[2] * fly + F.c[2] * RADIUS_M,
  ])
}

// A patch at quadtree level L spans 2R / 2^L face-local metres on a face of extent [-R, R], and the
// stencil offsets by one grid step, so the step is the patch size over the grid resolution.
const stepForLevel = (level) => (2 * RADIUS_M) / (Math.pow(2, level) * GRID)

function countingHeightSpec() {
  const af = createAnchorField({ seed: SEED })
  const faceBuf = new Array(6).fill(null)
  const bakeFace = (face) => {
    const buf = new Float32Array(HPF_RES * HPF_RES * 4)
    for (let y = 0; y < HPF_RES; y++) {
      for (let x = 0; x < HPF_RES; x++) {
        const s = af.sampleUV(face, x / (HPF_RES - 1), y / (HPF_RES - 1), Math.round(Math.log2(HPF_RES)))
        const o = (y * HPF_RES + x) * 4
        buf[o] = s.seaBias; buf[o + 1] = s.elevAmp; buf[o + 2] = s.temp; buf[o + 3] = s.humidity
      }
    }
    faceBuf[face] = buf
    return buf
  }
  const { composeHeight, source } = compileHeightSpec({
    hashVersion: 2,
    carves: [],
    params: { hpfRes: HPF_RES, landBias: 0, beachShelfM: TD.beachShelfM ?? 150, reliefScale: 0 },
    hpfFace: (face) => faceBuf[face] || bakeFace(face),
    hpfRes: HPF_RES,
  })
  const marker = 'return function composeHeight'
  if (!source.includes(marker)) throw new Error(`ops-jsgen source lost its entry marker, so the noise counter cannot be installed: ${source.slice(0, 200)}`)
  if (!source.includes('function msSnoise3(')) throw new Error('ops-jsgen inlined msSnoise3 instead of emitting it as a function, so the noise counter has nothing to wrap')
  const counter = { n: 0 }
  const patched = source.replace(marker, `msSnoise3 = __probe(msSnoise3);\n${marker}`)
  const probe = (orig) => (a, b, c) => { counter.n++; return orig(a, b, c) }
  const src = `const ROT_COS=arguments[0],ROT_SIN=arguments[1],CARVE=arguments[2],HPF=arguments[3],HPF_RES=arguments[4],__probe=arguments[5];\n${patched}`
  const counted = new Function(src)(OCTAVE_ROTATION_COS, OCTAVE_ROTATION_SIN, [], (f) => faceBuf[f] || bakeFace(f), HPF_RES, probe)
  return { composeHeight, counted, counter }
}

function main() {
  const levelsArg = arg('levels', '2,6,11,16,20,22')
  const levels = levelsArg.split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
  const spanFrac = Number(arg('span', '0.7'))
  const perAxis = Number(arg('per-axis', '5'))
  console.log(`[terrain-vs-normal] radius=${RADIUS_M} grid=${GRID} hpfRes=${HPF_RES} seed=${SEED} levels=${levels.join(',')} spanFrac=${spanFrac} perAxis=${perAxis}`)

  const { counted, counter } = countingHeightSpec()
  counter.n = 0
  const probeDir = norm([0.31, 0.87, -0.38])
  counted(probeDir[0], probeDir[1], probeDir[2])
  const snoisePerCompose = counter.n
  console.log(`[terrain-vs-normal] measured snoise3 per composeHeight: ${snoisePerCompose} (from the executed CPU mirror, not from a literal)`)
  check('the height field evaluates 48 snoise3 per composeHeight', snoisePerCompose === 48 ? [] : [`got ${snoisePerCompose}`])

  check('the vertex stencil is the 3-tap forward difference', FD_TAPS === 3 ? [] : [`FD_TAPS is ${FD_TAPS}, expected 3`])
  const beforePerVertex = 5 * snoisePerCompose + WARP_SNOISE3
  const afterPerVertex = FD_TAPS * snoisePerCompose + WARP_SNOISE3
  console.log(`[terrain-vs-normal] vertex stage snoise3 per vertex: ${beforePerVertex} before (5 taps) -> ${afterPerVertex} after (${FD_TAPS} taps), ${(100 * (1 - afterPerVertex / beforePerVertex)).toFixed(1)}% removed`)
  check('the vertex stage evaluates fewer than 240 snoise3 per vertex', afterPerVertex < 240 ? [] : [`got ${afterPerVertex}`])

  const sampler = createHeightSampler({ radius: RADIUS_M, seed: SEED, hashVersion: 2, hpfTexRes: HPF_RES })
  const heightAt = (d) => sampler.heightAt(d)

  const positions = []
  for (let face = 0; face < 6; face++) {
    for (let i = 0; i < perAxis; i++) {
      for (let j = 0; j < perAxis; j++) {
        const fu = (-1 + (2 * i) / (perAxis - 1)) * spanFrac * RADIUS_M
        const fv = (-1 + (2 * j) / (perAxis - 1)) * spanFrac * RADIUS_M
        positions.push([face, fu, fv])
      }
    }
  }

  const byLevel = []
  let worst = { angleDeg: 0 }
  let heightMismatch = 0
  let samples = 0
  const angles = []
  const natural = []
  for (const level of levels) {
    const step = stepForLevel(level)
    // One stencil evaluation at one face-local position: five taps for the central difference, of
    // which the forward difference reuses taps 0, 1 and 3.
    const stencilAt = (face, fu, fv) => {
      const sample = (du, dv) => {
        const d = dirAt(face, fu + du * step, fv + dv * step)
        const h = heightAt(d)
        return { d, h, w: [d[0] * (RADIUS_M + h), d[1] * (RADIUS_M + h), d[2] * (RADIUS_M + h)] }
      }
      const c = sample(0, 0)
      const pu = sample(1, 0)
      const mu = sample(-1, 0)
      const pv = sample(0, 1)
      const mv = sample(0, -1)
      const w0 = [c.d[0] * (RADIUS_M + c.h), c.d[1] * (RADIUS_M + c.h), c.d[2] * (RADIUS_M + c.h)]
      const orient = (n) => (dot(n, c.d) < 0 ? n.map((x) => -x) : n)
      return {
        h: c.h,
        centre: c.d,
        central: orient(norm(cross(sub(pu.w, mu.w), sub(pv.w, mv.w)))),
        forward: orient(norm(cross(sub(pu.w, w0), sub(pv.w, w0)))),
      }
    }
    const localDelta = []
    const localNatural = []
    for (const [face, fu, fv] of positions) {
      const here = stencilAt(face, fu, fv)
      // The noise floor this comparison is judged against is the mesh's OWN: how much the
      // central-difference normal already turns between two adjacent vertices one grid step apart.
      // A stencil move smaller than that is not a systematic artifact, it is inside the variation
      // the surface already has from vertex to vertex.
      const neighbour = stencilAt(face, fu + step, fv)
      const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI
      const deltaDeg = angle(here.central, here.forward)
      const naturalDeg = angle(here.central, neighbour.central)
      if (!Number.isFinite(deltaDeg) || !Number.isFinite(naturalDeg)) throw new Error(`non-finite normal angle at face ${face} u=${fu} v=${fv} step=${step}`)
      localDelta.push(deltaDeg)
      localNatural.push(naturalDeg)
      angles.push(deltaDeg)
      natural.push(naturalDeg)
      samples++
      if (deltaDeg > worst.angleDeg) worst = { angleDeg: deltaDeg, face, fu, fv, step, level }
      if (here.h !== here.h) heightMismatch++
    }
    localDelta.sort((a, b) => a - b)
    localNatural.sort((a, b) => a - b)
    byLevel.push({
      level,
      stepM: step,
      samples: localDelta.length,
      medianDeg: pct(localDelta, 0.5),
      p95Deg: pct(localDelta, 0.95),
      maxDeg: localDelta[localDelta.length - 1],
      naturalMedianDeg: pct(localNatural, 0.5),
      naturalP95Deg: pct(localNatural, 0.95),
    })
    console.log(`[terrain-vs-normal] level ${String(level).padStart(2)} step=${step.toPrecision(4)}m  stencil move median=${pct(localDelta, 0.5).toFixed(3)}deg p95=${pct(localDelta, 0.95).toFixed(3)}deg max=${localDelta[localDelta.length - 1].toFixed(3)}deg | mesh's own vertex-to-vertex normal turn median=${pct(localNatural, 0.5).toFixed(3)}deg p95=${pct(localNatural, 0.95).toFixed(3)}deg`)
  }

  angles.sort((a, b) => a - b)
  natural.sort((a, b) => a - b)
  const medianDeg = pct(angles, 0.5)
  const p95Deg = pct(angles, 0.95)
  const maxDeg = angles[angles.length - 1]
  const naturalMedian = pct(natural, 0.5)
  const naturalP95 = pct(natural, 0.95)
  console.log(`[terrain-vs-normal] ${samples} sample(s) over ${levels.length} step(s) x ${positions.length} position(s): stencil move median=${medianDeg.toFixed(3)}deg p95=${p95Deg.toFixed(3)}deg max=${maxDeg.toFixed(3)}deg`)
  console.log(`[terrain-vs-normal] noise floor (the mesh's own adjacent-vertex normal turn): median=${naturalMedian.toFixed(3)}deg p95=${naturalP95.toFixed(3)}deg`)
  console.log(`[terrain-vs-normal] worst at face=${worst.face} u=${(worst.fu || 0).toFixed(0)} v=${(worst.fv || 0).toFixed(0)} step=${(worst.step || 0).toPrecision(4)}m level=${worst.level}`)

  check('every sample produced a finite normal angle', angles.length === samples ? [] : [`${angles.length} of ${samples}`])
  check('the height tap is finite at every sample', heightMismatch === 0 ? [] : [`${heightMismatch} non-finite centre height(s)`])
  check(`the noise floor is non-zero (the mesh's own normal turns between adjacent vertices)`, naturalMedian > 0 ? [] : ['the adjacent-vertex normal turn is 0, so this comparison has no denominator'])
  check(`the stencil move is inside the mesh's own normal variation at the median (${medianDeg.toFixed(3)}deg vs ${naturalMedian.toFixed(3)}deg)`, medianDeg <= naturalMedian * RATIO_BAR ? [] : [`median move ${medianDeg.toFixed(3)}deg over the ${naturalMedian.toFixed(3)}deg the normal already turns per vertex`])
  check(`the stencil move is inside the mesh's own normal variation at p95 (${p95Deg.toFixed(3)}deg vs ${naturalP95.toFixed(3)}deg)`, p95Deg <= naturalP95 * RATIO_BAR ? [] : [`p95 move ${p95Deg.toFixed(3)}deg over the ${naturalP95.toFixed(3)}deg the normal already turns per vertex`])

  console.log(`MEASURED terrain-vs-normal: ${samples} stencil comparison(s) over ${levels.length} patch step(s) and ${positions.length} face position(s); ${snoisePerCompose} snoise3 per composeHeight counted from the executed CPU mirror; vertex stage ${beforePerVertex} -> ${afterPerVertex} snoise3 per vertex; normal delta median ${medianDeg.toFixed(3)}deg p95 ${p95Deg.toFixed(3)}deg max ${maxDeg.toFixed(3)}deg`)
  if (failures) { console.log(`RESULT: FAIL -- ${failures} of ${checks} check(s) failed`); process.exit(1) }
  console.log(`RESULT: PASS -- ${checks} of ${checks} check(s) passed`)
}

try {
  main()
} catch (e) {
  console.error('[terrain-vs-normal] threw:\n', e.stack || e.message)
  process.exit(1)
}
