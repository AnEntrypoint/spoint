#!/usr/bin/env node
// Near-field rendered surface density, run through the REAL mapspinner Quadtree and the REAL world
// constants in node: no GPU, no browser, no synthetic stand-in. It answers one question -- how many
// metres apart are the vertices of the terrain mesh the player stands on, next to the spacing the
// grass places at and the spacing the collider lattice is built on, at every quality tier.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

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

const LABEL = flag('label', 'nearfield-lattice-' + Date.now())
const LEVELS = String(flag('levels', '14,13,12,11,10,9,8,7')).split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const SPLIT_SWEEP = String(flag('split-sweep', '0.25,0.87,1.5,3')).split(',').map((s) => Number(s.trim())).filter(Number.isFinite)
const VIEW_H = Number(flag('viewport-h', 1080))
const FOVY = Number(flag('fovy', 70)) * Math.PI / 180
const WORLD = String(flag('world', 'tps-game'))

const _ms = (p) => (_isNode ? `mapspinner/${p}` : `/node_modules/mapspinner/src/${p}`)
const _isNode = true

const { Quadtree } = await import('mapspinner/quadtree.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { LOD_STEP, lodDistFactor } = await import('mapspinner/lod-config.js')
const { FACE_FRAME, worldToFaceLocal } = await import('mapspinner/planet-orchestrator-cull.js')
const { anchorBasis } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
const { GRASS } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'GrassPlacement.js')).href)

const { expandWorldPresets } = await import(pathToFileURL(resolve(ROOT, 'src', 'shared', 'worldPresets.js')).href)

const worldDef = expandWorldPresets((await import(pathToFileURL(resolve(ROOT, 'apps', 'world', `${WORLD}.js`)).href)).default)
const tcfg = worldDef.terrain
const R = tcfg.radius
const GRID = TD.gridMeshSize
const bootMaxLevel = tcfg.maxLevel
const anchorDir = tcfg.anchorDir || [0, 1, 0]
const spawn = worldDef.spawnPoint || [0, 0, 0]
const tphys = tcfg.physics || {}

// ---- PREDICTION, printed before any value is computed from the live modules. ----
// cube-sphere: root face spans 2R, so a level-L leaf is 2R/2^L face-local metres, split into
// GRID-1 steps. The face map is w = R*tan((u/R)*(pi/4)) per axis then a radial projection, whose
// metric at the world anchor works out to 0.780 m of sphere per face-local metre along u and 0.617
// along v: the near band is anisotropic, and both factors are below 1.
const PREDICT = {
  radius: R, gridMeshSize: GRID, bootMaxLevel, anchorDir, spawn,
  predictedMetric: { dSdu: 0.780, dSdv: 0.617 },
  predictedGrassCellM: GRASS.CHUNK / GRASS.GRID,
  predictedColliderConfiguredM: +(256 / (Math.round(256 / (tphys.resolution || 4)) - 1)).toFixed(4),
}
console.log('[nearfield-lattice] PREDICTION ' + JSON.stringify(PREDICT))

// ---- the collider lattice, read from the bake the server actually builds the field from ----
let collider = { configured: null, baked: null, source: null }
{
  const extent = tphys.extent || 510
  const res = tphys.resolution || 4
  let N = Math.max(2, Math.round(extent / res))
  if (N % 2 !== 0) N += 1
  collider.configured = { extent, resolutionM: res, N, spacingM: +(extent / (N - 1)).toFixed(4) }
}
try {
  const { decodeHeightfield } = await import('mapspinner/heightfield-codec.js')
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(resolve(ROOT, String(tcfg.bakedHeightfield || '').replace(/^\//, '')))
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  const out = decodeHeightfield(ab)
  const N = out && out.N
  const extent = out && (out.extent ?? out.extentM ?? out.spanM)
  if (Number.isFinite(N) && Number.isFinite(extent)) {
    collider.baked = { N, extent, spacingM: +(extent / (N - 1)).toFixed(4), keys: Object.keys(out) }
    collider.source = 'mapspinner/heightfield-codec.js:decodeHeightfield'
  } else {
    collider.source = 'decodeHeightfield returned ' + JSON.stringify(Object.keys(out || {}))
  }
} catch (e) {
  collider.source = 'bake unreadable: ' + (e && e.message)
}
console.log('[nearfield-lattice] collider ' + JSON.stringify(collider))

// ---- the camera, in world space, from the world's own anchor basis and spawn point ----
const basis = anchorBasis(anchorDir)
const camW = [0, 0, 0]
{
  const eye = [spawn[0], Number.isFinite(spawn[1]) ? spawn[1] + 1.7 : R * 0 + 1.7, spawn[2]]
  for (let i = 0; i < 3; i++) camW[i] = basis.east[i] * eye[0] + basis.up[i] * (R + eye[1]) + basis.north[i] * eye[2]
}
const camDist = Math.hypot(camW[0], camW[1], camW[2])
const camAlt = camDist - R

const QUARTER_PI = Math.PI / 4
const K = QUARTER_PI / R
const sec2 = (th) => 1 / (Math.cos(th) * Math.cos(th))
const dSdu = (u, v) => {
  const thu = u * K, thv = v * K
  const tu = Math.tan(thu)
  return QUARTER_PI * sec2(thu) * (1 / Math.cos(thv)) / (tu * tu + sec2(thv))
}
const dSdv = (u, v) => dSdu(v, u)
const spanU = (ox, oy, l) => { let s = 0; const n = 16, h = l / n, v = oy + l * 0.5; for (let i = 0; i < n; i++) s += dSdu(ox + (i + 0.5) * h, v) * h; return s }
const spanV = (ox, oy, l) => { let s = 0; const n = 16, h = l / n, u = ox + l * 0.5; for (let i = 0; i < n; i++) s += dSdv(u, oy + (i + 0.5) * h) * h; return s }

// The same span, measured by a route that never reads dSdu/dSdv: project the face-local (u,v) to a
// real 3D direction through FACE_FRAME and sum chords on the sphere of radius R. The two agreeing
// is what makes the spacing an absolute number in metres rather than a scale the metric chose.
function faceDirAt(face, u, v) {
  const F = FACE_FRAME[face]
  const wu = R * Math.tan((u / R) * QUARTER_PI)
  const wv = R * Math.tan((v / R) * QUARTER_PI)
  const x = F.u[0] * wu + F.v[0] * wv + F.c[0] * R
  const y = F.u[1] * wu + F.v[1] * wv + F.c[1] * R
  const z = F.u[2] * wu + F.v[2] * wv + F.c[2] * R
  const n = Math.hypot(x, y, z) || 1
  return [x / n, y / n, z / n]
}
function spanChord(face, ox, oy, l, alongU) {
  const n = 64, h = l / n
  const uMid = ox + l * 0.5, vMid = oy + l * 0.5
  let s = 0, prev = null
  for (let i = 0; i <= n; i++) {
    const p = alongU ? faceDirAt(face, ox + i * h, vMid) : faceDirAt(face, uMid, oy + i * h)
    if (prev) s += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])
    prev = p
  }
  return s * R
}

function leavesFor(maxLevel, splitFactor) {
  const qt = new Quadtree(R)
  qt.computeSplitDist(splitFactor * LOD_STEP, VIEW_H, FOVY)
  qt.setConfig(R, maxLevel, lodDistFactor(splitFactor))
  const all = []
  let nearest = null, nearestD = Infinity
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camW, R)
    if (!lc || !Number.isFinite(lc[0])) continue
    const leaves = qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)
    for (const q of leaves) {
      all.push({ face, ox: q.ox, oy: q.oy, l: q.l, level: q.level })
      const cu = lc[0], cv = lc[1]
      const d = Math.max(Math.abs(cu - (q.ox + q.l * 0.5)) - q.l * 0.5, Math.abs(cv - (q.oy + q.l * 0.5)) - q.l * 0.5, 0)
      if (d < nearestD) { nearestD = d; nearest = { face, ox: q.ox, oy: q.oy, l: q.l, level: q.level } }
    }
  }
  return { all, nearest, splitDist: qt.splitDist, distFactor: qt.distFactor, nearProtectRadius: qt.nearProtectRadius, farCoarsenFloor: qt.farCoarsenFloor }
}

function spacingOf(leaf) {
  const su = spanU(leaf.ox, leaf.oy, leaf.l) / GRID
  const sv = spanV(leaf.ox, leaf.oy, leaf.l) / GRID
  const cu = spanChord(leaf.face, leaf.ox, leaf.oy, leaf.l, true) / GRID
  const cv = spanChord(leaf.face, leaf.ox, leaf.oy, leaf.l, false) / GRID
  return {
    uM: +su.toFixed(4), vM: +sv.toFixed(4), meanM: +((su + sv) * 0.5).toFixed(4), maxM: +Math.max(su, sv).toFixed(4),
    spanCrossCheckRelErr: +Math.max(Math.abs(su - cu) / su, Math.abs(sv - cv) / sv).toFixed(6),
  }
}

const rows = []
for (const L of LEVELS) {
  const r = leavesFor(L, TD.splitFactor)
  if (!r.nearest) { rows.push({ maxLevel: L, error: 'no leaves' }); continue }
  const sp = spacingOf(r.nearest)
  const deepest = Math.max(...r.all.map((q) => q.level))
  const atDeepest = r.all.filter((q) => q.level === deepest)
  const row = {
    maxLevel: L,
    leafAtCameraM: +r.nearest.l.toFixed(3),
    levelAtCamera: r.nearest.level,
    nearSpacingUm: sp.uM, nearSpacingVm: sp.vM, nearSpacingMeanM: sp.meanM, nearSpacingMaxM: sp.maxM,
    spanCrossCheckRelErr: sp.spanCrossCheckRelErr,
    finestLeafM: +(2 * R / Math.pow(2, deepest)).toFixed(3),
    deepestLevel: deepest,
    leafCount: r.all.length,
    leavesAtDeepest: atDeepest.length,
    splitDist: +r.splitDist.toFixed(4),
    splitDistFloored: r.splitDist <= 1.1,
    nearProtectRadiusM: Math.round(r.nearProtectRadius),
    farCoarsenFloor: +r.farCoarsenFloor.toFixed(3),
  }
  rows.push(row)
  console.log('[nearfield-lattice] L' + L + ' ' + JSON.stringify(row))
}

const sweep = []
for (const sf of SPLIT_SWEEP) {
  const r = leavesFor(bootMaxLevel, sf)
  const sp = r.nearest ? spacingOf(r.nearest) : null
  const deepest = Math.max(...r.all.map((q) => q.level))
  const row = {
    splitFactor: sf,
    splitDist: +r.splitDist.toFixed(4),
    splitDistFloored: r.splitDist <= 1.1,
    nearSpacingMeanM: sp ? sp.meanM : null,
    nearSpacingMaxM: sp ? sp.maxM : null,
    deepestLevel: deepest,
    leafCount: r.all.length,
  }
  sweep.push(row)
  console.log('[nearfield-lattice] split ' + sf + ' ' + JSON.stringify(row))
}

// ---- faceting: the rendered mesh is a piecewise-linear grid over the exact height sampler, so
// |rendered - exact| along a transect is how far the visible ground departs from the real surface,
// in metres, per tier. Runs the real sampler, the real frame and the real TerrainMeshSurface.
const faceting = []
if (!ARGS.has('no-faceting')) {
  const { createHeightSampler } = await import('mapspinner/height-cpu.js')
  const { createPlanetFrame } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'PlanetFrame.js')).href)
  const { createTerrainMeshSurface } = await import(pathToFileURL(resolve(ROOT, 'src', 'terrain', 'TerrainMeshSurface.js')).href)
  const { terrainHashVersionOf, terrainCarvesOf } = await import(pathToFileURL(resolve(ROOT, 'src', 'shared', 'terrainConfig.js')).href)
  const sampler = await createHeightSampler({
    radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale,
    hashVersion: terrainHashVersionOf(tcfg), carves: terrainCarvesOf(tcfg),
  })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const offsets = new Float32Array(4096 * 4)
  const faces = new Float32Array(4096)
  let quadCount = 0
  const surface = createTerrainMeshSurface({
    frame, heightAtDir: (d) => sampler.heightAt(d),
    quads: () => ({ offsets, faces, count: quadCount, gridSize: GRID, radius: R }),
  })
  const transect = (fn, other) => {
    const N = 400, STEP = 0.25, HALF = N * STEP * 0.5
    let n = 0, sum = 0, mx = 0
    for (let i = 0; i < N; i++) {
      const x = spawn[0] - HALF + i * STEP, z = spawn[2]
      const r = fn(x, z)
      if (r === null || r === undefined || !Number.isFinite(r)) continue
      const e = other(x, z)
      if (!Number.isFinite(e)) continue
      const d = Math.abs(r - e)
      sum += d; n++; if (d > mx) mx = d
    }
    return { n, mean: n ? +(sum / n).toFixed(4) : null, max: n ? +mx.toFixed(4) : null }
  }
  const exact = (x, z) => frame.groundHeightLocal(x, z)
  for (const L of LEVELS) {
    const r = leavesFor(L, TD.splitFactor)
    quadCount = 0
    for (const q of r.all) {
      if (quadCount >= 4096) break
      offsets[quadCount * 4] = q.ox; offsets[quadCount * 4 + 1] = q.oy
      offsets[quadCount * 4 + 2] = q.l; offsets[quadCount * 4 + 3] = q.level
      faces[quadCount] = q.face
      quadCount++
    }
    surface.setFocus(spawn[0], spawn[2])
    surface.sync()
    const t = transect(surface.heightAtLocal, exact)
    const row = { maxLevel: L, quads: quadCount, samples: t.n, meanAbsDevM: t.mean, maxAbsDevM: t.max, stats: surface.stats() }
    faceting.push(row)
    console.log('[nearfield-lattice] faceting L' + L + ' ' + JSON.stringify(row))
  }
}

const collM = (collider.baked && collider.baked.spacingM) ? collider.baked.spacingM : collider.configured.spacingM
const grassM = GRASS.CHUNK / GRASS.GRID
const verdict = rows.map((r) => r.error ? { maxLevel: r.maxLevel, error: r.error } : {
  maxLevel: r.maxLevel,
  renderedNearSpacingM: r.nearSpacingMeanM,
  renderedNearSpacingMaxM: r.nearSpacingMaxM,
  grassPlacementSpacingM: grassM,
  colliderSpacingM: collM,
  renderedVsCollider: +(r.nearSpacingMaxM / collM).toFixed(2),
  renderedVsGrass: +(r.nearSpacingMaxM / grassM).toFixed(2),
  nearFieldCoarserThanCollider: r.nearSpacingMaxM > collM,
  nearFieldCoarserThanGrass: r.nearSpacingMaxM > grassM,
  leafCount: r.leafCount,
})
const out = {
  label: LABEL, ts: new Date().toISOString(), world: WORLD,
  radius: R, gridMeshSize: GRID, bootMaxLevel, anchorDir, spawn, viewportH: VIEW_H, fovyDeg: FOVY * 180 / Math.PI,
  cameraWorld: camW, camAltM: +camAlt.toFixed(3),
  grass: { CELL: GRASS.CELL, CHUNK: GRASS.CHUNK, GRID: GRASS.GRID, cellSpacingM: grassM },
  collider, prediction: PREDICT, rows, splitSweep: sweep, faceting, verdict,
}
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, LABEL + '.json'), JSON.stringify(out, null, 1))
console.log('[nearfield-lattice] wrote ' + resolve(OUT_DIR, LABEL + '.json'))
console.log('[nearfield-lattice] RESULT ' + JSON.stringify(verdict))

// ---- the decision ------------------------------------------------------------------------------
// The table above is a measurement, not a verdict. What makes "the near band is 1.2775 m against a
// 1.00 m collider" a fact rather than a printout is that two INDEPENDENT computations agree on it:
// the closed-form cube-sphere metric the spacing is derived from, and a chord sum over real 3D face
// positions that never reads that metric. Level structure is pinned the same way -- a quadtree leaf
// halves per level, so the spacing ladder must halve with it. A gate on the table alone cannot
// fail, so the run decides on those cross-checks and nothing else.
const checks = []
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log(`FAIL: ${name} ${detail}`) }

check('levelsMeasured', rows.length === LEVELS.length && rows.every((r) => !r.error && Number.isFinite(r.nearSpacingMeanM) && r.nearSpacingMeanM > 0 && Number.isFinite(r.nearSpacingMaxM) && r.nearSpacingMaxM > 0 && r.leafCount > 0), `rows=${rows.length} of ${LEVELS.length}, errors=${rows.filter((r) => r.error).length}`)
check('cameraLeafIsTheFinestLeaf', rows.every((r) => !r.error && r.levelAtCamera === r.deepestLevel && Math.abs(r.leafAtCameraM - r.finestLeafM) <= 0.01), JSON.stringify(rows.map((r) => [r.maxLevel, r.levelAtCamera, r.deepestLevel, r.leafAtCameraM, r.finestLeafM])))
const descending = rows.filter((r) => !r.error).sort((a, b) => b.maxLevel - a.maxLevel)
let halvingWorst = 0
for (let i = 1; i < descending.length; i++) {
  const hi = descending[i - 1], lo = descending[i]
  const want = Math.pow(2, hi.maxLevel - lo.maxLevel)
  halvingWorst = Math.max(halvingWorst, Math.abs((lo.nearSpacingMeanM / hi.nearSpacingMeanM) / want - 1))
}
check('spacingHalvesPerLevel', descending.length > 1 && halvingWorst <= 0.01, `worst |ratio / 2^dl - 1| = ${halvingWorst}`)
let chordWorst = 0
for (const r of rows) if (!r.error) chordWorst = Math.max(chordWorst, Number.isFinite(r.spanCrossCheckRelErr) ? r.spanCrossCheckRelErr : 1)
check('spanCrossCheckedAgainstSphereChord', rows.every((r) => r.error || Number.isFinite(r.spanCrossCheckRelErr)) && chordWorst <= 2e-3, `worst relative gap between the metric integral and the sphere chord sum = ${chordWorst}`)
check('colliderSpacingFromDecodedBake', collider.source === 'mapspinner/heightfield-codec.js:decodeHeightfield' && Number.isFinite(collM) && collM > 0, `source=${collider.source} collM=${collM}`)
check('verdictTableComplete', verdict.length === rows.length && verdict.every((v) => !v.error && Number.isFinite(v.renderedVsCollider) && Number.isFinite(v.renderedVsGrass)) && Number.isFinite(grassM) && grassM > 0, `verdict=${verdict.length} rows=${rows.length} grassM=${grassM}`)

const failed = checks.filter((c) => !c.ok)
console.log(`[nearfield-lattice] decision halvingWorst=${halvingWorst} chordWorst=${chordWorst} collM=${collM} grassM=${grassM} levels=${rows.length}`)
console.log(`[nearfield-lattice] checks ${checks.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) console.log(`RESULT: FAIL (${failed.length} of ${checks.length} check(s))`)
else console.log('RESULT: PASS')
process.exitCode = failed.length ? 1 : 0
