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
const bins = [[0, 100], [100, 200], [200, 300], [300, 392], [392, 1e9]]
const out = []
for (const D of [0, 1000, 2500, 4000]) {
  const payload = payloadAt(D, 0)
  const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => payload })
  frame.renderMeshHeightAtLocal = surface.heightAtLocal
  surface.setFocus(D, 0); surface.sync()
  const pf = createExactPatchFrame(frame).placementFrame
  const grid = bins.map(() => ({ n: 0, uncovered: 0, maxDrawnMinusTruth: 0, sumAbs: 0 }))
  for (let x = D - 400; x <= D + 400; x += 8) for (let z = -400; z <= 400; z += 8) {
    const dist = Math.hypot(x - D, z)
    if (dist > 400) continue
    const bi = bins.findIndex(([lo, hi]) => dist >= lo && dist < hi)
    const g = grid[bi]
    g.n++
    const m = surface.heightAtLocal(x, z)
    if (m === null) { g.uncovered++; continue }
    const truth = frame.cpuGroundHeightLocal(x, z)
    const d = Math.abs(m - truth)
    g.sumAbs += d
    if (d > g.maxDrawnMinusTruth) g.maxDrawnMinusTruth = d
  }
  const ringKeys = ringAroundLocal(latt, frame, D, 0, 360 + latt.chunkM)
  const rocks = { n: 0, covered: 0, uncovered: 0, maxUncoveredDyVsTruth: 0, maxCoveredDyVsDrawn: 0, uncoveredMaxDist: 0 }
  for (const k of ringKeys) {
    const c = chunkCentreLocal(latt, frame, k, [0, 0])
    if (Math.hypot(c[0] - D, c[1]) > 360) continue
    for (const p of placementsForRockChunk(k, pf, cached, SEED)) {
      const dist = Math.hypot(p.x - D, p.z)
      if (dist > 360) continue
      rocks.n++
      const m = surface.heightAtLocal(p.x, p.z)
      if (m === null) {
        rocks.uncovered++
        const dy = Math.abs(p.y - frame.cpuGroundHeightLocal(p.x, p.z))
        if (dy > rocks.maxUncoveredDyVsTruth) rocks.maxUncoveredDyVsTruth = dy
        if (dist > rocks.uncoveredMaxDist) rocks.uncoveredMaxDist = dist
      } else {
        rocks.covered++
        const dy = Math.abs(p.y - m)
        if (dy > rocks.maxCoveredDyVsDrawn) rocks.maxCoveredDyVsDrawn = dy
      }
    }
  }
  out.push({ cameraM: D, quads: payload.count, grid: bins.map(([lo, hi], i) => ({ band: lo + '-' + (hi > 1e8 ? 'inf' : hi), n: grid[i].n, uncovered: grid[i].uncovered, meanAbsDrawnMinusTruth: grid[i].n - grid[i].uncovered > 0 ? +(grid[i].sumAbs / (grid[i].n - grid[i].uncovered)).toFixed(4) : null, maxAbsDrawnMinusTruth: +grid[i].maxDrawnMinusTruth.toFixed(3) })), rocks: { ...rocks, maxUncoveredDyVsTruth: +rocks.maxUncoveredDyVsTruth.toFixed(3), maxCoveredDyVsDrawn: +rocks.maxCoveredDyVsDrawn.toFixed(4), uncoveredMaxDist: +rocks.uncoveredMaxDist.toFixed(1) } })
}
console.log(JSON.stringify(out, null, 1))
