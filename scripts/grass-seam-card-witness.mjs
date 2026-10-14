#!/usr/bin/env node
// Witness: how a grass blade CARD sits on the height step the rendered terrain carries at a tile
// seam.
//
// Owner report: "we see a ridge with no grass where terrain tiles meet". Placement is clean
// (grass-tile-seam-witness: population continuous across the tile rim) and submission is clean
// (grass-rim-draw-ring-witness: law-on == drawn in every ring). What is left is the STEP ITSELF and
// how a card sits on it, so this measures exactly that, on the real surface, with the real placer.
//
// The surface a blade is placed on is NOT the exact ground: production builds
// src/terrain/TerrainMeshSurface.js over the drawn quad payload (client/core/TerrainBackdrop.js:129)
// and hands it to placement through client/core/ExactPatchFrame.js, so every blade's y comes from
// the piecewise-linear mesh that is actually drawn. That mesh is continuous INSIDE a quad and
// discontinuous ACROSS a seam, because two abutting quads of different sizes interpolate the same
// height function at different sample offsets along their shared edge (a T-junction).
//
// A grass blade is not a point: GRASS.CLUMP_R (src/terrain/GrassPlacement.js) is the radius the
// clump is offset from its cell and the radius of the footprint its cards cover. Where a seam
// crosses that footprint the surface under one card takes BOTH sides of the step, so the card must
// float over the low side, sink into the high side, or intersect -- even though the blade's own y is
// the mesh height at its own foot.
//
// Measured per blade, for real blades out of placementsForGrassChunk:
//   ownM    |blade.y - meshY(blade.x, blade.z)|     -- the residual at the blade's own foot
//   hiM/loM the rendered surface Y on each side of the step, over the card footprint
//   floatM  blade.y - loM   (how far the card's base hangs over the low side)
//   sinkM   hiM - blade.y   (how far the high side buries the card's base)
//   spanM   hiM - loM       (the step the card has to cover)
//
// The step is measured SLOPE-FREE. A one-sided pair h(P+n*e) - h(P-n*e) is the jump plus the slope
// times 2e, so on a piecewise-linear surface 2*d(e) - d(2e) is the jump alone. The raw pair is also
// printed, because that is the quantity scripts/nearfield-lod-lattice-witness.mjs perimeterJump
// reports and it is not slope-free.
//
// Non-vacuous in both directions: the seam's own discontinuity is scaled by --arms k (0 welds the
// two sides to their mean, 1 is the shipped mesh, 3 triples the step) by adding (k-1) times the
// SEAM'S OWN measured half-jump to the two sides and re-placing the grass from the resulting
// surface. A metric that does not move with k is an instrument gap, not a measurement.
//
// No GPU: every number is CPU main-thread.
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const argv = process.argv.slice(2)
const flag = (n, d) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const num = (n, d) => { const v = Number(flag(n, NaN)); return Number.isFinite(v) ? v : d }

const WORLD = flag('world', 'tps-game')
// The frame's chart is where the baked collider lattice is chart-local TO, so a site the world is
// not anchored at cannot read it: the mirror would answer with another place's ground. The world's
// own anchor is the production case (client/core/TerrainBackdrop.js builds the frame from
// cfg.anchorDir).
const SITE = flag('site', 'world')
const FOOTPRINT_M = num('footprint', 1.15)          // GRASS.CLUMP_R
const SEAM_SAMPLE_M = num('seamStep', 0.5)
const RING_OVERRIDE = num('ring', 0)                // 0 = derived from where the seams are
const VIEW_H = num('viewport-h', 1080)
const FOVY = num('fovy', 70) * Math.PI / 180
const ARMS = flag('arms', '0,1,3').split(',').map(Number).filter(Number.isFinite)

const CANVAS_CTX = () => ({
  fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
  fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  drawImage() {}, createLinearGradient: () => ({ addColorStop() {} }),
})
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: CANVAS_CTX }) }
globalThis.Image = class { set src(v) {} }
await installSpecifierHooks()

const { Quadtree, groundPerFaceMetre } = await import('mapspinner/quadtree.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { LOD_STEP, lodDistFactor } = await import('mapspinner/lod-config.js')
const { FACE_FRAME, worldToFaceLocal, pickFace } = await import('mapspinner/planet-orchestrator-cull.js')

const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createTerrainMeshSurface } = await import(href('src/terrain/TerrainMeshSurface.js'))
const { createExactPatchFrame } = await import(href('client/core/ExactPatchFrame.js'))
const { loadLatticeSurface } = await import(href('src/terrain/LatticeSurface.js'))
const { createNearFieldLattice } = await import(href('src/terrain/NearFieldLattice.js'))
const { colliderLatticeOf, sourceSpacingOfBake } = await import(href('src/shared/colliderLattice.js'))
const { placementsForGrassChunk, classify, blade, GRASS, GRASS_FOOT_READS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt } = await import(href('src/terrain/VegPlacement.js'))
const { latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
const { createBiomeOverride } = await import(href('src/terrain/BiomeOverride.js'))
const { createModelExclusionField } = await import(href('src/terrain/ModelExclusionField.js'))
const { createPlacementRing } = await import(href('client/core/PlacementRing.js'))
const { createHeightSampler } = await import('mapspinner/height-cpu')

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
const p95 = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] }
const f5 = (v) => (Number.isFinite(v) ? v.toFixed(5) : 'n/a')
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')
const pct = (n, d) => (d > 0 ? (100 * n / d).toFixed(2) + '%' : 'n/a')
const mm = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(4) + ' mm' : 'n/a')

const failures = []
const measurements = []
function check(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} = ${JSON.stringify(got)}`)
  return got
}

// ---------------------------------------------------------------- world, frame
const world = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const tcfg = world.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
const sampler = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const anchorDir = SITE === 'world' ? (tcfg.anchorDir || [0, 1, 0]) : (() => { const a = Number(SITE) * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] })()
const USE_LATTICE = flag('lattice', SITE === 'world' ? '1' : '0') !== '0'
const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createModelExclusionField(undefined).wrapClimateField(createBiomeOverride().wrapClimateField(createCachedAnchorField(undefined, frame)))
const sharedLattice = await loadLatticeSurface({ url: tcfg.bakedHeightfield, tcfg, frame })
const GRID = TD.gridMeshSize

const camWorld = frame.localToWorld(0, frame.groundHeightLocal(0, 0) + 1.7, 0)
const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R

// ---------------------------------------------------------------- the drawn quad payload, as shipped
// client/core/TerrainBackdrop.js hands planet.drawnQuads to the mesh mirror. In node the payload is
// rebuilt the way scripts/nearfield-lod-lattice-witness.mjs rebuilds it: the real Quadtree at the
// world's own LOD config, then the near-field lattice tiles that replace its inner leaves.
function leavesFor(maxLevel, splitFactor, floorM, spanLeaves, innerSpanLeaves, onlyFace) {
  const qt = new Quadtree(R)
  qt.computeSplitDist(splitFactor * LOD_STEP, VIEW_H, FOVY)
  qt.setConfig(R, maxLevel, lodDistFactor(splitFactor))
  const all = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camWorld, R)
    if (!lc || !Number.isFinite(lc[0])) continue
    if (Number.isFinite(floorM) && floorM > 0) {
      if (onlyFace === undefined || onlyFace === face) qt.setNearFieldLeafFloor(floorM, Number.isFinite(spanLeaves) ? spanLeaves : 1.0, null, Number.isFinite(innerSpanLeaves) ? innerSpanLeaves : 0.0)
      else qt.setNearFieldLeafFloor(0, 1.0)
    }
    for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) {
      all.push({ face, ox: q.ox, oy: q.oy, l: q.l, level: q.level })
    }
  }
  return all
}

const quadLeaves = leavesFor(tcfg.maxLevel, TD.splitFactor, 0)
let payload = quadLeaves
let nfl = null, plan = null
if (USE_LATTICE && sharedLattice) {
  const bakeSpacingM = sourceSpacingOfBake({ N: sharedLattice.N, extent: sharedLattice.extent })
  const cl = colliderLatticeOf(tcfg, { sourceSpacingM: bakeSpacingM })
  nfl = createNearFieldLattice({ spacingM: cl.spacingM, extentM: cl.extentM, gridSteps: GRID })
  const nearFace = pickFace(camWorld)
  const lcNear = worldToFaceLocal(nearFace, camWorld, R)
  const GPF = groundPerFaceMetre(lcNear[0], lcNear[1], R, nfl.requestedHalfExtentM)
  const reach = nfl.floorReachLeaves(GPF)
  const withFloor = leavesFor(tcfg.maxLevel, TD.splitFactor, nfl.maxLeafM, reach.outerSpanLeaves, reach.innerSpanLeaves, nearFace)
  const leavesNear = withFloor.filter((q) => q.face === nearFace)
  plan = nfl.plan(leavesNear, [lcNear[0], lcNear[1]], GRID, leavesNear.length, GPF)
  const drop = new Set(plan.drop)
  payload = []
  for (const q of withFloor) if (!drop.has(q)) payload.push(q)
  for (const t of plan.tiles) payload.push({ face: nearFace, ox: t.ox, oy: t.oy, l: t.l, level: 0 })
  console.log(`[grass-seam-card] near-field lattice: tiles=${plan.tiles.length} tileM=${f2(plan.tileM)} stepM=${f5(plan.stepM)} coveredHalfExtentGroundM=${f2(plan.coveredHalfExtentGroundM)} leavesCovered=${plan.coveredLeafCount}`)
}

const offsets = new Float32Array(payload.length * 4)
const faces = new Float32Array(payload.length)
for (let i = 0; i < payload.length; i++) {
  const q = payload[i]
  offsets[i * 4] = q.ox; offsets[i * 4 + 1] = q.oy; offsets[i * 4 + 2] = q.l; offsets[i * 4 + 3] = q.level
  faces[i] = q.face
}
const RING_M = RING_OVERRIDE > 0 ? RING_OVERRIDE : 0
const FOCUS_M = Math.max(80, RING_M + 40)
const quads = () => ({ offsets, faces, count: payload.length, gridSize: GRID, radius: R })
const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads, lattice: sharedLattice, focusRadiusM: FOCUS_M, maxQuads: 8192 })
surface.setFocus(0, 0)
surface.sync()
console.log(`[grass-seam-card] world=${WORLD} site=${SITE} maxLevel=${tcfg.maxLevel} quads=${payload.length} (quadtree ${quadLeaves.length}) gridSize=${GRID} nearQuads=${surface.stats().nearQuads} bake=${sharedLattice ? `N=${sharedLattice.N}/${sharedLattice.extent}m` : 'ABSENT'} lattice=${USE_LATTICE ? 'on' : 'off'}`)
const meshH = surface.heightAtLocal.bind(surface)

// ---------------------------------------------------------------- where the seams are
// Two abutting quads of DIFFERENT size share an edge but not its interior sample offsets, so the
// mesh they interpolate disagrees along that edge. Found geometrically: probe just outside every
// quad edge and see which quad answers.
const QUARTER_PI = Math.PI / 4
function nodeChart(face, u, v) {
  const F = FACE_FRAME[face]
  if (!F) return null
  const wu = R * Math.tan((u / R) * QUARTER_PI), wv = R * Math.tan((v / R) * QUARTER_PI)
  let dx = F.u[0] * wu + F.v[0] * wv + F.c[0] * R
  let dy = F.u[1] * wu + F.v[1] * wv + F.c[1] * R
  let dz = F.u[2] * wu + F.v[2] * wv + F.c[2] * R
  const ln = Math.hypot(dx, dy, dz) || 1
  dx /= ln; dy /= ln; dz /= ln
  const e = frame.east, n = frame.north
  return [(dx * e[0] + dy * e[1] + dz * e[2]) * R, (dx * n[0] + dy * n[1] + dz * n[2]) * R]
}
// Ground metres per face-local metre, measured at the camera: face-local units are ~R-scaled, so a
// fixed face-local sample spacing would be nonsense.
const GPF0 = (() => {
  const f = pickFace(camWorld)
  const lc = worldToFaceLocal(f, camWorld, R)
  return groundPerFaceMetre(lc[0], lc[1], R, 64)
})()

const byFace = new Map()
for (const q of payload) {
  let a = byFace.get(q.face)
  if (!a) { a = []; byFace.set(q.face, a) }
  a.push(q)
}
const byFaceKey = new Map()
for (const [f, arr] of byFace) {
  // bucket by size so a probe only tests the quads that could contain it
  byFaceKey.set(f, arr)
}
function leafAtFace(f, u, v) {
  const a = byFaceKey.get(f)
  if (!a) return null
  for (const q of a) if (u >= q.ox && u < q.ox + q.l && v >= q.oy && v < q.oy + q.l) return q
  return null
}

// The jump alone, not the jump plus the slope: on a piecewise-linear surface the one-sided pair is
// jump + (slope+ + slope-)*e, so 2*d(e) - d(2e) leaves the jump.
function jumpScale(x, z, nx, nz, e1, e2) {
  const a1 = meshH(x - nx * e1, z - nz * e1), b1 = meshH(x + nx * e1, z + nz * e1)
  const a2 = meshH(x - nx * e2, z - nz * e2), b2 = meshH(x + nx * e2, z + nz * e2)
  if (![a1, b1, a2, b2].every(Number.isFinite)) return null
  return 2 * (b1 - a1) - (b2 - a2)
}
function jumpOn(h, x, z, nx, nz) {
  const e1 = 0.005, e2 = 0.01
  const a1 = h(x - nx * e1, z - nz * e1), b1 = h(x + nx * e1, z + nz * e1)
  const a2 = h(x - nx * e2, z - nz * e2), b2 = h(x + nx * e2, z + nz * e2)
  if (![a1, b1, a2, b2].every(Number.isFinite)) return null
  return { jump: 2 * (b1 - a1) - (b2 - a2), raw: b1 - a1 }
}
const jumpAt = (x, z, nx, nz) => jumpOn(meshH, x, z, nx, nz)

const EDGES = [
  { du: 1, dv: 0, nu: 0, nv: -1 }, { du: 1, dv: 0, nu: 0, nv: 1 },
  { du: 0, dv: 1, nu: -1, nv: 0 }, { du: 0, dv: 1, nu: 1, nv: 0 },
]
const seamPts = []
const diag = { probes: 0, noNeighbour: 0, sameSize: 0, noJump: 0, kept: 0 }
for (const q of payload) {
  const n = Math.max(2, Math.min(4000, Math.round((q.l * GPF0) / SEAM_SAMPLE_M)))
  for (const e of EDGES) {
    const u0 = e.nu < 0 ? q.ox : (e.nu > 0 ? q.ox + q.l : q.ox)
    const v0 = e.nv < 0 ? q.oy : (e.nv > 0 ? q.oy + q.l : q.oy)
    const eps = q.l * 1e-4
    for (let i = 1; i < n; i++) {
      const t = i / n
      const u = u0 + e.du * q.l * t, v = v0 + e.dv * q.l * t
      diag.probes++
      const other = leafAtFace(q.face, u + e.nu * eps, v + e.nv * eps)
      if (!other || other === q) { diag.noNeighbour++; continue }
      if (Math.abs(other.l - q.l) <= q.l * 1e-6) { diag.sameSize++; continue }
      const P = nodeChart(q.face, u, v)
      const P2 = nodeChart(q.face, u + e.nu * q.l * 1e-3, v + e.nv * q.l * 1e-3)
      if (!P || !P2) { diag.noJump++; continue }
      let nx = P2[0] - P[0], nz = P2[1] - P[1]
      const nl = Math.hypot(nx, nz)
      if (!(nl > 0)) { diag.noJump++; continue }
      nx /= nl; nz /= nl
      if (!Number.isFinite(P[0]) || !Number.isFinite(P[1])) { diag.noJump++; continue }
      const j = jumpAt(P[0], P[1], nx, nz)
      if (!j) { diag.noJump++; continue }
      seamPts.push({ x: P[0], z: P[1], nx, nz, half: Math.abs(j.jump) / 2, plus: j.jump >= 0 ? 1 : -1, raw: Math.abs(j.raw) })
      diag.kept++
    }
  }
}
const jumps = seamPts.map((s) => s.half * 2)
const raws = seamPts.map((s) => s.raw)
const radii = seamPts.map((s) => Math.hypot(s.x, s.z))
console.log(`[grass-seam-card] seam scan: probes=${diag.probes} noNeighbour=${diag.noNeighbour} sameSize=${diag.sameSize} unmeasurable=${diag.noJump} seams=${diag.kept}`)
console.log(`[grass-seam-card] seam step: n=${jumps.length} jump mean=${f5(mean(jumps))} p95=${f5(p95(jumps))} max=${f5(Math.max(...jumps))} m  |  raw pair (slope included, the perimeterJump quantity) mean=${f5(mean(raws))} p95=${f5(p95(raws))} max=${f5(Math.max(...raws))} m`)
const BANDS = [[0, 32], [32, 64], [64, 96], [96, 128], [128, Infinity]]
console.log('--- the seam step by distance from the camera (the mesh is finer near it, coarser past it)')
for (const [lo, hi] of BANDS) {
  const j = seamPts.filter((s) => Math.hypot(s.x, s.z) >= lo && Math.hypot(s.x, s.z) < hi).map((s) => s.half * 2)
  const r = seamPts.filter((s) => Math.hypot(s.x, s.z) >= lo && Math.hypot(s.x, s.z) < hi).map((s) => s.raw)
  if (!j.length) { console.log(`  [${String(lo).padStart(3)},${hi === Infinity ? 'inf' : hi})m  no seam`); continue }
  console.log(`  [${String(lo).padStart(3)},${hi === Infinity ? 'inf' : hi})m  n=${String(j.length).padStart(5)}  jump mean=${f5(mean(j))} p95=${f5(p95(j))} max=${f5(Math.max(...j))} m   raw(slope included) mean=${f5(mean(r))} max=${f5(Math.max(...r))} m`)
}
// The jump estimate rests on the two sides being linear in eps over the probe, and on the probe not
// reaching past a triangle edge into the next one, where the mesh's own kink (cellFlip alternates
// the diagonal of every grid cell) would read as a jump. So the probe is the SHORTEST one that is
// still far above the surface's own numerical noise, and the worst seam is re-estimated at four
// probe sizes: a real discontinuity gives the same number at every size, a kink grows with it.
{
  const worst = seamPts.reduce((a, b) => (b.half > a.half ? b : a), seamPts[0])
  const est = []
  for (const [e1, e2] of [[0.005, 0.01], [0.02, 0.04], [0.05, 0.1], [0.2, 0.4]]) {
    const p = jumpScale(worst.x, worst.z, worst.nx, worst.nz, e1, e2)
    est.push([e1, p === null ? null : Math.round(p * 1e9) / 1e9])
  }
  console.log(`[grass-seam-card] worst seam at (${f2(worst.x)},${f2(worst.z)}) r=${f2(Math.hypot(worst.x, worst.z))}m: jump estimated at probe pairs ${JSON.stringify(est)} m (a kink grows with the probe, a step does not)`)
}
console.log(`[grass-seam-card] seam radius from the camera: min=${f2(Math.min(...radii))} mean=${f2(mean(radii))} max=${f2(Math.max(...radii))} m`)
console.log(`[grass-seam-card] mesh mirror: ${JSON.stringify(surface.stats())}`)
check('the reconstructed drawn mesh really carries a step at its seams', jumps.length, (v) => Number.isInteger(v) && v > 20)
check('the seam jump is measured, not zero', Math.max(...jumps), (v) => Number.isFinite(v) && v > 0)

// ---------------------------------------------------------------- the blades
const RING = RING_OVERRIDE > 0 ? RING_OVERRIDE : Math.min(112, Math.max(...radii) + 16)
const ring = createPlacementRing(frame, GRASS, RING)
const chunkKeys = new Map()
const spanN = Math.ceil(RING / GRASS.CHUNK)
for (let cz = -spanN; cz <= spanN; cz++) {
  for (let cx = -spanN; cx <= spanN; cx++) {
    if (Math.hypot(cx * GRASS.CHUNK, cz * GRASS.CHUNK) > RING) continue
    const key = ring.focusKeyAt(cx * GRASS.CHUNK, cz * GRASS.CHUNK)
    if (!chunkKeys.has(key)) chunkKeys.set(key, true)
  }
}
const keys = [...chunkKeys.keys()]
console.log(`[grass-seam-card] grass ring=${RING}m, ${keys.length} chunk(s) of ${GRASS.CHUNK}m, card footprint r=${FOOTPRINT_M}m (GRASS.CLUMP_R=${GRASS.CLUMP_R})`)

// Spatial index so "is this blade near a seam" is O(1) and not O(seam samples).
const CELL = 4
const grid = new Map()
for (const s of seamPts) {
  const k = Math.floor(s.x / CELL) + ',' + Math.floor(s.z / CELL)
  let a = grid.get(k)
  if (!a) { a = []; grid.set(k, a) }
  a.push(s)
}
function nearestSeam(x, z, bandM) {
  const rad = Math.ceil(bandM / CELL)
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL)
  let best = null, bd = Infinity
  for (let i = -rad; i <= rad; i++) {
    for (let j = -rad; j <= rad; j++) {
      const a = grid.get((cx + i) + ',' + (cz + j))
      if (!a) continue
      for (const s of a) {
        const d = Math.hypot(s.x - x, s.z - z)
        if (d < bd) { bd = d; best = s }
      }
    }
  }
  return bd <= bandM ? { d: bd, s: best } : null
}
// The seam field: the shipped mesh's own half-jump, signed by which side of the seam a point is on.
// arm(k) = meshH + (k-1) * seamField, so k=1 IS the shipped surface, k=0 welds the two sides to
// their mean and k=3 triples the step -- and nothing away from a seam is touched at any k.
function seamField(x, z) {
  const hit = nearestSeam(x, z, FOOTPRINT_M + 1)
  if (!hit) return 0
  const s = hit.s
  const side = (x - s.x) * s.nx + (z - s.z) * s.nz
  return (side >= 0 ? s.plus : -s.plus) * s.half
}
function makeArm(k) {
  return (x, z) => {
    const y = meshH(x, z)
    if (y === null || y === undefined || !Number.isFinite(y)) return y
    return k === 1 ? y : y + (k - 1) * seamField(x, z)
  }
}
function placeArm(k) {
  const arm = makeArm(k)
  const prev = frame.renderMeshHeightAtLocal
  frame.renderMeshHeightAtLocal = arm
  const ef = createExactPatchFrame(frame)
  const t0 = process.hrtime.bigint()
  const blades = []
  for (const key of keys) {
    let list = null
    try { list = placementsForGrassChunk(key, ef.placementFrame, anchorField, worldSeed) } catch (_) { list = null }
    if (list) for (const b of list) blades.push(b)
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  frame.renderMeshHeightAtLocal = prev
  return { arm, blades, ms }
}
// ------------------------------------------------- the blade's own foot: sampled, or extrapolated
// The one number on the owner's report that placement uniformity and draw cleanliness did not clear:
// how far a blade's foot is from the surface it was placed on. A blade is not placed at its cell
// centre -- GRASS.CLUMP_R offsets it -- and the height it needs is the height AT THE OFFSET.
// src/terrain/GrassPlacement.js used to extrapolate the cell ground there by a second-order Taylor
// step and now samples; classify() hands the sampler out as p.riseAt, so putting the extrapolation
// back is one override and not a second copy of the placer.
//
// Both passes run over the SAME classify() output of the SAME cells, so they share the hashes, the
// coins and therefore the population: only the source of a blade's height differs. That is what makes
// a fall in the residual attributable to the sample and not to a different set of blades.
// K_JITX / K_JITZ are GrassPlacement.js's own clump-jitter keys.
const K_JITX = 20, K_JITZ = 21
// 'solve' forces the frame's own fallback instead of copying it: a mesh read that answers nothing
// makes riseAt pay the radial solve along the blade's direction that it paid before this change, so
// the arm IS the previous code path and not a second copy of the placer.
function footPass(arm, mode) {
  const prev = frame.renderMeshHeightAtLocal
  frame.renderMeshHeightAtLocal = arm
  const ef = createExactPatchFrame(frame)
  const pf = ef.placementFrame
  if (mode === 'solve') Object.defineProperty(pf, 'renderMeshHeightAtLocal', { value: () => null, writable: true, configurable: true })
  const cell = createPlacementCell(pf)
  const residual = []
  let cells = 0, blades = 0, lastP = null
  const t0 = process.hrtime.bigint()
  for (const key of keys) {
    const lattice = latticeFor(pf, GRASS)
    const dec = lattice.decodeChunk(key, [0, 0, 0])
    for (let gz = 0; gz < GRASS.GRID; gz++) {
      for (let gx = 0; gx < GRASS.GRID; gx++) {
        placementCellAt(pf, lattice, dec, gx, gz, (worldSeed | 0) ^ 0x6a55, GRASS.JITTER / GRASS.CELL, K_JITX, K_JITZ, cell)
        const p = classify(pf, anchorField, cell)
        if (!p) continue
        cells++
        lastP = p
        if (mode === 'extrapolate') p.riseAt = (offE, offN) => p.dHdx * offE + p.dHdz * offN + 0.5 * (p.kx * offE * offE + p.kz * offN * offN)
        for (let b = 0; b < GRASS.BLADES_PER_CELL; b++) {
          const bl = blade(p, b)
          if (!bl) continue
          blades++
          const y = arm(bl.x, bl.z)
          if (Number.isFinite(y)) residual.push(Math.abs(bl.y - y))
        }
      }
    }
  }
  frame.renderMeshHeightAtLocal = prev
  return { cells, blades, residual, lastP, ms: Number(process.hrtime.bigint() - t0) / 1e6 }
}

// The card footprint: the centre, the two extremes along the seam normal (the two sides of the
// step), and a ring at the footprint radius, so the highest and lowest rendered Y under one card
// are both found.
const RING8 = []
for (let i = 0; i < 8; i++) RING8.push([Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)])
function footprintSpan(arm, x, z, nx, nz) {
  const pts = [[0, 0], [nx * FOOTPRINT_M, nz * FOOTPRINT_M], [-nx * FOOTPRINT_M, -nz * FOOTPRINT_M]]
  for (const [cu, cv] of RING8) pts.push([cu * FOOTPRINT_M, cv * FOOTPRINT_M])
  let hi = -Infinity, lo = Infinity
  for (const [dx, dz] of pts) {
    const y = arm(x + dx, z + dz)
    if (!Number.isFinite(y)) continue
    if (y > hi) hi = y
    if (y < lo) lo = y
  }
  return Number.isFinite(hi) && Number.isFinite(lo) ? { hi, lo } : null
}

// Does placement actually read the drawn mesh, or does the mirror refuse and the exact solve answer
// instead? That is one of the candidate mechanisms ("the card was placed against the coarse side"),
// so it is measured, not assumed.
const cov = [], dev = []
for (let i = 0; i < 4000; i++) {
  const a = i * 2.399963, r = Math.sqrt((i + 0.5) / 4000) * RING
  const x = Math.cos(a) * r, z = Math.sin(a) * r
  const m = meshH(x, z), e = frame.groundHeightLocal(x, z)
  if (!Number.isFinite(e)) continue
  if (Number.isFinite(m)) { cov.push(1); dev.push(Math.abs(m - e)) } else cov.push(0)
}
console.log(`[grass-seam-card] mirror coverage over the grass ring: ${cov.reduce((a, b) => a + b, 0)}/${cov.length} served; |mesh - exact| mean=${f5(mean(dev))} p95=${f5(p95(dev))} max=${f5(Math.max(...dev))} m`)
// If the mirror disagrees with the exact solve by metres the reconstruction is reading another
// place's ground, and every number below would be about that and not about a seam.
check('the mirror really reconstructs this site: |mesh - exact| stays under 0.25 m over the grass ring', Math.round(mean(dev) * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.25)

const arms = []
for (const k of ARMS) {
  const r = placeArm(k)
  const own = [], jumpM = [], floatM = [], sinkM = [], ownExact = []
  let nSeam = 0, nStraddle = 0
  for (const b of r.blades) {
    const hit = nearestSeam(b.x, b.z, FOOTPRINT_M + 1)
    if (!hit) continue
    nSeam++
    // Straddling: the seam line passes through the card's own footprint, so the surface under one
    // card takes both sides of the step.
    if (hit.d > FOOTPRINT_M) continue
    nStraddle++
    const s = hit.s
    const side = (b.x - s.x) * s.nx + (b.z - s.z) * s.nz
    const j = jumpOn(r.arm, s.x, s.z, s.nx, s.nz)
    if (!j) continue
    const J = Math.abs(j.jump)
    jumpM.push(J)
    // The blade is placed at the height of ITS OWN side, so the far side is where the card cannot
    // follow: it hangs over the far side when the far side is the lower one, and is buried by it
    // when the far side is the higher one.
    if (side * j.jump > 0) floatM.push(J); else sinkM.push(J)
    const ownY = r.arm(b.x, b.z)
    if (Number.isFinite(ownY)) own.push(Math.abs(b.y - ownY))
    const exactY = frame.groundHeightLocal(b.x, b.z)
    if (Number.isFinite(exactY)) ownExact.push(Math.abs(b.y - exactY))
  }
  const over = (t) => jumpM.filter((v) => v > t).length
  arms.push({
    k, blades: r.blades.length, ms: r.ms, nSeam, nStraddle,
    own: { mean: mean(own), p95: p95(own), max: Math.max(...own) },
    ownExact: { mean: mean(ownExact), p95: p95(ownExact), max: Math.max(...ownExact) },
    jump: { mean: mean(jumpM), p95: p95(jumpM), max: Math.max(...jumpM) },
    over: { n20mm: over(0.02), n50mm: over(0.05), n100mm: over(0.1) },
    float: { n: floatM.length, mean: mean(floatM), p95: p95(floatM), max: Math.max(...floatM) },
    sink: { n: sinkM.length, mean: mean(sinkM), p95: p95(sinkM), max: Math.max(...sinkM) },
  })
}

console.log('--- blade card vs the rendered surface, per arm (k = the seam step scaled by k)')
for (const a of arms) {
  console.log(`  k=${a.k}  blades=${a.blades}  seam-adjacent=${a.nSeam} (${pct(a.nSeam, a.blades)})  footprint crossed=${a.nStraddle} (${pct(a.nStraddle, a.blades)})  place=${a.ms.toFixed(0)}ms`)
  console.log(`        |blade.y - meshY(own foot)| mean=${f5(a.own.mean)} p95=${f5(a.own.p95)} max=${f5(a.own.max)} m`)
  console.log(`        |blade.y - exact solve|    mean=${f5(a.ownExact.mean)} p95=${f5(a.ownExact.p95)} max=${f5(a.ownExact.max)} m`)
  console.log(`        step the card must cover  mean=${f5(a.jump.mean)} p95=${f5(a.jump.p95)} max=${f5(a.jump.max)} m  (= ${mm(a.jump.mean)} / ${mm(a.jump.p95)} / ${mm(a.jump.max)})`)
  console.log(`        straddling cards over 20/50/100 mm: ${a.over.n20mm} / ${a.over.n50mm} / ${a.over.n100mm}`)
  console.log(`        hangs over the low side   n=${a.float.n} mean=${f5(a.float.mean)} p95=${f5(a.float.p95)} max=${f5(a.float.max)} m`)
  console.log(`        buried by the high side   n=${a.sink.n} mean=${f5(a.sink.mean)} p95=${f5(a.sink.p95)} max=${f5(a.sink.max)} m`)
}

// ------------------------------------------------ the blade's own foot, over every blade in the ring
const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return a.length ? m : NaN }
const stat = (a) => ({ n: a.length, mean: mean(a), p95: p95(a), max: maxOf(a) })
const footEx = footPass(makeArm(1), 'extrapolate')
const footSv = footPass(makeArm(1), 'solve')
const footRd = footPass(makeArm(1), 'read')
const fB = stat(footEx.residual), fS = stat(footSv.residual), fA = stat(footRd.residual)
// Counted work units. A cell pays 5 solves however many blades it places -- one surfaceOfCell plus
// the jet's four probes. A blade's own foot is what changed: nothing while it is extrapolated from
// the cell, one radial solve while it is solved along the blade's own direction, and
// GRASS_FOOT_READS reads of the frame's drawn mesh now that it is read at the blade's own (x,z).
const CELL_SAMPLES = 5
const sB = CELL_SAMPLES * footEx.cells
const sS = CELL_SAMPLES * footSv.cells + footSv.blades
const sA = CELL_SAMPLES * footRd.cells + GRASS_FOOT_READS * footRd.blades
const perBefore = sB / Math.max(1, footEx.blades), perSolve = sS / Math.max(1, footSv.blades), perAfter = sA / Math.max(1, footRd.blades)
const f7 = (v) => (Number.isFinite(v) ? v.toFixed(7) : 'n/a')
// What a solve of this mesh costs against what one read of the same mesh costs, so the price of a
// blade is measured in the same unit in both arms instead of being assumed equal per sample.
let usRead = NaN, usSolve = NaN
{
  const N = 20000
  let acc = 0
  let t = process.hrtime.bigint()
  for (let i = 0; i < N; i++) { const y = meshH((i % 211) * 0.5 - 50, (i % 97) * 0.5 - 25); if (Number.isFinite(y)) acc += y }
  const readMs = Number(process.hrtime.bigint() - t) / 1e6
  t = process.hrtime.bigint()
  for (let i = 0; i < N; i++) { const v = footSv.lastP.riseAt(0.4, -0.6); if (Number.isFinite(v)) acc += v }
  const solveMs = Number(process.hrtime.bigint() - t) / 1e6
  usRead = 1000 * readMs / N
  usSolve = 1000 * solveMs / N
  console.log(`--- micro: ${N} reads of the drawn mesh = ${readMs.toFixed(1)} ms (${usRead.toFixed(2)} us each); ${N} radial solves = ${solveMs.toFixed(1)} ms (${usSolve.toFixed(2)} us each); solve/read = ${(solveMs / Math.max(1e-9, readMs)).toFixed(2)}x (acc=${acc.toFixed(3)})`)
}
console.log('--- blade foot vs the surface it was placed on (every blade in the ring)')
console.log(`  extrapolated (cell ground, 2nd-order Taylor to the clump offset)  n=${fB.n}  mean=${f7(fB.mean)} p95=${f7(fB.p95)} max=${f7(fB.max)} m   place=${footEx.ms.toFixed(0)}ms over ${footEx.cells} cell(s), 0 read(s)/blade`)
console.log(`  solved       (radial solve along the blade's own direction)       n=${fS.n}  mean=${f7(fS.mean)} p95=${f7(fS.p95)} max=${f7(fS.max)} m   place=${footSv.ms.toFixed(0)}ms over ${footSv.cells} cell(s), 1 solve/blade`)
console.log(`  read         (the drawn mesh at the blade's own x,z)              n=${fA.n}  mean=${f7(fA.mean)} p95=${f7(fA.p95)} max=${f7(fA.max)} m   place=${footRd.ms.toFixed(0)}ms over ${footRd.cells} cell(s), ${GRASS_FOOT_READS} read(s)/blade`)
console.log(`  cost: ${sB} -> ${sS} -> ${sA} surface sample(s) over the ring (${f2(perBefore)} -> ${f2(perSolve)} -> ${f2(perAfter)} per blade); placement wall ${footEx.ms.toFixed(0)} -> ${footSv.ms.toFixed(0)} -> ${footRd.ms.toFixed(0)} ms (x${f2(footSv.ms / Math.max(1e-9, footEx.ms))} then x${f2(footRd.ms / Math.max(1e-9, footEx.ms))} against the extrapolated ring)`)
console.log(`[grass-blade-foot] MEASURED grass-blade-foot: blade foot vs the surface it was placed on over ${fA.n} blade(s) -- extrapolated mean ${f7(fB.mean)} p95 ${f7(fB.p95)} max ${f7(fB.max)} m, solved ${f7(fS.mean)} / ${f7(fS.p95)} / ${f7(fS.max)} m, read ${f7(fA.mean)} / ${f7(fA.p95)} / ${f7(fA.max)} m; cost ${sB} -> ${sS} -> ${sA} surface sample(s) (${f2(perBefore)} -> ${f2(perSolve)} -> ${f2(perAfter)} per blade, ${GRASS_FOOT_READS} mesh read(s) a blade against 1 solve at ${usRead.toFixed(2)} us a read and ${usSolve.toFixed(2)} us a solve), placement wall ${footEx.ms.toFixed(0)} -> ${footSv.ms.toFixed(0)} -> ${footRd.ms.toFixed(0)} ms`)

const shipped = arms.find((a) => a.k === 1) || null
const welded = arms.find((a) => a.k === 0) || null
const tripled = arms.find((a) => a.k === 3) || null
const S = shipped || {}
console.log(`[grass-seam-card] MEASURED grass-seam-card: at k=1 the step a straddling card must cover is ${f5(S.jump && S.jump.mean)} m mean / ${f5(S.jump && S.jump.p95)} m p95 / ${f5(S.jump && S.jump.max)} m max, over ${S.nStraddle} of ${S.blades} blade(s) (${pct(S.nStraddle, S.blades)}); ${S.float ? S.float.n : 0} hang over the low side (max ${f5(S.float && S.float.max)} m) and ${S.sink ? S.sink.n : 0} are buried by the high side (max ${f5(S.sink && S.sink.max)} m); each blade's own foot is ${f5(S.own && S.own.mean)} m off the surface it was placed on`)

// ---- the instrument, and the mechanism it separates
check('the grass actually placed', S.blades, (v) => Number.isInteger(v) && v > 1000)
check('some blade cards really straddle a seam', S.nStraddle, (v) => Number.isInteger(v) && v > 20)
check('the blade is placed ON the surface at its own foot, not off it', S.own ? Math.round(S.own.mean * 1e6) / 1e6 : null, (v) => Number.isFinite(v) && v <= 0.01)
if (welded && shipped && tripled) {
  check('NON-VACUOUS DOWN: welding the seam collapses the step a card must cover', [Math.round(welded.jump.max * 1e9) / 1e9, Math.round(shipped.jump.max * 1e9) / 1e9], (v) => Array.isArray(v) && v[0] < v[1] * 0.5)
  check('NON-VACUOUS UP: tripling the step grows what a card must cover', [Math.round(shipped.jump.max * 1e9) / 1e9, Math.round(tripled.jump.max * 1e9) / 1e9], (v) => Array.isArray(v) && v[1] > v[0] * 2)
  check('the step, not the placer, is what the card cannot cover: the own-foot residual is k-independent', [Math.round(welded.own.mean * 1e6) / 1e6, Math.round(shipped.own.mean * 1e6) / 1e6, Math.round(tripled.own.mean * 1e6) / 1e6], (v) => Array.isArray(v) && Math.max(...v) <= 0.01)
  check('the seam does not remove grass: welding it changes the blade count under 1%', Math.round(10000 * Math.abs(welded.blades - shipped.blades) / Math.max(1, shipped.blades)) / 100, (v) => Number.isFinite(v) && v <= 1)
  // The pin. A card is a flat-based billboard: it can only be detach-visible if the step it has to
  // cover is a visible fraction of the card, so the bound is 10 mm at p95 -- far under the 0.06257 m
  // rim step the row was opened on, and under anything the eye can pick out at 40-90 m.
  check('a straddling card never has to cover a visible step: p95 under 10 mm', Math.round(shipped.jump.p95 * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.01)
  check('a straddling card never has to cover a visible step: max under 50 mm', Math.round(shipped.jump.max * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.05)
}

// The pin, and the non-vacuity of the instrument in both directions: the residual has to FALL when
// the blade's own offset is sampled and RISE when the cell-ground extrapolation is put back. A
// residual that never moves is an instrument gap, not a measurement.
check('all three foot passes placed the same population', [footEx.blades, footSv.blades, footRd.blades], (v) => Array.isArray(v) && v[0] === v[1] && v[1] === v[2] && v[0] > 10000)
check('NON-VACUOUS UP: the extrapolation really carried a residual (not an instrument gap)', Math.round(fB.mean * 1e6) / 1e6, (v) => Number.isFinite(v) && v > 0.001)
check('NON-VACUOUS DOWN: solving the blade foot cuts the mean residual at least 5x', [Math.round(fB.mean * 1e6) / 1e6, Math.round(fS.mean * 1e6) / 1e6], (v) => Array.isArray(v) && v[1] * 5 <= v[0])
check('NON-VACUOUS DOWN: solving the blade foot cuts the p95 residual at least 5x', [Math.round(fB.p95 * 1e6) / 1e6, Math.round(fS.p95 * 1e6) / 1e6], (v) => Array.isArray(v) && v[1] * 5 <= v[0])
check('a read blade foot is no further off the surface than a solved one: mean', [Math.round(fS.mean * 1e9) / 1e9, Math.round(fA.mean * 1e9) / 1e9], (v) => Array.isArray(v) && v[1] <= v[0])
check('a read blade foot is no further off the surface than a solved one: p95', [Math.round(fS.p95 * 1e9) / 1e9, Math.round(fA.p95 * 1e9) / 1e9], (v) => Array.isArray(v) && v[1] <= v[0])
check('a read blade foot is no further off the surface than a solved one: max', [Math.round(fS.max * 1e9) / 1e9, Math.round(fA.max * 1e9) / 1e9], (v) => Array.isArray(v) && v[1] <= v[0])
check('a blade foot sits on the surface it was placed on: mean under 1 mm', Math.round(fA.mean * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.001)
check('a blade foot sits on the surface it was placed on: p95 under 5 mm', Math.round(fA.p95 * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.005)
check('a blade foot sits on the surface it was placed on: max under 50 mm', Math.round(fA.max * 1e6) / 1e6, (v) => Number.isFinite(v) && v <= 0.05)
check('a blade\'s foot costs a counted number of surface reads, not a blank cheque', GRASS_FOOT_READS, (v) => Number.isInteger(v) && v >= 1 && v <= 4)
check('a radial solve of the same mesh is not cheaper than one read of it', [Math.round(usRead * 100) / 100, Math.round(usSolve * 100) / 100], (v) => Array.isArray(v) && v[0] > 0 && v[1] >= v[0])
check('NON-VACUOUS DOWN: reading the foot places the ring cheaper than solving it', [Math.round(footSv.ms), Math.round(footRd.ms)], (v) => Array.isArray(v) && v[1] < v[0])

console.log('')
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
else console.log('RESULT: PASS')
process.exit(failures.length ? 1 : 0)
