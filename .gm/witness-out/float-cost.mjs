import path from 'node:path'
import { pathToFileURL } from 'node:url'
const REPO = '/workspace/spoint'
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href)
const { Quadtree } = await import('mapspinner/quadtree.js')
const { resolveLodConfig, applyLodConfig } = await import('mapspinner/lod-config.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { worldToFaceLocal } = await import('mapspinner/planet-orchestrator-cull.js')
const { loadWorldModule } = await imp('src/sdk/WorldLocator.js')
const { resolveTerrainConfig } = await imp('src/shared/terrainConfig.js')
const { loadPlanetSampler, planetSamplerOptsOf } = await imp('src/terrain/TerrainPhysics.js')
const { createPlanetFrame } = await imp('src/terrain/PlanetFrame.js')
const { createCachedAnchorField } = await imp('src/terrain/ClimateCache.js')
const { latticeFor, chunkKeyAtLocal, ringAroundLocal, chunkCentreLocal } = await imp('src/terrain/PlacementChart.js')
const { placementsForRockChunk, ROCK } = await imp('src/terrain/RockPlacement.js')
const { createTerrainMeshSurface } = await imp('src/terrain/TerrainMeshSurface.js')
const { createExactPatchFrame } = await imp('client/core/ExactPatchFrame.js')
const loaded = await loadWorldModule(path.join(REPO, 'apps', 'world', 'tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const SEED = tcfg.seed | 0
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const R = frame.radius
const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, 70 * Math.PI / 180)
const cached = createCachedAnchorField(sampler.anchorField, frame)
const latt = latticeFor(frame, ROCK)
function payloadAt(Cx, Cz) {
  const gh = frame.cpuGroundHeightLocal(Cx, Cz)
  const camWorld = frame.localToWorld(Cx, gh + 1.7, Cz)
  const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R
  const qt = new Quadtree(R)
  applyLodConfig(qt, R, 1080, lod)
  const leaves = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camWorld, R)
    for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) leaves.push({ face, ...q })
  }
  const offsets = new Float32Array(leaves.length * 4), faces = new Float32Array(leaves.length)
  for (let i = 0; i < leaves.length; i++) { const q = leaves[i]; offsets[i*4] = q.ox; offsets[i*4+1] = q.oy; offsets[i*4+2] = q.l; offsets[i*4+3] = q.level; faces[i] = q.face }
  return { offsets, faces, count: leaves.length, gridSize: TD.gridMeshSize, radius: R }
}



const rows = []
for (const focusRadiusM of [240, 450]) {
  for (const D of [0, 1500, 2500, 4000]) {
    const payload = payloadAt(D, 0)
    const t0 = performance.now()
    const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => payload, focusRadiusM })
    surface.setFocus(D, 0); surface.sync()
    let n = 0, holes = 0
    for (let x = D - 712; x <= D + 712; x += 9.7) for (let z = -712; z <= 712; z += 9.3) {
      const dist = Math.hypot(x - D, z)
      if (dist > 712) continue
      n++
      if (surface.heightAtLocal(x, z) === null) holes++
    }
    const ms = performance.now() - t0
    rows.push({ focusRadiusM, reachM: +(focusRadiusM * 1.6).toFixed(0), cameraM: D, points: n, holes, holePct: +(100 * holes / n).toFixed(2), ms: +ms.toFixed(0), builds: surface.stats().builds, nearQuads: surface.stats().nearQuads })
  }
}
console.log(JSON.stringify(rows))
