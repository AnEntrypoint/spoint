// Witness: the three surfaces near the player -- the collider's baked lattice, the CPU mirror of the
// rendered terrain mesh, and the placement sampler -- and how much of the same (x,z) height they each
// recompute.
//
// The three consumers of one ground, as they shipped:
//   COLLIDER  src/terrain/HeightfieldStreamer.js builds a Jolt HeightFieldShape at the spacing
//             src/shared/colliderLattice.js derives; inside the bake's coverage it reads the baked
//             artifact (apps/world/tps-game.hf, N=257 over 256 m = 1.0000 m) and outside it re-solves.
//   MESH      src/terrain/TerrainMeshSurface.js reconstructs the drawn quads on the CPU by calling
//             sampler.heightAt once PER VERTEX, so placement can sit on what is drawn.
//   PLACEMENT src/terrain/PlacementChart.js surfaceAlongDir solves the surface per cell (five solves
//             per grass cell: one for the cell, four for the slope/curvature jet), and
//             src/terrain/GrassPlacement.js then extrapolates each blade off that cell.
//
// So one (x,z) near the player was answered up to four times: once by the GPU vertex stage, once by
// the CPU mirror, once by the collider field, once per placement solve. The increment makes the CPU
// mirror read the collider's own sample buffer, so the mirror, the collider and everything placement
// asks are one copy, and this measures both halves: what that costs and exactly what it moves.
//
// No GPU: every number here is CPU main-thread, and no per-pass GPU timing is cited anywhere.
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const argv = process.argv.slice(2)
const arg = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h === undefined ? d : h.slice(n.length + 3) }
const num = (n, d) => { const v = Number(arg(n, NaN)); return Number.isFinite(v) ? v : d }

const WORLD = arg('world', 'tps-game')
const CHUNKS = Math.max(1, Math.round(num('chunks', 4)))
const PROBES = Math.max(200, Math.round(num('probes', 4000)))
const BANDS = [[0, 32, 'near'], [32, 64, 'mid'], [64, 128, 'far']]

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} = ${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)

function radicalInverse(k, b) {
  let f = 1, r = 0
  while (k > 0) { f /= b; r += f * (k % b); k = Math.floor(k / b) }
  return r
}
const p95 = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
const r6 = (v) => Math.round(v * 1e6) / 1e6

const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainHashVersionOf, terrainCarvesOf } = await import(href('src/shared/terrainConfig.js'))
const { createTerrainMeshSurface } = await import(href('src/terrain/TerrainMeshSurface.js'))
const { loadLatticeSurface } = await import(href('src/terrain/LatticeSurface.js'))
const { createExactPatchFrame } = await import(href('client/core/ExactPatchFrame.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt, surfaceOfCell } = await import(href('src/terrain/VegPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
const { Quadtree } = await import('mapspinner/quadtree.js')
const { resolveLodConfig, applyLodConfig } = await import('mapspinner/lod-config.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { worldToFaceLocal } = await import('mapspinner/planet-orchestrator-cull.js')
const { createHeightSampler } = await import('mapspinner/height-cpu')

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const tcfg = loaded.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0

const sampler = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })

// Counted work: every CPU surface above is ultimately this one call, so counting it counts, in one
// unit, how many times the same question is answered per unit of placement work.
let solveCalls = 0
const rawHeightAt = sampler.heightAt.bind(sampler)
sampler.heightAt = (d) => { solveCalls++; return rawHeightAt(d) }

const baked = await loadLatticeSurface({ url: tcfg.bakedHeightfield, tcfg, frame })
const bakedStep = baked ? baked.extent / (baked.N - 1) : NaN
console.log(`world=${WORLD} radius=${R} hashVersion=${hashVersion}`)
console.log(`bake=${tcfg.bakedHeightfield || '(none)'} ${baked ? `N=${baked.N} extent=${baked.extent} step=${bakedStep.toFixed(4)}m kind=${baked.kind}` : 'ABSENT'}`)
expect('the verified bake loaded', !!baked, (v) => v === true)
expect('the bake is the collider lattice: 1.0000 m over 256 m', baked ? [baked.N, bakedStep] : null, (v) => Array.isArray(v) && v[0] === 257 && Math.abs(v[1] - 1) < 1e-9)

// ---------------------------------------------------------------- 1. lattice vs the exact CPU solve
const half = baked.extent / 2
const bands = BANDS.map(() => ({ n: 0, all: [] }))
let nodeMax = 0
for (let k = 1; k <= PROBES; k++) {
  const x = -half + radicalInverse(k, 2) * baked.extent
  const z = -half + radicalInverse(k, 3) * baked.extent
  if (!baked.covers(x, z)) continue
  const exact = frame.groundHeightLocal(x, z)
  const lat = baked.heightAtLocal(x, z)
  if (!Number.isFinite(exact) || !Number.isFinite(lat)) continue
  const d = Math.hypot(x, z)
  const bi = BANDS.findIndex(([lo, hi]) => d >= lo && d < hi)
  if (bi < 0) continue
  bands[bi].n++; bands[bi].all.push(Math.abs(lat - exact))
}
console.log('--- lattice (the baked 1 m grid) vs the exact chart-local solve, |delta| in metres')
for (let i = 0; i < BANDS.length; i++) {
  const [lo, hi, nm] = BANDS[i]
  const b = bands[i]
  console.log(`  band ${nm.padEnd(4)} [${lo},${hi})m n=${b.n} mean=${mean(b.all).toFixed(4)} p95=${p95(b.all).toFixed(4)} max=${Math.max(...b.all).toFixed(4)}`)
}
for (let k = 0; k < 500; k++) {
  const ix = Math.floor(radicalInverse(k + 1, 5) * (baked.N - 1))
  const iz = Math.floor(radicalInverse(k + 1, 7) * (baked.N - 1))
  const x = -half + ix * bakedStep, z = -half + iz * bakedStep
  const d = Math.abs(baked.heightAtLocal(x, z) - frame.groundHeightLocal(x, z))
  if (Number.isFinite(d) && d > nodeMax) nodeMax = d
}
console.log(`  on the lattice's own nodes: max |delta| = ${nodeMax.toFixed(6)} m (the artifact's quantization, not its spacing)`)
expect('lattice-vs-exact stays under 0.05 m mean inside the grass ring', r6(mean(bands[0].all)), (v) => finite(v) && v <= 0.05)
expect('on-node quantization stays under 1 mm', r6(nodeMax), (v) => finite(v) && v <= 0.001)

// ---------------------------------------------------------------- 2. what one answer costs
function timePerCall(fn, n, make) {
  const args = []
  for (let i = 0; i < n; i++) args.push(make(i))
  fn(args[0]); fn(args[0])
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fn(args[i])
  return Number(process.hrtime.bigint() - t0) / 1000 / n
}
let k2 = 0
const rndXZ = () => { const k = ++k2; return [-half + radicalInverse(k, 2) * baked.extent, -half + radicalInverse(k, 3) * baked.extent] }
const usBake = timePerCall((a) => baked.heightAtLocal(a[0], a[1]), 200000, rndXZ)
const usGround = timePerCall((a) => frame.groundHeightLocal(a[0], a[1]), 20000, rndXZ)
const usElev = timePerCall((a) => frame.elevationAtDir(frame.localToDir(a[0], a[1])), 20000, rndXZ)
const usRaw = timePerCall((a) => rawHeightAt(frame.localToDir(a[0], a[1])), 4000, rndXZ)
console.log('--- cost of ONE (x,z) height, microseconds')
console.log(`  lattice heightAtLocal  : ${usBake.toFixed(3)} us`)
console.log(`  frame.groundHeightLocal: ${usGround.toFixed(3)} us  (${(usGround / usBake).toFixed(0)}x)`)
console.log(`  frame.elevationAtDir   : ${usElev.toFixed(3)} us  (${(usElev / usBake).toFixed(0)}x)`)
console.log(`  sampler.heightAt (raw) : ${usRaw.toFixed(3)} us  (${(usRaw / usBake).toFixed(0)}x)`)
expect('one lattice sample is at least 10x cheaper than the chart-local solve', Math.round(usGround / usBake), (v) => finite(v) && v >= 10)

// ---------------------------------------------------------------- 3. the drawn mesh, on the CPU
const qt = new Quadtree(R)
const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, 70 * Math.PI / 180)
const splitDist = applyLodConfig(qt, R, 1080, lod)
const camWorld = frame.localToWorld(0, frame.groundHeightLocal(0, 0) + 1.7, 0)
const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R
const leaves = []
for (let face = 0; face < 6; face++) {
  const lc = worldToFaceLocal(face, camWorld, R)
  for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) leaves.push({ face, ...q })
}
const offsets = new Float32Array(leaves.length * 4)
const faces = new Float32Array(leaves.length)
for (let i = 0; i < leaves.length; i++) {
  const q = leaves[i]
  offsets[i * 4] = q.ox; offsets[i * 4 + 1] = q.oy; offsets[i * 4 + 2] = q.l; offsets[i * 4 + 3] = q.level
  faces[i] = q.face
}
const quads = () => ({ offsets, faces, count: leaves.length, gridSize: TD.gridMeshSize, radius: R })
console.log(`--- drawn mesh: maxLevel=${lod.maxLevel} splitDist=${splitDist.toFixed(3)} quads=${leaves.length} gridSize=${TD.gridMeshSize} vertsPerQuad=${(TD.gridMeshSize + 1) ** 2}`)
// The duplicate, in one count: the GPU vertex stage evaluates the height function at every vertex of
// every drawn quad EVERY frame, and the CPU mirror evaluated the same function again at the same
// vertices to answer placement. The collider evaluates it once per field node, but reads the bake for
// those. No GPU timing is used or implied -- this is a count of evaluations, not a measure of time.
console.log(`--- same ground, counted evaluations: GPU vertex stage ${leaves.length * (TD.gridMeshSize + 1) ** 2}/frame ; collider field ${257 * 257} nodes per field (read from the bake where it covers) ; CPU mirror one per materialised vertex`)

const anchorField = createCachedAnchorField(sampler.anchorField, frame)
const lattice = latticeFor(frame, GRASS)
const chunks = []
for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
  if (chunks.length >= CHUNKS) break
  chunks.push(chunkKeyAtLocal(lattice, frame, cx * GRASS.CHUNK, cz * GRASS.CHUNK))
}
const cellsPerChunk = GRASS.GRID * GRASS.GRID

// One mirror per arm. The only difference between them is where a vertex's height comes from.
function placeAll(latticeOpt) {
  const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads, ...(latticeOpt ? { lattice: latticeOpt } : {}) })
  surface.setFocus(0, 0)
  surface.sync()
  const prev = frame.renderMeshHeightAtLocal
  frame.renderMeshHeightAtLocal = surface.heightAtLocal
  const ef = createExactPatchFrame(frame)
  solveCalls = 0
  const t0 = process.hrtime.bigint()
  const lists = [], cellYs = []
  const cell = createPlacementCell(frame)
  for (const key of chunks) {
    const dec = lattice.decodeChunk(key, [0, 0, 0])
    const row = []
    for (let gz = 0; gz < GRASS.GRID; gz++) {
      for (let gx = 0; gx < GRASS.GRID; gx++) {
        placementCellAt(frame, lattice, dec, gx, gz, (worldSeed | 0) ^ 0x6a55, GRASS.JITTER / GRASS.CELL, 20, 21, cell)
        const rho = surfaceOfCell(ef.placementFrame, cell)
        row.push(Number.isFinite(rho) ? cell.at[1] : NaN)
      }
    }
    cellYs.push(row)
    let list = null
    try { list = placementsForGrassChunk(key, ef.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    lists.push(list)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  frame.renderMeshHeightAtLocal = prev
  return { lists, cellYs, ms, solves: solveCalls, stats: surface.stats() }
}

const before = placeAll(null)
const after = placeAll(baked)
console.log(`--- placing ${chunks.length} grass chunk(s) = ${chunks.length * cellsPerChunk} cells, BEFORE (mirror re-solves the sampler) vs AFTER (mirror reads the collider's lattice)`)
for (const [label, r] of [['before', before], ['after', after]]) {
  const blades = r.lists.reduce((a, l) => a + (l ? l.length : 0), 0)
  console.log(`  ${label.padEnd(6)} sampler.heightAt=${String(r.solves).padStart(5)}  perCell=${(r.solves / (chunks.length * cellsPerChunk)).toFixed(2)}  blades=${blades}  wall=${r.ms.toFixed(1)}ms (${(r.ms / chunks.length).toFixed(1)} ms/chunk)`)
  console.log(`         mirror: builds=${r.stats.builds} queries=${r.stats.queries} served=${r.stats.served} unserved=${r.stats.unserved} rescans=${r.stats.rescans} latticeHits=${r.stats.latticeVertexHits} latticeMisses=${r.stats.latticeVertexMisses}`)
}
expect('BEFORE: the mirror re-solved the sampler once per vertex', before.solves, (v) => Number.isInteger(v) && v > 0)
expect('BEFORE: no vertex came from the lattice', before.stats.latticeVertexHits, (v) => v === 0)
expect('AFTER: every mirror vertex came from the lattice', after.stats.latticeVertexHits, (v) => Number.isInteger(v) && v > 0)
expect('AFTER: no mirror vertex needed the sampler', after.stats.latticeVertexMisses, (v) => v === 0)
expect('AFTER: the sampler was never called', after.solves, (v) => v === 0)
expect('AFTER is no slower than BEFORE', r6(after.ms / before.ms), (v) => finite(v) && v <= 1.05)

// ---------------------------------------------------------------- 4. exactly what moved
// The point of one copy is that the consumers AGREE, so what matters is not agreement with a third
// surface but the pairwise delta between the two builds over the same cells and the same blades.
const bladeDy = [], cellDy = []
let bladeCountMismatch = 0
for (let c = 0; c < chunks.length; c++) {
  const a = before.lists[c], b = after.lists[c]
  const na = a ? a.length : 0, nb = b ? b.length : 0
  if (na !== nb) bladeCountMismatch++
  const n = Math.min(na, nb)
  for (let i = 0; i < n; i++) bladeDy.push(Math.abs(b[i].y - a[i].y))
}
for (let c = 0; c < chunks.length; c++) {
  const a = before.cellYs[c], b = after.cellYs[c]
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) cellDy.push(Math.abs(b[i] - a[i]))
}
console.log('--- what the one-copy change moved (BEFORE vs AFTER, same cells and same blades)')
console.log(`  grass cell ground y : n=${cellDy.length} mean=${mean(cellDy).toFixed(5)} p95=${p95(cellDy).toFixed(5)} max=${Math.max(...cellDy).toFixed(5)} m`)
console.log(`  grass blade y       : n=${bladeDy.length} mean=${mean(bladeDy).toFixed(5)} p95=${p95(bladeDy).toFixed(5)} max=${Math.max(...bladeDy).toFixed(5)} m`)
console.log(`  chunks whose blade count changed: ${bladeCountMismatch} of ${chunks.length}`)
expect('no chunk gained or lost blades', bladeCountMismatch, (v) => v === 0)
expect('cell ground moved less than 5 cm', r6(Math.max(...cellDy)), (v) => finite(v) && v <= 0.05)
expect('blade y moved less than 10 cm', r6(Math.max(...bladeDy)), (v) => finite(v) && v <= 0.1)
expect('the change is not a no-op: something moved', r6(Math.max(...cellDy)), (v) => finite(v) && v > 0)

// ---------------------------------------------------------------- 6. the same increment, for trees
// Grass only reaches 61.6 m, where the drawn mesh is still at the collider's own spacing. Trees and
// rocks reach far past it, and out there the drawn mesh is COARSE (measured 1.9 m at 61 m, 7.7 m at
// 100 m), so reading the lattice there moves placement off the surface you see and onto the surface
// the collider walks. That is the ruling's intent -- the collider lattice is the ground -- but it is
// a move, so it is measured per band instead of assumed.
const vegBands = [[0, 32], [32, 64], [64, 96], [96, 128]]
const vegStats = vegBands.map(() => ({ n: 0, all: [] }))
let vegCountMismatch = 0
try {
  const { placementsForChunk, VEG } = await import(href('src/terrain/VegPlacement.js'))
  const vegLattice = latticeFor(frame, VEG)
  const vegKeys = []
  for (let d = 0; d <= 128; d += VEG.CHUNK) for (const a of [0, 90, 180, 270]) {
    const t = (a * Math.PI) / 180
    vegKeys.push(chunkKeyAtLocal(vegLattice, frame, Math.cos(t) * d, Math.sin(t) * d))
  }
  const placeVeg = (latticeOpt) => {
    const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads, ...(latticeOpt ? { lattice: latticeOpt } : {}) })
    surface.setFocus(0, 0)
    surface.sync()
    const prev = frame.renderMeshHeightAtLocal
    frame.renderMeshHeightAtLocal = surface.heightAtLocal
    const ef = createExactPatchFrame(frame)
    const out = []
    for (const key of vegKeys) {
      let list = null
      try { list = placementsForChunk(key, ef.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
      out.push(list || [])
    }
    frame.renderMeshHeightAtLocal = prev
    return out
  }
  const vegBefore = placeVeg(null)
  const vegAfter = placeVeg(baked)
  for (let c = 0; c < vegKeys.length; c++) {
    const a = vegBefore[c], b = vegAfter[c]
    if (a.length !== b.length) vegCountMismatch++
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = Math.hypot(a[i].x, a[i].z)
      const bi = vegBands.findIndex(([lo, hi]) => d >= lo && d < hi)
      if (bi < 0) continue
      vegStats[bi].n++; vegStats[bi].all.push(Math.abs(b[i].y - a[i].y))
    }
  }
  console.log('--- tree placement, BEFORE vs AFTER, by distance from the anchor')
  for (let i = 0; i < vegBands.length; i++) {
    const [lo, hi] = vegBands[i]
    const s = vegStats[i]
    console.log(`  [${String(lo).padStart(3)},${String(hi).padStart(3)})m n=${String(s.n).padStart(5)} mean=${s.all.length ? mean(s.all).toFixed(4) : '-'} p95=${s.all.length ? p95(s.all).toFixed(4) : '-'} max=${s.all.length ? Math.max(...s.all).toFixed(4) : '-'} m`)
  }
  console.log(`  chunks whose tree count changed: ${vegCountMismatch} of ${vegKeys.length}`)
  expect('no veg chunk gained or lost trees', vegCountMismatch, (v) => v === 0)
  expect('tree y moved less than 25 cm in the near band [0,32)m', vegStats[0].all.length ? r6(Math.max(...vegStats[0].all)) : null, (v) => v === null || (finite(v) && v <= 0.25))
} catch (e) {
  console.log(`--- tree placement A/B skipped: ${(e && e.message) || e}`)
}

// ---------------------------------------------------------------- 5. what the extrapolation costs
// The blade's y is the cell's ground plus a second-order Taylor step out to the clump's offset, so it
// disagrees with the surface AT the blade's own (x,z) by the extrapolation's own error. That is the
// residual still open, and it is measured here so it can be closed from a number and not a hunch.
const bladeVsLattice = []
for (const list of after.lists) {
  if (!list) continue
  for (const b of list) {
    if (!baked.covers(b.x, b.z)) continue
    bladeVsLattice.push(Math.abs(b.y - baked.heightAtLocal(b.x, b.z)))
  }
}
console.log(`--- blade y vs the lattice at the blade's own (x,z): n=${bladeVsLattice.length} mean=${mean(bladeVsLattice).toFixed(5)} p95=${p95(bladeVsLattice).toFixed(5)} max=${Math.max(...bladeVsLattice).toFixed(5)} m`)
expect('blades were measured against the lattice', bladeVsLattice.length, (v) => Number.isInteger(v) && v > 100)
expect('blade-vs-lattice max is measured', r6(Math.max(...bladeVsLattice)), (v) => finite(v))

console.log('')
console.log(`SOURCES: collider+placement=apps/world/tps-game.hf N=${baked.N} step=${bakedStep.toFixed(4)}m ; mesh=quadtree L<=${lod.maxLevel} gridSize=${TD.gridMeshSize} ; placement=PlacementChart.surfaceAlongDir`)
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
else console.log('RESULT: PASS')
const { exitAfterQuiesce } = await import(href('scripts/lib/quiesce.mjs'))
await exitAfterQuiesce(failures.length ? 1 : 0, 500)
