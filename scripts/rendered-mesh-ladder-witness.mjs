#!/usr/bin/env node
// RENDERED MESH vs EXACT FIELD, along the player-hover ladder.
//
// scripts/player-ground-hover-witness.mjs measures, in a booted server, the player's Y, the
// collider's Y, the exact CPU solve and the grass ground. It cannot see the RENDERED MESH, because
// the frame's rendered-mesh surface is installed by client/core/TerrainBackdrop.js inside the page.
// The mesh is nevertheless a CPU object: packages/mapspinner builds the quadtree LOD and
// src/terrain/TerrainMeshSurface.js queries it. This witness builds that same object in node, for a
// camera standing AT each rung, and reports the four grounds at the same (x,z):
//
//   meshY   surface.heightAtLocal(x,z) -- the triangulated grid the planet actually submits.
//   cpuY    frame.groundHeightLocal(x,z) -- the exact solve; the collider matched it to 0.014 m.
//   grassY  the nearest real blade out of placementsForGrassChunk for the chunk at (x,z).
//
// The distance ladder settles the direction of the fix: a meshY-cpuY that GROWS with distance is a
// coarse far field under one of the two surfaces, so the player standing on the exact solve can be
// left above or below the ground the owner can see. A divergence that is constant, or that stays
// inside the mesh's own vertex spacing, is not a hover of any size.
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
const { createTerrainMeshSurface } = await import(href('src/terrain/TerrainMeshSurface.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const WORLD = arg('world', 'tps-game.js')
const VIEWPORT_H = Number(process.env.RML_VIEWPORT_H || 1080)
const FOVY_DEG = Number(process.env.RML_FOVY || 70)
const FOCUS_RADIUS_M = 480
const DISTANCES_M = String(arg('distances', '0,50,100,200,400')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
// The player stands on the collider, and player-ground-hover-witness measured the collider against
// the exact solve at 0.0144 m worst over this ladder. A mesh divergence larger than that plus the
// mesh's own vertex spacing is a divergence the player can be left standing on.
const ACCEPT_MESH_CPU_M = Number(arg('accept-mesh-cpu-m', 0.15))
const EYE_M = Number(arg('eye-m', 1.7))
// Same bearing as the player ladder, so the two witnesses walk the same ground.
const BEARING = Math.atan2(320, 640)

const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: ok === true, detail })
  console.log(`${ok === true ? '  [PASS] ' : '  [FAIL] '}${name}: ${detail}`)
}

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
console.log(`rendered-mesh-ladder: world=${WORLD} radius=${R} reliefScale=${tcfg.reliefScale} seed=${worldSeed} hashVersion=${hashVersion} gridMeshSize=${TD.gridMeshSize}`)

const sampler = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const anchorField = createCachedAnchorField(sampler.anchorField, frame)
const lattice = latticeFor(frame, GRASS)
const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, FOVY_DEG * Math.PI / 180)

// One mesh surface per rung: the quadtree is split around where the camera IS, so a surface built
// for the origin is not the surface a player standing at 400 m is looking at.
function meshAt(x, z) {
  const ground0 = frame.groundHeightLocal(x, z)
  const qt = new Quadtree(R)
  const splitDist = applyLodConfig(qt, R, VIEWPORT_H, lod)
  const camWorld = frame.localToWorld(x, ground0 + EYE_M, z)
  const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R
  const leaves = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camWorld, R)
    for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) leaves.push({ face, ...q })
  }
  const offsets = new Float32Array(leaves.length * 4)
  const faces = new Float32Array(leaves.length)
  let finest = Infinity, coarsest = 0
  for (let i = 0; i < leaves.length; i++) {
    const q = leaves[i]
    offsets[i * 4] = q.ox; offsets[i * 4 + 1] = q.oy; offsets[i * 4 + 2] = q.l; offsets[i * 4 + 3] = q.level
    faces[i] = q.face
    if (q.level < finest) finest = q.level
    if (q.level > coarsest) coarsest = q.level
  }
  const gridSize = TD.gridMeshSize
  const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => ({ offsets, faces, count: leaves.length, gridSize, radius: R }), focusRadiusM: FOCUS_RADIUS_M })
  surface.setFocus(x, z)
  surface.sync()
  const y = surface.heightAtLocal(x, z)
  // The mesh only answers where a quad covers the point, and only at its own vertex spacing: the
  // coarsest level drawn here is what bounds the answer, so it is reported next to the number.
  const spacing = gridSize > 0 ? (R * Math.PI / 2) / (gridSize * Math.pow(2, coarsest)) : NaN
  return { y, leaves: leaves.length, finest, coarsest, spacing, splitDist }
}

function grassBladeAt(x, z) {
  let key
  try { key = chunkKeyAtLocal(lattice, frame, x, z) } catch { return { y: NaN, distM: NaN } }
  let list = null
  try { list = placementsForGrassChunk(key, frame, anchorField, worldSeed) } catch { return { y: NaN, distM: NaN } }
  let best = { y: NaN, distM: NaN }
  if (Array.isArray(list)) for (const b of list) {
    const d = Math.hypot(b.x - x, b.z - z)
    if (!Number.isFinite(d)) continue
    if (!Number.isFinite(best.distM) || d < best.distM) best = { y: b.y, distM: d }
  }
  return best
}

const rows = []
for (const d of DISTANCES_M) {
  const x = d === 0 ? 0 : Math.round(Math.cos(BEARING) * d)
  const z = d === 0 ? 0 : Math.round(Math.sin(BEARING) * d)
  const m = meshAt(x, z)
  const cpu = frame.groundHeightLocal(x, z)
  const g = grassBladeAt(x, z)
  const row = {
    d, x, z,
    meshY: Number.isFinite(m.y) ? +m.y.toFixed(4) : NaN,
    cpuY: +cpu.toFixed(4),
    grassBladeY: Number.isFinite(g.y) ? +g.y.toFixed(4) : NaN,
    bladeDistM: Number.isFinite(g.distM) ? +g.distM.toFixed(3) : NaN,
    meshMinusCpuM: Number.isFinite(m.y) ? +(m.y - cpu).toFixed(4) : NaN,
    grassMinusMeshM: Number.isFinite(m.y) && Number.isFinite(g.y) ? +(g.y - m.y).toFixed(4) : NaN,
    grassMinusCpuM: Number.isFinite(g.y) ? +(g.y - cpu).toFixed(4) : NaN,
    quads: m.leaves, finest: m.finest, coarsest: m.coarsest,
    vertexSpacingM: +m.spacing.toFixed(4),
  }
  rows.push(row)
  console.log(`DIST d=${d} at(${x},${z}) meshY=${row.meshY} cpuY=${row.cpuY} grassBladeY=${row.grassBladeY} (blade ${row.bladeDistM} m away) | mesh-cpu=${row.meshMinusCpuM} grass-mesh=${row.grassMinusMeshM} grass-cpu=${row.grassMinusCpuM} quads=${row.quads} levels=${row.finest}..${row.coarsest} vertexSpacing=${row.vertexSpacingM} m`)
}

for (const r of rows) {
  expect(`d=${r.d}m: the mesh surface answered at the rung`, Number.isFinite(r.meshY),
    `meshY=${r.meshY} over ${r.quads} quad(s), levels ${r.finest}..${r.coarsest}`)
}
for (const r of rows) {
  expect(`d=${r.d}m: the rendered mesh ground is within ${ACCEPT_MESH_CPU_M} m of the exact field`, Number.isFinite(r.meshMinusCpuM) && Math.abs(r.meshMinusCpuM) <= ACCEPT_MESH_CPU_M,
    `mesh-cpu=${r.meshMinusCpuM} m (meshY=${r.meshY} cpuY=${r.cpuY})`)
}
for (const r of rows) {
  expect(`d=${r.d}m: a grass blade sits within ${ACCEPT_MESH_CPU_M} m of the rendered mesh ground`, Number.isFinite(r.grassMinusMeshM) && Math.abs(r.grassMinusMeshM) <= ACCEPT_MESH_CPU_M,
    `grass-mesh=${r.grassMinusMeshM} m (bladeY=${r.grassBladeY} meshY=${r.meshY}, blade ${r.bladeDistM} m away)`)
}
const near = rows.find((r) => r.d === Math.min(...DISTANCES_M))
const far = rows.find((r) => r.d === Math.max(...DISTANCES_M))
const growth = Number.isFinite(near.meshMinusCpuM) && Number.isFinite(far.meshMinusCpuM)
  ? +(Math.abs(far.meshMinusCpuM) - Math.abs(near.meshMinusCpuM)).toFixed(4) : NaN
console.log(`GROWTH meshMinusCpuM: ${near.d}m=${near.meshMinusCpuM} -> ${far.d}m=${far.meshMinusCpuM} (|delta| growth ${growth} m) ladder=[${rows.map((r) => r.meshMinusCpuM).join(', ')}]`)
console.log(`GROWTH grassMinusMeshM: ladder=[${rows.map((r) => r.grassMinusMeshM).join(', ')}]`)

const failed = checks.filter((c) => !c.ok).length
for (const c of checks) if (!c.ok) console.log('FAIL: ' + c.check + ': ' + c.detail)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} world=${WORLD} -- ${checks.length} check(s), ${failed} failure(s), mesh-cpu=[${rows.map((r) => r.meshMinusCpuM).join(', ')}]`)
process.exit(failed ? 1 : 0)
