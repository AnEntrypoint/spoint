#!/usr/bin/env node
// PERF-terrain-far-tessellation-step-1013. What "one step better tessellation at a distance" names
// in this codebase, and the counted work that proves it happened.
//
// ONE STEP = ONE QUADTREE SUBDIVISION LEVEL. Quadtree._recurse splits a node while
// `dist < l * effSplit`, so the leaf side that survives at a given camera distance is
// `l = dist / effSplit` -- the split distance is the ONLY thing setting the tessellation at every
// distance at which the tree is not already pinned at maxLevel. Doubling the split distance halves
// that leaf side, and halving a quadtree leaf's side is exactly one more subdivision level: four
// leaves where there was one, one rung finer on the level ladder. It is not a maxLevel step (that
// is a display-wide ceiling the governor sheds and the altitude deck cap overrides), not a split
// step in the splitFactor knob (that is the same quantity seen through a different name), and not a
// lattice step (the near-field lattice's spacing is the collider's and is not touched here).
//
// The change therefore lives in the one place that maps the density knob onto the split distance:
// mapspinner/lod-config.js LOD_STEP. splitDist is computed as splitFactor * LOD_STEP * (viewport
// term), so doubling LOD_STEP doubles splitDist and nothing else moves -- nearProtectRadius,
// farCoarsenFloor, distFactor, maxLevel and the height sampler are all derived elsewhere and are
// reported here as unchanged because they are what would betray a change that was not distance-only.
//
// The near band is NOT improved and must not move: the leaf the camera stands in is at maxLevel (or
// at the near-field leaf floor) in both arms, so its side, its level and its vertex spacing are
// identical, and the near-field lattice that replaces it still measures 1.0000 m == the collider's
// 1.0000 m -- scripts/nearfield-lod-lattice-witness.mjs pins that at all 8 tiers and is re-run, not
// re-derived, here.
//
// gpu-free and deterministic: the real Quadtree, the real world constants and the real near-field
// lattice, no adapter, no browser.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const __dirname = import.meta.dirname
const ROOT = resolve(__dirname, '..')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)

const WORLD = String(flag('world', 'tps-game'))
const LEVELS = String(flag('levels', '12,13')).split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const VIEW_H = Number(flag('viewport-h', 1080))
const FOVY = Number(flag('fovy', 70)) * Math.PI / 180
// A band is finer by at least one step's worth when its mean leaf side fell to this share or less
// of the pre-change one. The share is 0.72 rather than 0.5 because Quadtree._recurse measures the
// camera distance to a node's NEAR EDGE, so the leaf side that survives at distance x is
// l = x / (1 + effSplit), not x / effSplit: doubling the split distance lands the side at
// (1+eff)/(1+2eff) = 0.667, and dyadic rounding spreads the per-band measurement around that
// (0.40 .. 0.66 measured). A revert reads 1.0 and fails; the lower bar catches a band that
// collapsed. Exactly how many steps the constant took is pinned by LOD_STEP === 2 * STEP_PREVIOUS
// above, not by these ratios -- a second step would only read ~0.39 and is excluded by that pin.
const STEP_BAR_LO = Number(flag('step-bar-lo', 0.35))
const STEP_BAR_HI = Number(flag('step-bar-hi', 0.72))

const { Quadtree, groundPerFaceMetre } = await import('mapspinner/quadtree.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { LOD_STEP, lodDistFactor } = await import('mapspinner/lod-config.js')
const { worldToFaceLocal, pickFace } = await import('mapspinner/planet-orchestrator-cull.js')
const { anchorBasis } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
const { colliderLatticeOf, sourceSpacingOfBake } = await import(pathToFileURL(resolve(ROOT, 'src', 'shared', 'colliderLattice.js')).href)
const { createNearFieldLattice } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'NearFieldLattice.js')).href)
const { expandWorldPresets } = await import(pathToFileURL(resolve(ROOT, 'src', 'shared', 'worldPresets.js')).href)

const worldDef = expandWorldPresets((await import(pathToFileURL(resolve(ROOT, 'apps', 'world', `${WORLD}.js`)).href)).default)
const tcfg = worldDef.terrain
const R = tcfg.radius
const GRID = TD.gridMeshSize
const anchorDir = tcfg.anchorDir || [0, 1, 0]
const spawn = worldDef.spawnPoint || [0, 0, 0]

const basis = anchorBasis(anchorDir)
const camW = [0, 0, 0]
{
  const eye = [spawn[0], Number.isFinite(spawn[1]) ? spawn[1] + 1.7 : 1.7, spawn[2]]
  for (let i = 0; i < 3; i++) camW[i] = basis.east[i] * eye[0] + basis.up[i] * (R + eye[1]) + basis.north[i] * eye[2]
}
const camDist = Math.hypot(camW[0], camW[1], camW[2])
const camAlt = camDist - R

// The near-field lattice the renderer really plans with, at the collider's own spacing.
let bakeSpacingM = null
try {
  const { decodeHeightfield } = await import('mapspinner/heightfield-codec.js')
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(resolve(ROOT, String(tcfg.bakedHeightfield || '').replace(/^\//, '')))
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  const out = decodeHeightfield(ab)
  bakeSpacingM = sourceSpacingOfBake({ N: out && out.N, extent: out && out.extent })
} catch (e) {
  bakeSpacingM = null
}
const cl = colliderLatticeOf(tcfg, { sourceSpacingM: bakeSpacingM })
const nfl = createNearFieldLattice({ spacingM: cl.spacingM, extentM: cl.extentM, gridSteps: GRID })

// One arm per step size. `revert` is the pre-change step: LOD_STEP exactly as it shipped before
// this row, so this file carries the number rather than deriving it from the value under test -- a
// witness that derived both arms from LOD_STEP would report "one step" for any value at all. Both
// arms run the same tree over the same camera, so every difference below is the step and nothing
// else, and the arm that ships has to be exactly one subdivision step (2x) above the one it replaced.
const failures = []
const STEP_PREVIOUS = 3.6
const STEP_SHIPPED = LOD_STEP
const STEP_REVERT = STEP_PREVIOUS
if (STEP_SHIPPED !== STEP_PREVIOUS * 2) failures.push(`LOD_STEP ships ${STEP_SHIPPED}, which is not one subdivision step (2x) above the ${STEP_PREVIOUS} it shipped before this row`)

function arm(step, maxLevel) {
  const qt = new Quadtree(R)
  qt.computeSplitDist(TD.splitFactor * step, VIEW_H, FOVY)
  qt.setConfig(R, maxLevel, lodDistFactor(TD.splitFactor))
  qt.setNearFieldLeafFloor(nfl.maxLeafM, nfl.floorSpanLeaves)
  const all = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camW, R)
    if (!lc || !Number.isFinite(lc[0])) continue
    const gpf = groundPerFaceMetre(lc[0], lc[1], R, nfl.requestedHalfExtentM)
    const leaves = qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)
    for (const q of leaves) {
      const gap = Math.max(
        Math.abs(lc[0] - (q.ox + q.l * 0.5)) - q.l * 0.5,
        Math.abs(lc[1] - (q.oy + q.l * 0.5)) - q.l * 0.5,
        0,
      )
      all.push({ face, ox: q.ox, oy: q.oy, l: q.l, level: q.level, dGround: gap * gpf, sideM: q.l * gpf })
    }
  }
  const atCam = all.reduce((a, q) => (q.dGround < a.dGround ? q : a), all[0])
  return {
    qt, all, atCam,
    splitDist: qt.splitDist,
    nearProtectRadiusM: qt.nearProtectRadius,
    farCoarsenFloor: qt.farCoarsenFloor,
    distFactor: qt.distFactor,
    maxLevel: qt.maxLevel,
    nearLeafFloor: qt.nearLeafFloor,
  }
}

// The near band's extent is the lattice's own covered half-extent, measured in the arm that ships
// nothing new; the distance bands are geometric on top of it, so they name the ground the player
// looks at rather than a number this file picked.
function bandsOn(nearM) {
  const edges = [0, nearM, nearM * 2, nearM * 4, nearM * 8, nearM * 16, Infinity]
  const out = []
  for (let i = 0; i < edges.length - 1; i++) out.push({ fromM: +edges[i].toFixed(1), toM: edges[i + 1] === Infinity ? null : +edges[i + 1].toFixed(1), near: i === 0 })
  return out
}

function bandStats(all, bands) {
  return bands.map((b) => {
    const inb = all.filter((q) => q.dGround >= b.fromM && (b.toM === null || q.dGround < b.toM))
    const side = inb.length ? inb.reduce((s, q) => s + q.sideM, 0) / inb.length : null
    const lvl = inb.length ? inb.reduce((s, q) => s + q.level, 0) / inb.length : null
    return { band: `${b.fromM}-${b.toM === null ? 'inf' : b.toM}m`, near: b.near, n: inb.length, meanSideM: side === null ? null : +side.toFixed(3), meanLevel: lvl === null ? null : +lvl.toFixed(3), meanSpacingM: side === null ? null : +(side / GRID).toFixed(3) }
  })
}

const report = []
for (const L of LEVELS) {
  const rev = arm(STEP_REVERT, L)
  const ship = arm(STEP_SHIPPED, L)
  // the lattice's own covered extent, planned against the pre-change tree
  const nearFace = pickFace(camW)
  {
    const lcN = worldToFaceLocal(nearFace, camW, R)
    const gpf = groundPerFaceMetre(lcN[0], lcN[1], R, nfl.requestedHalfExtentM)
    const leavesNear = rev.all.filter((q) => q.face === nearFace)
    const p = nfl.plan(leavesNear, [lcN[0], lcN[1]], GRID, leavesNear.length, gpf)
    rev.coveredM = p.coveredHalfExtentGroundM
    const leavesShip = ship.all.filter((q) => q.face === nearFace)
    const p2 = nfl.plan(leavesShip, [lcN[0], lcN[1]], GRID, leavesShip.length, gpf)
    ship.coveredM = p2.coveredHalfExtentGroundM
    ship.latticeStepM = p2.stepM
    rev.latticeStepM = p.stepM
  }
  const bands = bandsOn(Math.max(8, rev.coveredM || 0))
  // Only the face the camera stands on. ground distance is measured from that face's own projection
  // of the camera, so the other five faces -- where the camera projects outside the face entirely --
  // contribute leaves with a meaningless distance and would swamp every band with the far side of
  // the planet.
  const nearFaceLeaves = (a) => a.all.filter((q) => q.face === nearFace)
  const rb = bandStats(nearFaceLeaves(rev), bands)
  const sb = bandStats(nearFaceLeaves(ship), bands)
  const rows = bands.map((b, i) => {
    const a = rb[i], c = sb[i]
    return {
      band: `${b.fromM}-${b.toM === null ? 'inf' : b.toM}m`, near: b.near,
      leavesBefore: a.n, leavesAfter: c.n,
      meanSideBeforeM: a.meanSideM, meanSideAfterM: c.meanSideM,
      sideRatio: (a.meanSideM && c.meanSideM) ? +(c.meanSideM / a.meanSideM).toFixed(3) : null,
      levelBefore: a.meanLevel, levelAfter: c.meanLevel,
      spacingBeforeM: a.meanSpacingM, spacingAfterM: c.meanSpacingM,
    }
  })
  const entry = {
    maxLevel: L,
    splitDistBefore: +rev.splitDist.toFixed(4), splitDistAfter: +ship.splitDist.toFixed(4),
    nearProtectRadiusBeforeM: +rev.nearProtectRadiusM.toFixed(1), nearProtectRadiusAfterM: +ship.nearProtectRadiusM.toFixed(1),
    farCoarsenFloorBefore: +rev.farCoarsenFloor.toFixed(3), farCoarsenFloorAfter: +ship.farCoarsenFloor.toFixed(3),
    distFactorBefore: +rev.distFactor.toFixed(4), distFactorAfter: +ship.distFactor.toFixed(4),
    nearLeafFloorBefore: +rev.nearLeafFloor.toFixed(3), nearLeafFloorAfter: +ship.nearLeafFloor.toFixed(3),
    leafAtCameraBeforeM: +rev.atCam.sideM.toFixed(4), leafAtCameraAfterM: +ship.atCam.sideM.toFixed(4),
    leafAtCameraLevelBefore: rev.atCam.level, leafAtCameraLevelAfter: ship.atCam.level,
    nearSpacingBeforeM: +(rev.atCam.sideM / GRID).toFixed(4), nearSpacingAfterM: +(ship.atCam.sideM / GRID).toFixed(4),
    latticeStepBeforeM: rev.latticeStepM, latticeStepAfterM: ship.latticeStepM,
    coveredHalfExtentBeforeM: rev.coveredM, coveredHalfExtentAfterM: ship.coveredM,
    totalLeavesBefore: rev.all.length, totalLeavesAfter: ship.all.length,
    bands: rows,
  }
  report.push(entry)
  console.log(`[far-tess-step] L${L} ` + JSON.stringify(entry))

  // ---- the near band did not move -------------------------------------------------------------
  if (entry.leafAtCameraBeforeM !== entry.leafAtCameraAfterM) failures.push(`L${L}: the leaf the camera stands in went from ${entry.leafAtCameraBeforeM}m to ${entry.leafAtCameraAfterM}m, so the near band moved`)
  if (entry.leafAtCameraLevelBefore !== entry.leafAtCameraLevelAfter) failures.push(`L${L}: the level at the camera went ${entry.leafAtCameraLevelBefore} -> ${entry.leafAtCameraLevelAfter}, so the near band moved`)
  if (entry.latticeStepBeforeM !== entry.latticeStepAfterM) failures.push(`L${L}: the near-field lattice step went ${entry.latticeStepBeforeM} -> ${entry.latticeStepAfterM}, so the near band is no longer the collider's spacing`)
  if (!(entry.coveredHalfExtentAfterM >= entry.coveredHalfExtentBeforeM)) failures.push(`L${L}: the lattice-covered near extent SHRANK ${entry.coveredHalfExtentBeforeM}m -> ${entry.coveredHalfExtentAfterM}m`)
  if (entry.nearProtectRadiusBeforeM !== entry.nearProtectRadiusAfterM) failures.push(`L${L}: nearProtectRadius moved ${entry.nearProtectRadiusBeforeM} -> ${entry.nearProtectRadiusAfterM}, so the change is not confined to the split distance`)
  if (entry.farCoarsenFloorBefore !== entry.farCoarsenFloorAfter) failures.push(`L${L}: farCoarsenFloor moved ${entry.farCoarsenFloorBefore} -> ${entry.farCoarsenFloorAfter}`)
  if (entry.distFactorBefore !== entry.distFactorAfter) failures.push(`L${L}: distFactor moved ${entry.distFactorBefore} -> ${entry.distFactorAfter}`)
  if (entry.nearLeafFloorBefore !== entry.nearLeafFloorAfter) failures.push(`L${L}: the near-field leaf floor moved ${entry.nearLeafFloorBefore} -> ${entry.nearLeafFloorAfter}`)

  // ---- one step at every distance band -------------------------------------------------------
  for (const r of rows) {
    if (r.near) continue
    if (!(r.leavesBefore > 0) || !(r.leavesAfter > 0)) { failures.push(`L${L} band ${r.band}: empty in one arm (${r.leavesBefore} -> ${r.leavesAfter}), so the band proves nothing`); continue }
    if (r.sideRatio === null) { failures.push(`L${L} band ${r.band}: no mean leaf side in one arm`); continue }
    // A band the near-field leaf floor GOVERNS is finer than the split distance's own side, so
    // doubling the split distance cannot halve it and the one-step claim does not apply to it: the
    // floor, not the step, is what sets that ground. What still has to hold there is that the floor
    // did not let the band get COARSER when the step doubled -- and the moment the floor stops
    // governing a band (its side rises past the floor's leaf size) the band is claimed again and has
    // to be a whole step finer, so this branch is not a band the witness stopped looking at.
    const floorLeafM = ship.nearLeafFloor
    const floorGoverned = r.meanSideBeforeM <= floorLeafM && r.meanSideAfterM <= floorLeafM
    if (floorGoverned) {
      r.floorGoverned = true
      if (!(r.meanSideAfterM <= r.meanSideBeforeM)) failures.push(`L${L} band ${r.band}: the floor-governed band COARSENED when the step doubled (${r.meanSideBeforeM}m -> ${r.meanSideAfterM}m against a ${floorLeafM}m floor leaf)`)
      if (!(r.leavesAfter >= r.leavesBefore)) failures.push(`L${L} band ${r.band}: the floor-governed band lost leaves (${r.leavesBefore} -> ${r.leavesAfter})`)
      continue
    }
    if (!(r.sideRatio <= STEP_BAR_HI)) failures.push(`L${L} band ${r.band}: the mean leaf side only fell to ${r.sideRatio} of the pre-change side (bar <= ${STEP_BAR_HI}), so the distance band is not one step finer`)
    if (!(r.sideRatio >= STEP_BAR_LO)) failures.push(`L${L} band ${r.band}: the mean leaf side fell to ${r.sideRatio} of the pre-change side (bar >= ${STEP_BAR_LO}), which is more than one subdivision step`)
    if (!(r.leavesAfter > r.leavesBefore)) failures.push(`L${L} band ${r.band}: the leaf count did not rise (${r.leavesBefore} -> ${r.leavesAfter})`)
  }
}

console.log('[far-tess-step] MEASURED far-tessellation-step: ' + JSON.stringify({
  world: WORLD, viewportH: VIEW_H, fovyDeg: +(FOVY * 180 / Math.PI).toFixed(1),
  lodStepBefore: STEP_REVERT, lodStepAfter: STEP_SHIPPED, splitFactor: TD.splitFactor,
  gridMeshSize: GRID, radiusM: R, camAltM: +camAlt.toFixed(2),
  colliderSpacingM: cl.spacingM, latticeMaxLeafM: nfl.maxLeafM,
  stepBarLo: STEP_BAR_LO, stepBarHi: STEP_BAR_HI,
  levels: report,
}))
console.log('[far-tess-step] near band: the leaf at the camera, its level, the near-field lattice step and the lattice-covered extent are identical in both arms; scripts/nearfield-lod-lattice-witness.mjs pins that lattice at 1.0000 m == the collider lattice at all 8 tiers and is re-run, not re-derived, here')
if (failures.length) {
  console.error('[far-tess-step] RESULT: FAIL -- ' + failures.join('; '))
  process.exit(1)
}
const firstL = report[0]
const dist = firstL.bands.filter((b) => !b.near)
console.log(`[far-tess-step] RESULT: PASS arm=far-tessellation-step world=${WORLD} lodStep ${STEP_REVERT}->${STEP_SHIPPED} splitDist ${firstL.splitDistBefore}->${firstL.splitDistAfter} leaves ${firstL.totalLeavesBefore}->${firstL.totalLeavesAfter} level(s)=${LEVELS.join(',')} distanceBand(s)=${dist.length} sideRatio ${dist.map((b) => b.band + '=' + b.sideRatio).join(' ')} nearLeaf=${firstL.leafAtCameraBeforeM}m==${firstL.leafAtCameraAfterM}m latticeStep=${firstL.latticeStepAfterM}m`)
process.exit(0)
