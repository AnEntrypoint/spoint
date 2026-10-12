#!/usr/bin/env node
// Does the anchor-seeded mesh solve in client/core/ExactPatchFrame.js agree with the CPU-seeded one
// OUTSIDE the placement rings, and which structural guard closes the gap for free?
//
// `meshElevationAtDir` finds the elevation at a direction by fixed-point iteration against the
// RENDERED mesh: r <- (meshAt(r*de, r*dn) + base)/du. It was seeded with the live CPU sampler
// (frame.cpuElevationAtDir) until c822a7b4, which starts it from frame.anchorHeight instead and
// only asks the CPU sampler where the mesh has no ground. That was proven over the 9,216 elevations
// real grass placement asks for -- all of them inside the placement rings.
//
// Nothing has measured the same path OUTSIDE the rings, where the mesh LOD is coarse. Vegetation
// places to renderDistance + 40 (default 680 m) and rocks to 360 m, so that band is real placement
// ground, not a hypothetical. The shipped mesh surface is built with no focusRadiusM, so it takes
// DEFAULT_FOCUS_RADIUS_M = 240 and reaches 240 * 1.6 = 384 m.
//
// This witness runs the real objects -- a real createPlanetFrame over the real tps-game terrain, a
// real TerrainMeshSurface over a real quadtree -- and over the same directions prices five solvers:
//
//   legacy  verbatim copy of the solver as it shipped before c822a7b4 (CPU seed, eager)
//   anchor  the shipped solver (anchor-height seed, CPU only where the mesh has no ground)
//   zero    the shipped solver started from the chart datum instead (a second, independent seed)
//   conv    anchor, accepted only where the iteration CONVERGED inside MESH_SOLVE_ITERS, otherwise
//           the CPU-seeded solve is paid
//   agree   anchor and zero, accepted only where BOTH converge AND land on the same r, otherwise
//           the CPU-seeded solve is paid
//
// `conv` and `agree` are guards whose safety is a property of the answers, not of a radius, so they
// cannot silently stop holding the way a distance constant would. Every divergence between `anchor`
// and `legacy` is attributed to a mechanism -- which seed hit no-ground, which failed to converge
// inside MESH_SOLVE_ITERS, or two genuinely different fixed points -- because the mechanism is what
// decides which guard can catch it and what it costs.
import { Quadtree } from 'mapspinner/quadtree.js'
import { resolveLodConfig, applyLodConfig } from 'mapspinner/lod-config.js'
import { TERRAIN_DEFAULTS as TD } from 'mapspinner/terrain-defaults.js'
import { worldToFaceLocal } from 'mapspinner/planet-orchestrator-cull.js'
import { createHeightSampler } from 'mapspinner/height-cpu'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createTerrainMeshSurface, isMeshSurfaceNoGround } = await import(href('src/terrain/TerrainMeshSurface.js'))
const { createExactPatchFrame } = await import(href('client/core/ExactPatchFrame.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const vegPlacementMod = await import(href('src/terrain/VegPlacement.js'))
const placementsForVegChunk = vegPlacementMod.placementsForChunk
const VEG = vegPlacementMod.VEG
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const num = (n, d) => (ARGS.has(n) ? Number(ARGS.get(n)) : d)
const flag = (n) => ARGS.has(n)

const WORLD = String(ARGS.get('world') || 'tps-game.js')
const VIEWPORT_H = num('viewport', 1080)
const FOVY_DEG = num('fovy', 70)
// The shipped client constructs the mesh surface with no focusRadiusM, so it takes
// DEFAULT_FOCUS_RADIUS_M = 240 and reaches 240 * 1.6 = 384 m. 480 is what the older witnesses pass
// and reaches 768 m; both arms are run because the wider one serves ground the client does not.
const FOCUS_RADIUS_M = num('focus', 240)
const RING_M = num('ring', 61.6)
const ANGLES = num('angles', 48)
const RADII_PER_BIN = num('radii', 3)
const PASSES = num('passes', 3)
const WITH_GRASS = !flag('nograss')
const WITH_VEG = !flag('noveg')
const MAX_KEYS = num('keys', 12)
// Vegetation places to renderDistance + 40 (default 680 m), so its ring reaches far past the grass
// ring. Its chunks are 32 m, so a full ring is ~1400 chunks: a spread of them is sampled instead,
// ordered by radius so every band is represented.
const VEG_RING_M = num('vegRing', 680)
const VEG_CHUNKS = num('vegChunks', 24)

const MESH_SOLVE_ITERS = 4
const MESH_SOLVE_TOL_M = 1e-6
// A solver that starts somewhere else may only move an elevation by less than this. It is the
// solver's own tolerance: under it, two answers differ in where the iteration stopped, not in the
// surface they describe.
const PARITY_TOL_M = 1e-6

const BINS = [[0, 32], [32, 64], [64, 93], [93, 128], [128, 200], [200, 300], [300, 400], [400, 680]]
const BIN_NAME = BINS.map(([lo, hi]) => `${lo}-${hi}`)
const ARM_NAMES = ['legacy', 'anchor', 'zero', 'conv', 'agree', 'shipped']

const failures = []
function expect(name, got, predicate) {
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)
const r3 = (v) => Math.round(v * 1000) / 1000
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN)
const maxOf = (l) => (l.length ? Math.max(...l) : NaN)

// ---------------------------------------------------------------------------------------------
// The solvers. All five read the same meshAt and the same cpu, so a difference between them is a
// difference in where the iteration starts and what it accepts, never in what it samples.
// ---------------------------------------------------------------------------------------------
function makeSolvers(frame, meshAt, cpu) {
  const radius = frame.radius
  const base = radius + frame.anchorHeight - frame.offsetY
  const E = frame.east, U = frame.up, N = frame.north

  function geom(d) {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
    if (!(len > 0)) return null
    const de = (d[0] * E[0] + d[1] * E[1] + d[2] * E[2]) / len
    const du = (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / len
    const dn = (d[0] * N[0] + d[1] * N[1] + d[2] * N[2]) / len
    if (!(Math.abs(du) > 1e-9)) return null
    return { de, du, dn }
  }

  // One fixed-point solve from an explicit seed. `why` says how it ended, which is what attributes
  // every later divergence to a mechanism.
  function solve(g, r0) {
    let r = r0
    let samples = 0
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const y = meshAt(r * g.de, r * g.dn)
      samples++
      if (isMeshSurfaceNoGround(y)) return { r: NaN, samples, converged: false, why: 'no-ground' }
      const next = (y + base) / g.du
      if (!Number.isFinite(next)) return { r: NaN, samples, converged: false, why: 'non-finite' }
      const step = next - r
      r = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) return { r, samples, converged: true, why: 'converged' }
    }
    return { r, samples, converged: false, why: 'iter-cap' }
  }

  // verbatim pre-c822a7b4: the CPU seed is paid first and seeds the solve, and is the answer
  // wherever the mesh has nothing to give.
  function legacy(d) {
    const h0 = cpu(d)
    if (!Number.isFinite(h0)) return { h: h0, samples: 0, cpu: 1, why: 'cpu-non-finite', converged: false }
    const g = geom(d)
    if (!g) return { h: h0, samples: 0, cpu: 1, why: 'degenerate', converged: false }
    // The pre-c822a7b4 solver answers with its LAST ITERATE, whether or not the iteration reached
    // the tolerance; only a no-ground or non-finite step hands back the CPU elevation.
    const s = solve(g, radius + h0)
    if (Number.isFinite(s.r)) return { h: s.r - radius, samples: s.samples, cpu: 1, why: s.why, converged: s.converged }
    return { h: h0, samples: s.samples, cpu: 1, why: s.why, converged: false }
  }

  // the shipped solver: seed the chart's own anchor height, ask the CPU sampler only where the mesh
  // reports no ground.
  function seeded(seedOf) {
    return (d) => {
      const seed = seedOf()
      const g = geom(d)
      if (!g) return { h: cpu(d), samples: 0, cpu: 1, why: 'degenerate', converged: false }
      const s = solve(g, radius + (Number.isFinite(seed) ? seed : 0))
      if (s.converged) return { h: s.r - radius, samples: s.samples, cpu: 0, why: s.why, converged: true }
      return { h: cpu(d), samples: s.samples, cpu: 1, why: s.why, converged: false }
    }
  }

  // One seed, accepted only where the iteration actually converged. A solve that ran out of budget
  // answers with wherever the iteration happened to stop, which is a function of the seed; refusing
  // it and paying the CPU seed instead is exactly what shipped before c822a7b4. The CPU sampler is
  // asked at most once either way, so the refused path costs the extra mesh samples and nothing else.
  function conv(d) {
    const g = geom(d)
    if (!g) return { h: cpu(d), samples: 0, cpu: 1, why: 'degenerate', converged: false, accepted: false }
    const a = solve(g, radius + (Number.isFinite(frame.anchorHeight) ? frame.anchorHeight : 0))
    if (a.converged) return { h: a.r - radius, samples: a.samples, cpu: 0, why: a.why, converged: true, accepted: true }
    // Refused: pay the CPU seed and run the solve exactly as it shipped before c822a7b4.
    const h0 = cpu(d)
    if (!Number.isFinite(h0)) return { h: h0, samples: a.samples, cpu: 1, why: 'cpu-non-finite', converged: false, accepted: false }
    const s = solve(g, radius + h0)
    if (Number.isFinite(s.r)) return { h: s.r - radius, samples: a.samples + s.samples, cpu: 1, why: a.why, converged: s.converged, accepted: false }
    return { h: h0, samples: a.samples + s.samples, cpu: 1, why: a.why, converged: false, accepted: false }
  }

  // Two seeds, both free and structurally independent (the chart anchor's elevation and the chart
  // datum). Accepted only where the iteration converged from BOTH and both landed on the same r:
  // convergence rules out an answer that is merely where the iteration ran out of budget, and
  // agreement rules out a second fixed point the coarse mesh admits.
  function agree(d) {
    const a = seeded(() => frame.anchorHeight)(d)
    const b = seeded(() => 0)(d)
    if (a.converged && b.converged && a.cpu === 0 && b.cpu === 0 && Math.abs(a.h - b.h) <= PARITY_TOL_M) {
      return { h: a.h, samples: a.samples + b.samples, cpu: 0, why: 'agree', converged: true, accepted: true }
    }
    const l = legacy(d)
    const why = (a.cpu === 0 && b.cpu === 0 && a.converged && b.converged) ? 'disagree' : a.why
    return { h: l.h, samples: a.samples + b.samples + l.samples, cpu: a.cpu + b.cpu + l.cpu, why, converged: l.converged, accepted: false }
  }

  return { legacy, anchor: seeded(() => frame.anchorHeight), zero: seeded(() => 0), conv, agree }
}

// ---------------------------------------------------------------------------------------------
// One site: real sampler, real frame, real quadtree, real mesh surface.
// ---------------------------------------------------------------------------------------------
let tcfg = null
let hashVersion = 0
let worldSeed = 0
function buildSite(anchorDir) {
  const sampler = createHeightSampler({ radius: tcfg.radius, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const ground0 = frame.groundHeightLocal(0, 0)
  const qt = new Quadtree(tcfg.radius)
  const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, FOVY_DEG * Math.PI / 180)
  const splitDist = applyLodConfig(qt, tcfg.radius, VIEWPORT_H, lod)
  const camWorld = frame.localToWorld(0, ground0 + 1.7, 0)
  const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - tcfg.radius
  const leaves = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camWorld, tcfg.radius)
    for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) leaves.push({ face, ...q })
  }
  const offsets = new Float32Array(leaves.length * 4)
  const faces = new Float32Array(leaves.length)
  for (let i = 0; i < leaves.length; i++) {
    const q = leaves[i]
    offsets[i * 4] = q.ox; offsets[i * 4 + 1] = q.oy; offsets[i * 4 + 2] = q.l; offsets[i * 4 + 3] = q.level
    faces[i] = q.face
  }
  const gridSize = TD.gridMeshSize
  const surface = createTerrainMeshSurface({
    frame,
    heightAtDir: (d) => sampler.heightAt(d),
    quads: () => ({ offsets, faces, count: leaves.length, gridSize, radius: tcfg.radius }),
    focusRadiusM: FOCUS_RADIUS_M,
  })
  surface.setFocus(0, 0)
  surface.sync()
  return { sampler, frame, ground0, leaves, gridSize, surface, lod, splitDist, camAlt }
}

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
tcfg = loaded.terrain
hashVersion = terrainHashVersionOf(tcfg)
worldSeed = (tcfg.seed ?? 0) | 0
console.log(`[exact-patch-radius] world=${WORLD} radius=${tcfg.radius} hashVersion=${hashVersion} seed=${worldSeed} focusRadiusM=${FOCUS_RADIUS_M} (reach ${r3(FOCUS_RADIUS_M * 1.6)}m) viewport=${VIEWPORT_H} angles=${ANGLES} radiiPerBin=${RADII_PER_BIN} passes=${PASSES}`)

function rotZ(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] }
const SITES = [['shipped', tcfg.anchorDir || [0, 1, 0]], ['relief', rotZ(45)]]

const EMPTY_BIN = () => ({
  n: 0,
  anchorDiff: [],
  convDiff: [],
  agreeDiff: [],
  shippedDiff: [],
  anchorVsZero: [],
  samples: Object.fromEntries(ARM_NAMES.map((n) => [n, 0])),
  cpu: Object.fromEntries(ARM_NAMES.map((n) => [n, 0])),
  ms: Object.fromEntries(ARM_NAMES.map((n) => [n, Infinity])),
  why: Object.fromEntries(ARM_NAMES.map((n) => [n, {}])),
  accepted: { conv: 0, agree: 0 },
})
const bins = BINS.map(EMPTY_BIN)
const grassBin = EMPTY_BIN()
const callUs = { cpu: [], mesh: [] }
const vegWall = Object.fromEntries(ARM_NAMES.map((n) => [n, null]))
const vegPlacedTotal = Object.fromEntries(ARM_NAMES.map((n) => [n, 0]))
const vegBinsAll = BINS.map(EMPTY_BIN)

for (const [siteName, anchorDir] of SITES) {
  const site = buildSite(anchorDir)
  const { frame, surface, sampler } = site

  const counters = { cpu: 0, mesh: 0, cpuNs: 0n, meshNs: 0n }
  const totals = { cpu: 0, mesh: 0, cpuNs: 0n, meshNs: 0n }
  const rawCpu = frame.cpuElevationAtDir
  frame.cpuElevationAtDir = (d) => {
    counters.cpu++
    const t = process.hrtime.bigint()
    const h = rawCpu(d)
    counters.cpuNs += process.hrtime.bigint() - t
    return h
  }
  const rawMesh = surface.heightAtLocal.bind(surface)
  frame.renderMeshHeightAtLocal = (x, z) => {
    counters.mesh++
    const t = process.hrtime.bigint()
    const h = rawMesh(x, z)
    counters.meshNs += process.hrtime.bigint() - t
    return h
  }

  const exact = createExactPatchFrame(frame)
  const solvers = makeSolvers(frame, frame.renderMeshHeightAtLocal, frame.cpuElevationAtDir)
  // The shipped module itself, measured on the same directions, so the witness prices what
  // client/core/ExactPatchFrame.js actually does rather than only a copy of it.
  const shippedElev = exact.placementFrame.elevationAtDir
  solvers.shipped = (d) => {
    const beforeMesh = counters.mesh, beforeCpu = counters.cpu
    const h = shippedElev(d)
    return { h, samples: counters.mesh - beforeMesh, cpu: counters.cpu - beforeCpu, why: 'shipped', converged: true, accepted: counters.cpu === beforeCpu }
  }
  console.log(`[exact-patch-radius] site ${siteName}: anchorHeight=${r3(frame.anchorHeight)} anchorDir=[${anchorDir.map((v) => v.toFixed(3)).join(',')}] quads=${site.leaves.length} maxLevel=${site.lod.maxLevel} splitDist=${r3(site.splitDist)} surface=${JSON.stringify(surface.stats())}`)

  // ---- the directions: real placement first, then a radius sweep ------------------------------
  // One flat list with per-group index ranges: the solvers are priced and timed per group, but
  // every answer is stored at its own index so a group can never read another group's values.
  const dirs = []
  const groups = []
  const pushGroup = (name, bin, list) => {
    const start = dirs.length
    for (const d of list) dirs.push(d)
    groups.push({ name, bin, start, end: dirs.length })
  }
  if (WITH_GRASS) {
    const grassDirs = []
    const lattice = latticeFor(frame, GRASS)
    const keys = []
    for (let x = -RING_M - GRASS.CHUNK; x <= RING_M + GRASS.CHUNK; x += GRASS.CHUNK) {
      for (let z = -RING_M - GRASS.CHUNK; z <= RING_M + GRASS.CHUNK; z += GRASS.CHUNK) {
        if (Math.hypot(x, z) > RING_M + GRASS.CHUNK) continue
        keys.push(chunkKeyAtLocal(lattice, frame, x, z))
      }
    }
    const useKeys = keys.slice(0, Math.max(1, Math.min(MAX_KEYS, keys.length)))
    const anchorField = createCachedAnchorField(sampler.anchorField, frame)
    const shippedElev = exact.placementFrame.elevationAtDir
    const recorder = (d) => { grassDirs.push([d[0], d[1], d[2]]); return shippedElev(d) }
    exact.placementFrame.elevationAtDir = recorder
    for (const key of useKeys) {
      try { placementsForGrassChunk(key, exact.placementFrame, anchorField, worldSeed) } catch (e) { /* a chunk that throws places nothing and asks nothing */ }
    }
    exact.placementFrame.elevationAtDir = shippedElev
    console.log(`[exact-patch-radius] ${siteName}: real grass placement over ${useKeys.length} chunk(s) asked ${grassDirs.length} elevation(s)`)
    pushGroup('grass', grassBin, grassDirs)
  }
  for (let bi = 0; bi < BINS.length; bi++) {
    const [lo, hi] = BINS[bi]
    const sweep = []
    for (let ri = 0; ri < RADII_PER_BIN; ri++) {
      const rad = lo + ((ri + 0.5) / RADII_PER_BIN) * (hi - lo)
      for (let k = 0; k < ANGLES; k++) {
        const t = (k / ANGLES) * Math.PI * 2 + ri * 0.013
        const d = frame.localToDir(Math.cos(t) * rad, Math.sin(t) * rad)
        sweep.push([d[0], d[1], d[2]])
      }
    }
    pushGroup(BIN_NAME[bi], bins[bi], sweep)
  }

  // ---- the real vegetation workload: what placement actually asks, and where ------------------
  // Every direction vegetation asks for is kept with its own chart-local radius, so the band that
  // carries the risk is measured on the real workload instead of on a synthetic sweep.
  const vegBins = vegBinsAll
  let vegKeys = []
  let vegAnchorField = null
  if (WITH_VEG) {
    const lattice = latticeFor(frame, VEG)
    vegAnchorField = createCachedAnchorField(sampler.anchorField, frame)
    const byRadius = []
    for (let x = -VEG_RING_M; x <= VEG_RING_M; x += VEG.CHUNK) {
      for (let z = -VEG_RING_M; z <= VEG_RING_M; z += VEG.CHUNK) {
        if (Math.hypot(x, z) > VEG_RING_M) continue
        byRadius.push({ r: Math.hypot(x, z), key: chunkKeyAtLocal(lattice, frame, x, z) })
      }
    }
    byRadius.sort((a, b) => a.r - b.r)
    const step = Math.max(1, Math.floor(byRadius.length / VEG_CHUNKS))
    vegKeys = byRadius.filter((_, i) => i % step === 0).slice(0, VEG_CHUNKS).map((e) => e.key)
    const shippedElev = exact.placementFrame.elevationAtDir
    const vegDirs = []
    const recorder = (d) => { vegDirs.push([d[0], d[1], d[2]]); return shippedElev(d) }
    exact.placementFrame.elevationAtDir = recorder
    let vegPlaced = 0
    for (const key of vegKeys) {
      try { const l = placementsForVegChunk(key, exact.placementFrame, vegAnchorField, worldSeed); if (l) vegPlaced += l.length } catch (e) { /* a chunk that throws places nothing and asks nothing */ }
    }
    exact.placementFrame.elevationAtDir = shippedElev
    const E = frame.east, N = frame.north
    const radiusOf = (d) => Math.hypot(frame.radius * (d[0] * E[0] + d[1] * E[1] + d[2] * E[2]), frame.radius * (d[0] * N[0] + d[1] * N[1] + d[2] * N[2]))
    const perBin = BINS.map(() => [])
    for (const d of vegDirs) {
      const r = radiusOf(d)
      const bi = BINS.findIndex(([lo, hi]) => r >= lo && r < hi)
      if (bi < 0) continue
      perBin[bi].push(d)
    }
    for (let bi = 0; bi < BINS.length; bi++) if (perBin[bi].length) pushGroup(`veg:${BIN_NAME[bi]}`, vegBins[bi], perBin[bi])
    console.log(`[exact-patch-radius] ${siteName}: real vegetation placement over ${vegKeys.length} chunk(s) placed ${vegPlaced} tree(s) and asked ${vegDirs.length} elevation(s): ` + perBin.map((l, i) => `${BIN_NAME[i]}=${l.length}`).join(' '))
  }
  const totalDirs = dirs.length
  console.log(`[exact-patch-radius] ${siteName}: ${totalDirs} direction(s) in ${groups.length} group(s)`)

  // ---- price every solver over exactly those directions ---------------------------------------
  // Each group is timed separately so a per-bin microsecond figure is measured, not apportioned.
  // Within a group every arm sees the same directions and the same machine conditions; arms are run
  // in both orders and each keeps its FASTEST pass, so no arm is charged for being measured cold or
  // for where it sits in the list.
  const vals = Object.fromEntries(ARM_NAMES.map((n) => [n, new Float64Array(totalDirs)]))
  const per = Object.fromEntries(ARM_NAMES.map((n) => [n, new Array(totalDirs)]))

  const runGroup = (g, name) => {
    counters.cpu = 0; counters.mesh = 0
    const t0 = process.hrtime.bigint()
    for (let i = g.start; i < g.end; i++) {
      const beforeMesh = counters.mesh, beforeCpu = counters.cpu
      const out = solvers[name](dirs[i])
      vals[name][i] = out.h
      per[name][i] = { samples: counters.mesh - beforeMesh, cpu: counters.cpu - beforeCpu, why: out.why, accepted: !!out.accepted }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    totals.cpu += counters.cpu; totals.mesh += counters.mesh
    totals.cpuNs += counters.cpuNs; totals.meshNs += counters.meshNs
    counters.cpuNs = 0n; counters.meshNs = 0n
    return ms
  }

  const orders = [ARM_NAMES, [...ARM_NAMES].reverse()]
  for (let p = 0; p < PASSES; p++) {
    for (const order of orders) {
      for (const name of order) {
        for (const g of groups) {
          const ms = runGroup(g, name)
          if (ms < g.bin.ms[name]) g.bin.ms[name] = ms
        }
      }
    }
  }
  // one more pass purely to capture the values and per-direction facts the report reads
  for (const name of ARM_NAMES) for (const g of groups) runGroup(g, name)

  // ---- the real placement wall ----------------------------------------------------------------
  // The same chunks placed end to end under each solver, so the answer is milliseconds of
  // placement, not microseconds of solver. Each arm keeps its fastest of two passes.
  if (WITH_VEG && vegKeys.length) {
    const placeAll = (place, name) => {
      const f = Object.create(frame)
      Object.defineProperty(f, 'elevationAtDir', { value: solvers[name], writable: true, configurable: true })
      Object.defineProperty(f, 'groundHeightLocal', { value: exact.placementFrame.groundHeightLocal, writable: true, configurable: true })
      const t0 = process.hrtime.bigint()
      let placed = 0
      for (const k of vegKeys) {
        try { const l = place(f, k); if (l) placed += l.length } catch (e) { /* a chunk that throws places nothing */ }
      }
      return { ms: Number(process.hrtime.bigint() - t0) / 1e6, placed }
    }
    const wall = {}
    for (const n of ARM_NAMES) wall[n] = null
    for (let p = 0; p < 2; p++) {
      for (const n of ARM_NAMES) {
        const m = placeAll((f, k) => placementsForVegChunk(k, f, vegAnchorField, worldSeed), n)
        if (!wall[n] || m.ms < wall[n].ms) wall[n] = m
      }
    }
    console.log(`[exact-patch-radius] ${siteName}: real vegetation placement wall over ${vegKeys.length} chunk(s): ` + ARM_NAMES.map((n) => `${n}=${r3(wall[n].ms)}ms(${wall[n].placed})`).join('  '))
    for (const n of ARM_NAMES) {
      vegWall[n] = vegWall[n] === null ? wall[n].ms : vegWall[n] + wall[n].ms
      vegPlacedTotal[n] += wall[n].placed
    }
  }

  const usPerCall = (ns, n) => (n > 0 ? r3(Number(ns) / 1000 / n) : null)
  callUs.cpu.push(usPerCall(totals.cpuNs, totals.cpu))
  callUs.mesh.push(usPerCall(totals.meshNs, totals.mesh))
  console.log(`[exact-patch-radius] ${siteName}: per call us cpu=${usPerCall(totals.cpuNs, totals.cpu)} mesh=${usPerCall(totals.meshNs, totals.mesh)}`)

  for (const g of groups) {
    const b = g.bin
    b.n += g.end - g.start
    for (let i = g.start; i < g.end; i++) {
      const a = vals.anchor[i], l = vals.legacy[i], c = vals.conv[i], ag = vals.agree[i], z = vals.zero[i], sh = vals.shipped[i]
      if (Number.isFinite(a) && Number.isFinite(l)) b.anchorDiff.push(Math.abs(a - l))
      if (Number.isFinite(c) && Number.isFinite(l)) b.convDiff.push(Math.abs(c - l))
      if (Number.isFinite(ag) && Number.isFinite(l)) b.agreeDiff.push(Math.abs(ag - l))
      if (Number.isFinite(sh) && Number.isFinite(l)) b.shippedDiff.push(Math.abs(sh - l))
      if (Number.isFinite(a) && Number.isFinite(z)) b.anchorVsZero.push(Math.abs(a - z))
      if (Number.isFinite(a) && Number.isFinite(l) && Math.abs(a - l) > PARITY_TOL_M) {
        const key = `anchor:${per.anchor[i].why}/legacy:${per.legacy[i].why}`
        b.why.anchor[key] = (b.why.anchor[key] || 0) + 1
      }
      for (const n of ARM_NAMES) {
        b.samples[n] += per[n][i].samples
        b.cpu[n] += per[n][i].cpu
        const wk = per[n][i].why
        b.why[n][wk] = (b.why[n][wk] || 0) + 1
      }
      if (per.conv[i].accepted) b.accepted.conv++
      if (per.agree[i].accepted) b.accepted.agree++
    }
  }
}

// ---- report -------------------------------------------------------------------------------------
const pctOver = (l) => (l.length ? r3((l.filter((v) => v > PARITY_TOL_M).length / l.length) * 100) : NaN)
const f8 = (v) => (v === v ? v.toFixed(8) : '    -    ')
console.log('')
console.log(`[exact-patch-radius] bin            n   |anchor-legacy|       |conv-legacy|        |agree-legacy|         anchorVsZero     meshServed%`)
console.log(`[exact-patch-radius]                        mean        max      mean        max      mean        max        max         (anchor converged)`)
const row = (name, b) => {
  const servedPct = b.n ? r3(((b.why.anchor.converged || 0) / b.n) * 100) : NaN
  console.log(`[exact-patch-radius] ${name.padEnd(12)} ${String(b.n).padStart(6)}   ${f8(mean(b.anchorDiff))} ${f8(maxOf(b.anchorDiff))}  ${f8(mean(b.convDiff))} ${f8(maxOf(b.convDiff))}  ${f8(mean(b.agreeDiff))} ${f8(maxOf(b.agreeDiff))}  ${f8(maxOf(b.anchorVsZero))}  ${String(servedPct).padStart(8)}`)
}
row('grass(real)', grassBin)
for (let i = 0; i < BINS.length; i++) row(BIN_NAME[i], bins[i])

console.log('')
console.log('[exact-patch-radius] % of directions over the 1e-6 m tolerance, and the guard fallback rate:')
console.log(`[exact-patch-radius] bin            n   anchor%  anchorMax   conv%   convMax   agree%  agreeMax   convFallback%  agreeFallback%`)
const row2 = (name, b) => {
  console.log(`[exact-patch-radius] ${name.padEnd(12)} ${String(b.n).padStart(6)}   ${String(pctOver(b.anchorDiff)).padStart(6)}  ${f8(maxOf(b.anchorDiff))}  ${String(pctOver(b.convDiff)).padStart(6)}  ${f8(maxOf(b.convDiff))}  ${String(pctOver(b.agreeDiff)).padStart(6)}  ${f8(maxOf(b.agreeDiff))}   ${String(b.n ? r3((1 - b.accepted.conv / b.n) * 100) : NaN).padStart(8)}      ${String(b.n ? r3((1 - b.accepted.agree / b.n) * 100) : NaN).padStart(8)}`)
}
row2('grass(real)', grassBin)
for (let i = 0; i < BINS.length; i++) row2(BIN_NAME[i], bins[i])

console.log('')
console.log('[exact-patch-radius] cost per elevation, measured per bin:')
console.log(`[exact-patch-radius] bin            n  ` + ARM_NAMES.map((n) => `${n}(us/samp/cpu)`).join('  '))
const row3 = (name, b) => {
  if (!b.n) return
  const cells = ARM_NAMES.map((n) => `${r3((b.ms[n] / b.n) * 1000)}/${r3(b.samples[n] / b.n)}/${r3(b.cpu[n] / b.n)}`)
  console.log(`[exact-patch-radius] ${name.padEnd(12)} ${String(b.n).padStart(6)}  ` + cells.join('  '))
}
row3('grass(real)', grassBin)
for (let i = 0; i < BINS.length; i++) row3(BIN_NAME[i], bins[i])

console.log('')
console.log('[exact-patch-radius] the same solvers over the directions REAL VEGETATION PLACEMENT asks for:')
console.log(`[exact-patch-radius] bin            n   |anchor-legacy|       |conv-legacy|        |agree-legacy|         anchorVsZero`)
console.log(`[exact-patch-radius]                        mean        max      mean        max      mean        max        max`)
for (let i = 0; i < BINS.length; i++) if (vegBinsAll[i].n) row(BIN_NAME[i], vegBinsAll[i])
console.log(`[exact-patch-radius] bin            n   anchor%  anchorMax   conv%   convMax   agree%  agreeMax   convFallback%  agreeFallback%`)
for (let i = 0; i < BINS.length; i++) if (vegBinsAll[i].n) row2(BIN_NAME[i], vegBinsAll[i])
console.log(`[exact-patch-radius] bin            n  ` + ARM_NAMES.map((n) => `${n}(us/samp/cpu)`).join('  '))
for (let i = 0; i < BINS.length; i++) if (vegBinsAll[i].n) row3(BIN_NAME[i], vegBinsAll[i])

console.log('')
console.log('[exact-patch-radius] the SHIPPED module (client/core/ExactPatchFrame.js as it stands) vs legacy:')
console.log(`[exact-patch-radius] bin            n    max|shipped-legacy|   %over1e-6   cpuSeeds/elevation  us/elevation`)
const rowShipped = (name, b) => {
  if (!b.n) return
  console.log(`[exact-patch-radius] ${name.padEnd(12)} ${String(b.n).padStart(6)}   ${f8(maxOf(b.shippedDiff))}        ${String(pctOver(b.shippedDiff)).padStart(6)}        ${String(r3(b.cpu.shipped / b.n)).padStart(6)}         ${String(r3((b.ms.shipped / b.n) * 1000)).padStart(6)}`)
}
rowShipped('grass(real)', grassBin)
for (let i = 0; i < BINS.length; i++) rowShipped(BIN_NAME[i], bins[i])
console.log('[exact-patch-radius]   real vegetation:')
for (let i = 0; i < BINS.length; i++) if (vegBinsAll[i].n) rowShipped(BIN_NAME[i], vegBinsAll[i])

console.log('')
console.log('[exact-patch-radius] why the anchor-seeded solve ended, per bin:')
for (const [name, b] of [['grass(real)', grassBin], ...BIN_NAME.map((n, i) => [n, bins[i]])]) {
  const keys = Object.entries(b.why.anchor).sort((x, y) => y[1] - x[1])
  if (!keys.length) { console.log(`[exact-patch-radius]   ${name.padEnd(12)} (no directions)`); continue }
  console.log(`[exact-patch-radius]   ${name.padEnd(12)} ${keys.map(([k, v]) => `${k}=${v}`).join('  ')}`)
}
console.log('[exact-patch-radius] divergences anchor vs legacy, by mechanism:')
for (const [name, b] of [['grass(real)', grassBin], ...BIN_NAME.map((n, i) => [n, bins[i]])]) {
  const keys = Object.entries(b.why.anchor).filter(([k]) => k.includes('/')).sort((x, y) => y[1] - x[1])
  console.log(`[exact-patch-radius]   ${name.padEnd(12)} ${keys.length ? keys.map(([k, v]) => `${k}=${v}`).join('  ') : 'none'}`)
}

// totals
const allBins = [grassBin, ...bins]
const all = allBins.reduce((acc, b) => {
  acc.n += b.n
  for (const n of ARM_NAMES) { acc.samples[n] += b.samples[n]; acc.cpu[n] += b.cpu[n]; acc.ms[n] += b.ms[n] }
  acc.anchorDiff.push(...b.anchorDiff); acc.convDiff.push(...b.convDiff); acc.agreeDiff.push(...b.agreeDiff); acc.shippedDiff.push(...b.shippedDiff)
  return acc
}, { n: 0, samples: Object.fromEntries(ARM_NAMES.map((n) => [n, 0])), cpu: Object.fromEntries(ARM_NAMES.map((n) => [n, 0])), ms: Object.fromEntries(ARM_NAMES.map((n) => [n, 0])), anchorDiff: [], convDiff: [], agreeDiff: [], shippedDiff: [] })

const bothConvergedDisagree = allBins.reduce((a, b) => a + (b.why.anchor['anchor:converged/legacy:converged'] || 0), 0)

console.log('')
console.log('[exact-patch-radius] totals ' + JSON.stringify({
  directions: all.n,
  anchorMaxVsLegacy: maxOf(all.anchorDiff),
  anchorOverTol: all.anchorDiff.filter((v) => v > PARITY_TOL_M).length,
  convMaxVsLegacy: maxOf(all.convDiff),
  convOverTol: all.convDiff.filter((v) => v > PARITY_TOL_M).length,
  agreeMaxVsLegacy: maxOf(all.agreeDiff),
  agreeOverTol: all.agreeDiff.filter((v) => v > PARITY_TOL_M).length,
  shippedMaxVsLegacy: maxOf(all.shippedDiff),
  shippedOverTol: all.shippedDiff.filter((v) => v > PARITY_TOL_M).length,
  bothConvergedButDisagreed: bothConvergedDisagree,
  meshSamplesPerElevation: Object.fromEntries(ARM_NAMES.map((n) => [n, r3(all.samples[n] / all.n)])),
  cpuSeedsPerElevation: Object.fromEntries(ARM_NAMES.map((n) => [n, r3(all.cpu[n] / all.n)])),
  usPerElevation: Object.fromEntries(ARM_NAMES.map((n) => [n, r3((all.ms[n] / all.n) * 1000)])),
  savedVsLegacyPct: Object.fromEntries(ARM_NAMES.map((n) => [n, r3(((all.ms.legacy - all.ms[n]) / all.ms.legacy) * 100)])),
  vegetatedBins: vegBinsAll.filter((b) => b.n > 0).length,
  vegPlacementWallMs: Object.fromEntries(ARM_NAMES.map((n) => [n, vegWall[n] === null ? null : r3(vegWall[n])])),
  vegPlacedTotal: Object.fromEntries(ARM_NAMES.map((n) => [n, vegPlacedTotal[n]])),
  perCallUs: { cpu: callUs.cpu, mesh: callUs.mesh },
}, null, 2))

// ---- claims -------------------------------------------------------------------------------------
expect('directionsMeasured', all.n, (v) => Number.isInteger(v) && v > 100)
if (WITH_GRASS) expect('grassDirectionsMeasured', grassBin.n, (v) => Number.isInteger(v) && v > 100)
// inside every placement ring the shipped in-ring behaviour is unchanged by the guards
for (const [nm, b] of [['grass', grassBin], ['0-32', bins[0]], ['32-64', bins[1]], ['64-93', bins[2]], ['93-128', bins[3]]]) {
  expect(`inRing_${nm}_convMaxVsLegacy`, maxOf(b.convDiff), (v) => finite(v) && v <= PARITY_TOL_M)
  expect(`inRing_${nm}_convFallbackPct`, b.n ? r3((1 - b.accepted.conv / b.n) * 100) : NaN, (v) => finite(v) && v === 0)
}
// anywhere at all, a guard may not move an elevation
expect('anywhere_convMaxVsLegacy', maxOf(all.convDiff), (v) => finite(v) && v <= PARITY_TOL_M)
expect('anywhere_agreeMaxVsLegacy', maxOf(all.agreeDiff), (v) => finite(v) && v <= PARITY_TOL_M)
// ...and the unguarded solver really does move some, so the guard is doing work that is needed
expect('anywhere_anchorOverTol', all.anchorDiff.filter((v) => v > PARITY_TOL_M).length, (v) => Number.isInteger(v) && v > 0)
// the shipped module may not move an elevation anywhere at all
expect('anywhere_shippedMaxVsLegacy', maxOf(all.shippedDiff), (v) => finite(v) && v <= PARITY_TOL_M)
// ...and it must not pay the CPU seed inside a placement ring, or the in-ring win is gone
for (const [nm, b] of [['grass', grassBin], ['0-32', bins[0]], ['32-64', bins[1]], ['64-93', bins[2]], ['93-128', bins[3]]]) {
  expect(`inRing_${nm}_shippedCpuSeedsPerElevation`, r3(b.cpu.shipped / Math.max(1, b.n)), (v) => finite(v) && v < 0.01)
}
// the guard answers only where the iteration reached the answer: no direction may exist where both
// the anchor-seeded and the CPU-seeded solve converged and still disagreed
expect('bothConvergedButDisagreed', bothConvergedDisagree, (v) => Number.isInteger(v) && v === 0)

console.log('')
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} claim(s))`)
else console.log('RESULT: PASS')
process.exitCode = failures.length ? 1 : 0
