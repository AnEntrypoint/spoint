import { createPlacementLattice } from '../src/terrain/PlacementLattice.js'

const RADIUS_M = 63600
const CHUNK_M = 32
const CELLS_PER_CHUNK = 8

const L = createPlacementLattice(RADIUS_M, CHUNK_M, CELLS_PER_CHUNK)
const N = L.chunksPerFace
const _c = [0, 0, 0]
const _dec = [0, 0, 0]

function normalized(v) {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

function tangentBasis(d) {
  const a = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const t1 = normalized([
    a[1] * d[2] - a[2] * d[1],
    a[2] * d[0] - a[0] * d[2],
    a[0] * d[1] - a[1] * d[0],
  ])
  const t2 = [
    d[1] * t1[2] - d[2] * t1[1],
    d[2] * t1[0] - d[0] * t1[2],
    d[0] * t1[1] - d[1] * t1[0],
  ]
  return [t1, t2]
}

function offsetDir(d, t1, t2, au, av) {
  const tu = Math.tan(au), tv = Math.tan(av)
  return normalized([
    d[0] + tu * t1[0] + tv * t2[0],
    d[1] + tu * t1[1] + tv * t2[1],
    d[2] + tu * t1[2] + tv * t2[2],
  ])
}

function chordSqToCentre(d, key) {
  L.chunkCentreDir(key, _c)
  const ex = _c[0] - d[0], ey = _c[1] - d[1], ez = _c[2] - d[2]
  return ex * ex + ey * ey + ez * ez
}

function truthKeys(d, radiusM) {
  const maxAngle = radiusM / RADIUS_M
  const maxChordSq = 4 * Math.sin(maxAngle / 2) ** 2
  const [t1, t2] = tangentBasis(d)
  const x = radiusM / CHUNK_M
  const steps = Math.max(24, Math.ceil(2.5 * x))
  const extra = Math.max(4, Math.ceil(1.5 * steps / x))
  const stepA = maxAngle / steps
  const limit = maxAngle + L.chunkAngle * 1.5
  const out = new Set()
  for (let i = -steps - extra; i <= steps + extra; i++) {
    const au = i * stepA
    for (let j = -steps - extra; j <= steps + extra; j++) {
      const av = j * stepA
      if (au * au + av * av > limit * limit) continue
      const s = offsetDir(d, t1, t2, au, av)
      const key = L.chunkKeyOfDir(s[0], s[1], s[2])
      if (out.has(key)) continue
      if (chordSqToCentre(d, key) <= maxChordSq) out.add(key)
    }
  }
  return out
}

const keepVeg = 64 * 1.1
const ringRadiusVeg = keepVeg + 4 + CHUNK_M
const keepRock = 32 * 1.1
const ringRadiusRock = keepRock + 4 + CHUNK_M
const multiples = [1, 2, ringRadiusVeg / CHUNK_M, 5.5, 8, 12]
const radii = multiples.map((m) => m * CHUNK_M)

let seed = 20261007
const rand01 = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

const dirs = []
const centreOut = [0, 0, 0]
for (let face = 0; face < 6; face++) {
  const mid = L.cellsPerFace / 2
  dirs.push({ where: `face ${face} centre`, d: [...L.cellDir(face, mid, mid, [0, 0, 0])] })
  dirs.push({ where: `face ${face} u edge`, d: [...L.cellDir(face, L.cellsPerFace, mid, [0, 0, 0])] })
  dirs.push({ where: `face ${face} v edge`, d: [...L.cellDir(face, mid, L.cellsPerFace, [0, 0, 0])] })
  dirs.push({ where: `face ${face} corner`, d: [...L.cellDir(face, L.cellsPerFace, L.cellsPerFace, [0, 0, 0])] })
}
for (let i = 0; i < 60; i++) {
  const d = normalized([rand01() * 2 - 1, rand01() * 2 - 1, rand01() * 2 - 1])
  dirs.push({ where: `random ${i}`, d })
}
for (let i = 0; i < 40; i++) {
  const face = i % 6
  const fracs = [0.002, 0.01, 0.03, L.cellsPerFace - 0.03, L.cellsPerFace - 0.002]
  const fu = fracs[i % fracs.length], fv = fracs[(i + 2) % fracs.length]
  dirs.push({ where: `face ${face} near-edge ${fu.toFixed(3)}/${fv.toFixed(3)}`, d: [...L.cellDir(face, fu, fv, [0, 0, 0])] })
}
void centreOut

let missingTotal = 0
let extraTotal = 0
let cases = 0
const worst = []
for (const { where, d } of dirs) {
  for (const radiusM of radii) {
    cases++
    const maxAngle = radiusM / RADIUS_M
    const maxChordSq = 4 * Math.sin(maxAngle / 2) ** 2
    const truth = truthKeys(d, radiusM)
    const ring = new Set(L.ringAroundDir(d[0], d[1], d[2], radiusM))
    let missing = 0
    for (const k of truth) if (!ring.has(k)) missing++
    let extra = 0
    for (const k of ring) if (chordSqToCentre(d, k) > maxChordSq) extra++
    missingTotal += missing
    extraTotal += extra
    if (missing > 0) worst.push({ where, radiusM: radiusM.toFixed(1), truth: truth.size, ring: ring.size, missing })
  }
}
worst.sort((a, b) => b.missing - a.missing)
console.log(`ring bound: ${cases} case(s), ${dirs.length} direction(s), ${radii.length} radius/radii`)
console.log(`   chunks within the radius but missing from the ring: ${missingTotal}`)
console.log(`   chunks in the ring that are beyond the radius:       ${extraTotal}`)
for (const w of worst.slice(0, 12)) {
  console.log(`   missing ${w.missing} of ${w.truth}: ${w.where} at ${w.radiusM} m (ring has ${w.ring})`)
}

function benchBest(label, iters, fn) {
  let best = Infinity
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iters; i++) fn(i)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (ms < best) best = ms
  }
  const us = best / iters * 1000
  console.log(`${label}: ${us.toFixed(2)} us/call (best of 5, ${iters} call(s))`)
  return us
}

const spreadDirs = []
for (let i = 0; i < 512; i++) spreadDirs.push(normalized([rand01() * 2 - 1, rand01() * 2 - 1, rand01() * 2 - 1]))
const edgeDirs = []
for (let face = 0; face < 6; face++) {
  for (let i = 0; i < 32; i++) {
    const f = 0.2 + (i / 32) * (L.cellsPerFace - 0.4)
    edgeDirs.push([...L.cellDir(face, L.cellsPerFace, f, [0, 0, 0])])
    edgeDirs.push([...L.cellDir(face, f, L.cellsPerFace, [0, 0, 0])])
  }
}
const cornerDirs = []
for (let face = 0; face < 6; face++) {
  for (let i = 0; i < 64; i++) {
    const f = 0.2 + (i / 64) * (L.cellsPerFace - 0.4)
    cornerDirs.push([...L.cellDir(face, L.cellsPerFace, f, [0, 0, 0])])
    cornerDirs.push([...L.cellDir(face, f, L.cellsPerFace, [0, 0, 0])])
  }
}
let ringKeys = 0
let ringCalls = 0
function benchRing(label, dirs, radiusM) {
  const us = benchBest(label, dirs.length, (i) => {
    ringKeys += L.ringAroundDir(dirs[i][0], dirs[i][1], dirs[i][2], radiusM).length
    ringCalls++
  })
  return us
}
const vegUs = benchRing('veg ring, 512 interior dirs', spreadDirs, ringRadiusVeg)
const vegEdgeUs = benchRing('veg ring, face-edge dirs', edgeDirs, ringRadiusVeg)
const vegCornerUs = benchRing('veg ring, face-edge+corner dirs', cornerDirs, ringRadiusVeg)
const rockUs = benchRing('rock ring, 512 interior dirs', spreadDirs, ringRadiusRock)
console.log(`   ${(ringKeys / ringCalls).toFixed(1)} key(s) per ring average`)

let distinct = 0
{
  const seen = new Set()
  for (let i = 0; i < 4000; i++) {
    const d = normalized([rand01() * 2 - 1, rand01() * 2 - 1, rand01() * 2 - 1])
    const key = L.chunkKeyOfDir(d[0], d[1], d[2])
    L.decodeChunk(key, _dec)
    seen.add(key)
  }
  distinct = seen.size
}
console.log(`   ${distinct} distinct chunk key(s) sampled over the planet`)

const bad = missingTotal + extraTotal
console.log(`RESULT: ${bad === 0 ? 'PASS' : 'FAIL'} (missing ${missingTotal}, beyond ${extraTotal}, veg ${vegUs.toFixed(2)} us, edge ${vegEdgeUs.toFixed(2)} us, corner ${vegCornerUs.toFixed(2)} us, rock ${rockUs.toFixed(2)} us)`)
process.exit(bad === 0 ? 0 : 1)
