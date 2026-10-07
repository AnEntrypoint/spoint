process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = p => pathToFileURL(p).href
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const ONLY = args.only || 'all'
const GRID = Number(args.grid ?? 40)
const CELLS = args.cells ? String(args.cells).split(',').map(Number) : [114, 115]

const SHARED_SAMPLE_MAX_DIFF_M = 1e-6
const SEAM_MAX_DIFF_M = 0.05
const EXACT_MAX_ERR_M = 1
const SHAPE_BRACKET_TOLERANCE_M = 1e-3

const out = []
const log = (...a) => { const s = a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '); out.push(s); process.stdout.write(s + '\n') }
const fail = []
let passCount = 0
const expect = (name, ok, detail) => { log(`EXPECT ${ok ? 'PASS' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); if (!ok) fail.push(name); else passCount++ }

const { loadWorldModule } = await import(href(resolve(ROOT, 'src/sdk/WorldLocator.js')))
const { PhysicsWorld } = await import(href(resolve(ROOT, 'src/physics/World.js')))
const { loadPlanetSampler, planetSamplerOptsOf } = await import(href(resolve(ROOT, 'src/terrain/TerrainPhysics.js')))
const { createPlanetFrame } = await import(href(resolve(ROOT, 'src/terrain/PlanetFrame.js')))
const { sampleTerrainGridChunked } = await import(href(resolve(ROOT, 'src/terrain/HeightfieldStreamer.js')))

const loaded = await loadWorldModule(resolve(ROOT, 'apps/world/tps-game.js'))
const tcfg = { ...loaded.terrain, bakedHeightfield: undefined, vegetation: { ...(loaded.terrain.vegetation || {}), colliders: false, rockColliders: false } }
const tphys = tcfg.physics || {}
const extent = tphys.extent || 510
const resolution = tphys.resolution || 4
let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
const spacing = extent / (N - 1)
const half = extent / 2
const snapCorner = c => Math.round((c - half) / spacing) * spacing

const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const heightFn = (x, z, guess) => frame.groundHeightLocal(x, z, guess)

log('CONFIG', JSON.stringify({ world: 'tps-game', extent, resolution, N, spacing: +spacing.toFixed(4), half, radius: tcfg.radius, reliefScale: tcfg.reliefScale, seed: tcfg.seed, hashVersion: tcfg.hashVersion ?? null }))

const physics = new PhysicsWorld({ gravity: [0, -18, 0] })
await physics.init()

const stats = arr => {
  let min = Infinity, max = -Infinity, finite = 0
  for (const v of arr) { if (Number.isFinite(v)) { finite++; if (v < min) min = v; if (v > max) max = v } }
  return { min, max, range: max - min, finite }
}

async function buildFieldAt(cornerX, cornerZ) {
  const g = await sampleTerrainGridChunked({ heightFn, N, spacing, cornerX, cornerZ, budgetMs: 2, isAborted: () => false })
  const s = stats(g.samples)
  const bodyId = physics.addHeightField(g.samples, N, [spacing, 1, spacing], [cornerX, 0, cornerZ])
  return { bodyId, cornerX, cornerZ, samples: g.samples, min: s.min, max: s.max, range: s.range, finite: s.finite, sampleMs: g.sampleMs }
}

const J = physics.Jolt
const HEIGHT_FIELD_ACCESSORS = [['GetMinHeightValue', 'min'], ['GetMaxHeightValue', 'max'], ['GetSampleCount', 'sampleCount']]
let accessorReads = 0
function heightFieldShapeOf(bodyId) {
  const missing = []
  const read = { min: null, max: null, sampleCount: null, sampleTotal: null, missing }
  const b = physics.bodies.get(bodyId)
  if (!b) { missing.push(`physics.bodies.get(${bodyId})`); return read }
  const shape = b.GetShape()
  if (!shape) { missing.push('Body.GetShape()'); return read }
  if (typeof J.castObject !== 'function' || !J.HeightFieldShape) { missing.push('Jolt.castObject/Jolt.HeightFieldShape'); return read }
  let hf = null
  try { hf = J.castObject(shape, J.HeightFieldShape) } catch (e) { missing.push(`Jolt.castObject threw: ${e && e.message}`); return read }
  if (!hf) { missing.push('Jolt.castObject(shape, Jolt.HeightFieldShape)'); return read }
  for (const [accessor, key] of HEIGHT_FIELD_ACCESSORS) {
    let value = null
    try {
      const fn = hf[accessor]
      if (typeof fn !== 'function') throw new Error('not a function on the Jolt heightfield shape')
      value = fn.call(hf)
    } catch (e) {
      missing.push(`HeightFieldShape.${accessor}() threw: ${e && e.message}`)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push(`HeightFieldShape.${accessor}() returned ${JSON.stringify(value ?? null)}`)
      continue
    }
    read[key] = value
    accessorReads++
  }
  read.sampleTotal = read.sampleCount === null ? null : read.sampleCount * read.sampleCount
  return read
}

async function seamProbe(cellsOffset) {
  const cz = snapCorner(0)
  const cax = snapCorner(0)
  const cbx = cax + cellsOffset * spacing
  const A = await buildFieldAt(cax, cz)
  const B = await buildFieldAt(cbx, cz)
  physics.step(1 / 60)

  const overlapW = extent - cellsOffset * spacing
  const x0 = cbx + 2, x1 = cax + (N - 1) * spacing - 2
  const z0 = cz + 2, z1 = cz + (N - 1) * spacing - 2

  let sharedSampleMaxDiff = 0
  let sharedComparisons = 0
  const dx = Math.round((cbx - cax) / spacing)
  for (let j = 0; j < N; j++) {
    for (let i = dx; i < N; i++) {
      const d = Math.abs(A.samples[j * N + i] - B.samples[j * N + i - dx])
      if (Number.isFinite(d)) { sharedComparisons++; if (d > sharedSampleMaxDiff) sharedSampleMaxDiff = d }
    }
  }

  let topY = Math.max(A.max, B.max), lowY = Math.min(A.min, B.min)
  const originY = topY + 50, rayLen = (topY - lowY) + 120

  let maxDiff = 0, sumDiff = 0, n = 0, worse = null
  let maxErrA = 0, maxErrB = 0, maxErrBoth = 0, exactComparisons = 0
  const diffs = []
  for (let jj = 0; jj < GRID; jj++) {
    const z = z0 + (z1 - z0) * (jj / (GRID - 1))
    for (let ii = 0; ii < GRID; ii++) {
      const x = x0 + (x1 - x0) * (ii / (GRID - 1))
      const origin = [x, originY, z]
      const rA = physics.raycast(origin, [0, -1, 0], rayLen, B.bodyId)
      const rB = physics.raycast(origin, [0, -1, 0], rayLen, A.bodyId)
      const rBoth = physics.raycast(origin, [0, -1, 0], rayLen)
      const yA = rA.hit ? rA.position[1] : NaN
      const yB = rB.hit ? rB.position[1] : NaN
      const yBoth = rBoth.hit ? rBoth.position[1] : NaN
      if (!Number.isFinite(yA) || !Number.isFinite(yB)) continue
      const d = Math.abs(yA - yB)
      diffs.push(d)
      n++; sumDiff += d
      if (d > maxDiff) { maxDiff = d; worse = { x: +x.toFixed(2), z: +z.toFixed(2), yA: +yA.toFixed(5), yB: +yB.toFixed(5), yBoth: +yBoth.toFixed(5) } }
      const exact = heightFn(x, z, NaN)
      if (Number.isFinite(exact)) {
        exactComparisons++
        maxErrA = Math.max(maxErrA, Math.abs(yA - exact))
        maxErrB = Math.max(maxErrB, Math.abs(yB - exact))
        maxErrBoth = Math.max(maxErrBoth, Math.abs(yBoth - exact))
      }
    }
  }
  diffs.sort((a, b) => a - b)
  const p95 = diffs.length ? diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.95))] : 0
  const qStepA = A.range / 65535, qStepB = B.range / 65535
  const rec = {
    cellsOffset,
    parity: cellsOffset % 2 === 0 ? 'even' : 'odd',
    overlapWidthM: +overlapW.toFixed(3),
    points: n,
    perSideSampleCount: N,
    sampleTotalExpected: N * N,
    sharedComparisons,
    exactComparisons,
    fieldA: { cornerX: +cax.toFixed(3), bodyId: A.bodyId, sampleCount: A.samples.length, finiteSamples: A.finite, min: +A.min.toFixed(4), max: +A.max.toFixed(4), range: +A.range.toFixed(4), qStepM: +qStepA.toFixed(6), jolt: heightFieldShapeOf(A.bodyId) },
    fieldB: { cornerX: +cbx.toFixed(3), bodyId: B.bodyId, sampleCount: B.samples.length, finiteSamples: B.finite, min: +B.min.toFixed(4), max: +B.max.toFixed(4), range: +B.range.toFixed(4), qStepM: +qStepB.toFixed(6), jolt: heightFieldShapeOf(B.bodyId) },
    sharedSampleMaxDiffM: +sharedSampleMaxDiff.toFixed(6),
    seamMaxDiffM: +maxDiff.toFixed(6),
    seamMeanDiffM: +(n ? sumDiff / n : 0).toFixed(6),
    seamP95DiffM: +p95.toFixed(6),
    worst: worse,
    maxErrVsExactA: +maxErrA.toFixed(6),
    maxErrVsExactB: +maxErrB.toFixed(6),
    maxErrVsExactBoth: +maxErrBoth.toFixed(6),
    predictedQuantBoundM: +((qStepA + qStepB) / 2).toFixed(6),
  }
  log('SEAM', JSON.stringify(rec))
  const shapeCoversRange = f => f.jolt.missing.length === 0
    && f.jolt.min <= f.min + SHAPE_BRACKET_TOLERANCE_M
    && f.jolt.max >= f.max - SHAPE_BRACKET_TOLERANCE_M
    && f.jolt.sampleCount === N
    && f.jolt.sampleTotal === N * N
  const perSide = f => ({ min: f.jolt.min, max: f.jolt.max, sampleCount: f.jolt.sampleCount, sampleTotal: f.jolt.sampleTotal })
  expect(`seam-${cellsOffset}-measured`, rec.points > 0, rec.points)
  expect(`seam-${cellsOffset}-body-created`, A.bodyId !== null && B.bodyId !== null, [A.bodyId, B.bodyId])
  expect(`seam-${cellsOffset}-sample-total`, A.samples.length === N * N && B.samples.length === N * N && A.finite === N * N && B.finite === N * N, { a: A.samples.length, b: B.samples.length, aFinite: A.finite, bFinite: B.finite, expected: N * N })
  expect(`seam-${cellsOffset}-shape-accessors`, rec.fieldA.jolt.missing.length === 0 && rec.fieldB.jolt.missing.length === 0, { A: rec.fieldA.jolt.missing, B: rec.fieldB.jolt.missing })
  expect(`seam-${cellsOffset}-sample-count-per-side`, rec.fieldA.jolt.sampleCount === N && rec.fieldB.jolt.sampleCount === N && rec.fieldA.jolt.sampleTotal === N * N && rec.fieldB.jolt.sampleTotal === N * N, [perSide(rec.fieldA), perSide(rec.fieldB)])
  expect(`seam-${cellsOffset}-shared-samples-agree`, rec.sharedComparisons === (N - dx) * N && rec.sharedSampleMaxDiffM <= SHARED_SAMPLE_MAX_DIFF_M, { compared: rec.sharedComparisons, expected: (N - dx) * N, maxDiff: rec.sharedSampleMaxDiffM })
  expect(`seam-${cellsOffset}-continuous`, rec.seamMaxDiffM <= SEAM_MAX_DIFF_M, rec.seamMaxDiffM)
  expect(`seam-${cellsOffset}-shape-covers-range`, shapeCoversRange(rec.fieldA) && shapeCoversRange(rec.fieldB), [rec.fieldA.jolt, rec.fieldB.jolt])
  expect(`seam-${cellsOffset}-collider-matches-surface`, rec.exactComparisons === rec.points && rec.maxErrVsExactBoth <= EXACT_MAX_ERR_M, { compared: rec.exactComparisons, points: rec.points, maxErr: rec.maxErrVsExactBoth })
  physics.removeBody(A.bodyId); physics.removeBody(B.bodyId)
  return rec
}

if (ONLY === 'all' || ONLY === 'seam') {
  const recs = []
  for (const c of CELLS) recs.push(await seamProbe(c))
  const worst = recs.reduce((a, b) => (b.seamMaxDiffM > a.seamMaxDiffM ? b : a))
  log('SEAM_WORST', JSON.stringify(worst))
}

physics.destroy()
if (fail.length) { log('FAILED', JSON.stringify(fail)); log(`RESULT: FAIL -- ${fail.length} check(s): ${fail.join('; ')}`); process.exit(1) }
log(`RESULT: PASS -- ${passCount} seam check(s) held over ${accessorReads} heightfield accessor read(s)`)
process.exit(0)
