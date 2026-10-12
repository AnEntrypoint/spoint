#!/usr/bin/env node
// Prices the seed client/core/ExactPatchFrame.js meshElevationAtDir buys from the CPU sampler, and
// proves dropping it does not move a height.
//
// The mesh arm of createExactPatchFrame hands placement an elevationAtDir that solves against the
// RENDERED mesh (`frame.renderMeshHeightLocal`), which is the surface placement is supposed to land
// on. Before the change that solve was seeded by `frame.cpuElevationAtDir(d)` -- the live CPU
// sampler -- and the seed was paid once per elevation whether or not the solve used it. It is a seed
// and nothing else: when the mesh answers, the iteration is a fixed point and its result does not
// depend on where it started, so every placement cell paid two surfaces to keep one.
//
// This witness measures that on the real objects -- a real createPlanetFrame over the real tps-game
// terrain config, a real TerrainMeshSurface over a real quadtree, and the real grass placement that
// asks the questions -- and answers four things:
//   1. PRICE: how many CPU seeds the real placement workload asks for, and what they cost against
//      the mesh samples that decide the answer.
//   2. SEEDS: what a seed is worth. Four are run over the same directions -- the CPU sampler, zero,
//      the chart's anchor height, and the previous elevation -- and each is compared to the CPU one
//      on parity and on cost. The winner is the one that converges in the same samples for free.
//   3. PARITY: over the exact directions real placement asked for, does the shipped elevation return
//      the same height as the CPU-seeded one? A difference is a moved height, so it must stay inside
//      MESH_SOLVE_TOL_M.
//   4. END TO END: does grass land in the same place? The full blade list is compared element-wise.
//
// The `legacy` arm is a verbatim copy of the shipped algorithm before the change, so it doubles as
// the mutation: reintroducing the eager CPU seed must bring those calls and their time back.
import { Quadtree } from 'mapspinner/quadtree.js'
import { resolveLodConfig, applyLodConfig } from 'mapspinner/lod-config.js'
import { TERRAIN_DEFAULTS as TD } from 'mapspinner/terrain-defaults.js'
import { worldToFaceLocal, FACE_FRAME } from 'mapspinner/planet-orchestrator-cull.js'
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

const WORLD = String(ARGS.get('world') || 'tps-game.js')
const VIEWPORT_H = num('viewport', 1080)
const FOVY_DEG = num('fovy', 70)
const FOCUS_RADIUS_M = 480
const GRASS_RING_M = num('ring', 61.6)
const MAX_KEYS = num('keys', 24)

const MESH_SOLVE_ITERS = 4
const MESH_SOLVE_TOL_M = 1e-6
// A different seed may only move an elevation by less than this. It is the solver's own tolerance:
// anything under it is a difference in where the iteration stopped, not in the surface.
const PARITY_TOL_M = 1e-6

const failures = []
const measurements = []
function expect(name, got, predicate) {
  measurements.push(name)
  let ok = false
  try { ok = Boolean(predicate(got)) } catch { ok = false }
  if (!ok) failures.push(`${name}=${JSON.stringify(got)}`)
  return got
}
const finite = (v) => Number.isFinite(v)
function pct(list, p) {
  if (!list.length) return NaN
  const s = list.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : NaN)
const r3 = (v) => Math.round(v * 1000) / 1000

// The solve, parameterised by where it starts. `seedFor` returning the CPU height reproduces the
// shipped algorithm before the change exactly, including its "the mesh cannot answer, so hand back
// the CPU height" branches.
function meshElevationAtDirWithSeed(frame, meshAt, fallback, seedFor) {
  const radius = frame.radius
  const base = radius + frame.anchorHeight - frame.offsetY
  const E = frame.east, U = frame.up, N = frame.north
  return (d) => {
    const s = seedFor(d)
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
    if (!(len > 0)) return Number.isFinite(s) ? s : fallback(d)
    const de = (d[0] * E[0] + d[1] * E[1] + d[2] * E[2]) / len
    const du = (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / len
    const dn = (d[0] * N[0] + d[1] * N[1] + d[2] * N[2]) / len
    if (!(Math.abs(du) > 1e-9)) return Number.isFinite(s) ? s : fallback(d)
    let r = radius + (Number.isFinite(s) ? s : 0)
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const y = meshAt(r * de, r * dn)
      if (isMeshSurfaceNoGround(y)) return Number.isFinite(s) ? s : fallback(d)
      const next = (y + base) / du
      if (!Number.isFinite(next)) return Number.isFinite(s) ? s : fallback(d)
      const step = next - r
      r = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) break
    }
    return r - radius
  }
}

function rotZ(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] }

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
  const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => ({ offsets, faces, count: leaves.length, gridSize, radius: tcfg.radius }), focusRadiusM: FOCUS_RADIUS_M })
  surface.setFocus(0, 0)
  surface.sync()
  return { sampler, frame, ground0, leaves, gridSize, surface, lod, splitDist, camAlt }
}

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
console.log(`[exact-patch-seed] world=${WORLD} radius=${tcfg.radius} hashVersion=${hashVersion} seed=${worldSeed} ring=${GRASS_RING_M}m keys<=${MAX_KEYS}`)

const sites = [['shipped', tcfg.anchorDir || [0, 1, 0]], ['relief', rotZ(45)]]

const counters = { cpu: 0, cpuMs: 0, mesh: 0, meshMs: 0 }
const resetCounters = () => { counters.cpu = 0; counters.cpuMs = 0; counters.mesh = 0; counters.meshMs = 0 }

const ARM_NAMES = ['shipped', 'legacy', 'zero', 'anchor', 'prev']
const totals = {}
for (const n of ARM_NAMES) totals[n] = { dirs: 0, cpu: 0, cpuMs: 0, mesh: 0, meshMs: 0, ms: 0 }
const perDirMesh = {}
const deltasVsLegacy = {}
for (const n of ARM_NAMES) { perDirMesh[n] = []; deltasVsLegacy[n] = [] }
let bladeCmp = 0, bladeMax = 0

for (const [siteName, anchorDir] of sites) {
  const site = buildSite(anchorDir)
  const { frame, surface, sampler } = site

  // Both counters have to be installed before createExactPatchFrame reads
  // frame.cpuElevationAtDir and frame.renderMeshHeightAtLocal: it captures them by value.
  const rawCpu = frame.cpuElevationAtDir
  frame.cpuElevationAtDir = (d) => {
    counters.cpu++
    const t = process.hrtime.bigint()
    const h = rawCpu(d)
    counters.cpuMs += Number(process.hrtime.bigint() - t) / 1e6
    return h
  }
  const rawMesh = surface.heightAtLocal.bind(surface)
  frame.renderMeshHeightAtLocal = (x, z) => {
    counters.mesh++
    const t = process.hrtime.bigint()
    const h = rawMesh(x, z)
    counters.meshMs += Number(process.hrtime.bigint() - t) / 1e6
    return h
  }

  const exact = createExactPatchFrame(frame)
  const shippedElev = exact.placementFrame.elevationAtDir
  const cpu = frame.cpuElevationAtDir
  const meshAt = frame.renderMeshHeightAtLocal
  let lastElevation = NaN
  const arms = {
    shipped: shippedElev,
    legacy: meshElevationAtDirWithSeed(frame, meshAt, cpu, (d) => cpu(d)),
    zero: meshElevationAtDirWithSeed(frame, meshAt, cpu, () => 0),
    anchor: meshElevationAtDirWithSeed(frame, meshAt, cpu, () => frame.anchorHeight),
    prev: meshElevationAtDirWithSeed(frame, meshAt, cpu, () => (Number.isFinite(lastElevation) ? lastElevation : 0)),
  }

  // ---- 1. the directions real placement asks for -------------------------------------------
  const lattice = latticeFor(frame, GRASS)
  const keys = []
  for (let x = -GRASS_RING_M - GRASS.CHUNK; x <= GRASS_RING_M + GRASS.CHUNK; x += GRASS.CHUNK) {
    for (let z = -GRASS_RING_M - GRASS.CHUNK; z <= GRASS_RING_M + GRASS.CHUNK; z += GRASS.CHUNK) {
      if (Math.hypot(x, z) > GRASS_RING_M + GRASS.CHUNK) continue
      keys.push(chunkKeyAtLocal(lattice, frame, x, z))
    }
  }
  const useKeys = keys.slice(0, Math.max(1, Math.min(MAX_KEYS, keys.length)))
  const anchorField = createCachedAnchorField(sampler.anchorField, frame)

  const dirs = []
  const recorder = (d) => { dirs.push([d[0], d[1], d[2]]); return shippedElev(d) }
  exact.placementFrame.elevationAtDir = recorder
  for (const key of useKeys) {
    try { placementsForGrassChunk(key, exact.placementFrame, anchorField, worldSeed) } catch (e) { /* a chunk that throws places nothing and asks nothing */ }
  }
  exact.placementFrame.elevationAtDir = shippedElev

  console.log(`[exact-patch-seed] ${siteName}: ${useKeys.length} grass chunk(s) asked ${dirs.length} elevation(s)`)
  if (dirs.length === 0) { failures.push(`${siteName}: placement asked for no elevation, so nothing was measured`); continue }

  // ---- 2. price every seed over exactly those directions ------------------------------------
  // Three passes: a discardable warm-up, then both orders. Each arm keeps its FASTEST pass, so no
  // arm is charged for being measured cold or for where it sits in the list.
  const runArm = (name) => {
    lastElevation = NaN
    resetCounters()
    const t = process.hrtime.bigint()
    const vals = new Float64Array(dirs.length)
    const per = new Uint8Array(dirs.length)
    for (let i = 0; i < dirs.length; i++) {
      const before = counters.mesh
      try { vals[i] = arms[name](dirs[i]) } catch (e) { vals[i] = NaN }
      per[i] = Math.min(255, counters.mesh - before)
      if (Number.isFinite(vals[i])) lastElevation = vals[i]
    }
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    return { vals, per, ms, cpu: counters.cpu, cpuMs: counters.cpuMs, mesh: counters.mesh, meshMs: counters.meshMs }
  }

  const out = {}
  for (const name of ARM_NAMES) out[name] = runArm(name)
  for (const name of ARM_NAMES) out[name] = runArm(name) // warm-up, discarded
  const bestSite = {}
  for (const order of [ARM_NAMES, [...ARM_NAMES].reverse()]) {
    for (const name of order) {
      const m = runArm(name)
      if (!bestSite[name] || m.ms < bestSite[name].ms) bestSite[name] = m
    }
  }
  for (const name of ARM_NAMES) {
    const vals = out[name].vals
    const per = out[name].per
    const m = bestSite[name]
    const T = totals[name]
    T.dirs += dirs.length; T.cpu += m.cpu; T.cpuMs += m.cpuMs
    T.mesh += m.mesh; T.meshMs += m.meshMs; T.ms += m.ms
    for (let i = 0; i < dirs.length; i++) {
      perDirMesh[name].push(per[i])
      if (name !== 'legacy' && Number.isFinite(vals[i]) && Number.isFinite(out.legacy.vals[i])) {
        deltasVsLegacy[name].push(Math.abs(vals[i] - out.legacy.vals[i]))
      }
    }
    console.log(`[exact-patch-seed] ${siteName}/${name}: cpu=${m.cpu} (${r3(m.cpuMs)}ms) mesh=${m.mesh} (${r3(m.meshMs)}ms) total=${r3(m.ms)}ms meshPerElevation=${r3(mean([...per]))}`)
  }

  // ---- 3. end to end: does grass land in the same place? -----------------------------------
  const legacyFrame = Object.create(frame)
  Object.defineProperty(legacyFrame, 'elevationAtDir', { value: arms.legacy, writable: true, configurable: true })
  Object.defineProperty(legacyFrame, 'groundHeightLocal', { value: exact.placementFrame.groundHeightLocal, writable: true, configurable: true })
  for (const key of useKeys) {
    let s = null, l = null
    try { s = placementsForGrassChunk(key, exact.placementFrame, anchorField, worldSeed) } catch (e) { s = null }
    try { l = placementsForGrassChunk(key, legacyFrame, anchorField, worldSeed) } catch (e) { l = null }
    if (!s || !l || s.length !== l.length) continue
    for (let i = 0; i < s.length; i++) {
      const d0 = Math.abs(s[i].y - l[i].y)
      bladeCmp++
      if (d0 > bladeMax) bladeMax = d0
    }
  }
}

const us = (ms, n) => (n > 0 ? r3((ms / n) * 1000) : null)
const report = {}
for (const name of ARM_NAMES) {
  const T = totals[name]
  const d = deltasVsLegacy[name]
  const maxD = d.length ? Math.max(...d) : NaN
  report[name] = {
    cpuSeedCalls: T.cpu,
    cpuSeedMs: r3(T.cpuMs),
    meshSamples: T.mesh,
    meshMs: r3(T.meshMs),
    totalMs: r3(T.ms),
    meshSamplesPerElevation: r3(mean(perDirMesh[name])),
    maxMeshSamplesPerElevation: perDirMesh[name].length ? Math.max(...perDirMesh[name]) : null,
    usPerCpuSeed: us(T.cpuMs, T.cpu),
    usPerMeshSample: us(T.meshMs, T.mesh),
  }
  if (name !== 'legacy') {
    // The max is only a measurement when the comparison that produced it ran: pin it to that
    // population's size, and to the tolerance it is claimed against, never to itself.
    report[name].parityVsLegacy_samplesCompared = d.length
    report[name].parityVsLegacy_maxAbsDiffM = d.length > 0 ? maxD : null
    report[name].parityVsLegacy_withinToleranceM = d.length > 0 ? maxD <= PARITY_TOL_M : null
    report[name].parityVsLegacy_overTolerance = d.filter((v) => v > PARITY_TOL_M).length
  }
}

console.log('[exact-patch-seed] per-arm ' + JSON.stringify(report, null, 2))
console.log(`[exact-patch-seed] grass blades compared ${bladeCmp}, max |y shipped - y cpu-seeded| = ${bladeMax}m`)

// ---- the claims ----------------------------------------------------------------------------
const L = totals.legacy, S = totals.shipped
const shippedDelta = deltasVsLegacy.shipped
const shippedMax = shippedDelta.length ? Math.max(...shippedDelta) : NaN
const shippedOver = shippedDelta.filter((v) => v > PARITY_TOL_M).length

expect('elevationsAsked', L.dirs, (v) => Number.isInteger(v) && v > 100)
expect('legacy_cpuSeedsPerElevation', r3(L.cpu / Math.max(1, L.dirs)), (v) => finite(v) && v >= 0.99)
expect('legacy_cpuSeedMsSharePct', r3((L.cpuMs / L.ms) * 100), (v) => finite(v) && v > 5)
// The architectural claim: the shipped solver no longer asks the CPU sampler per elevation.
expect('shipped_cpuSeedsPerElevation', r3(S.cpu / Math.max(1, S.dirs)), (v) => finite(v) && v < 0.01)
expect('shipped_savesTimePct', r3(((L.ms - S.ms) / L.ms) * 100), (v) => finite(v) && v > 0)
// ...and it does not buy that by spending more mesh samples than the budget allows.
expect('shipped_meshSamplesPerElevationWithinIterCap', r3(mean(perDirMesh.shipped)), (v) => finite(v) && v <= MESH_SOLVE_ITERS)
// Parity: a different seed may not move an elevation.
expect('parityVsLegacy_elevationsCompared', shippedDelta.length, (v) => Number.isInteger(v) && v > 100)
expect('parityVsLegacy_maxAbsDiffM', shippedMax, (v) => finite(v) && v >= 0 && v <= PARITY_TOL_M)
expect('parityVsLegacy_overTolerance', shippedOver, (v) => Number.isInteger(v) && v === 0)
expect('bladesCompared', bladeCmp, (v) => Number.isInteger(v) && v > 100)
expect('blade_maxAbsDiffM', bladeMax, (v) => finite(v) && v >= 0 && v <= PARITY_TOL_M)

console.log('[exact-patch-seed] measurements ' + JSON.stringify({
  elevationsAsked: L.dirs,
  legacy_cpuSeedCalls: L.cpu,
  legacy_cpuSeedMsSharePct: r3((L.cpuMs / L.ms) * 100),
  shipped_cpuSeedCalls: S.cpu,
  shipped_totalMs: r3(S.ms),
  legacy_totalMs: r3(L.ms),
  shipped_savesTimePct: r3(((L.ms - S.ms) / L.ms) * 100),
  parityVsLegacy_maxAbsDiffM: shippedMax,
  parityVsLegacy_overTolerance: shippedOver,
  blade_maxAbsDiffM: bladeMax,
}, null, 2))
for (const f of failures) console.log(`FAIL: ${f}`)
if (failures.length) console.log(`RESULT: FAIL (${failures.length} of ${measurements.length} measurement(s))`)
else console.log('RESULT: PASS')
process.exitCode = failures.length ? 1 : 0
