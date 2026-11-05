import path from 'node:path'
import { pathToFileURL } from 'node:url'
const REPO = '/workspace/spoint'
const imp = (p) => import(pathToFileURL(path.join(REPO, p)).href)
const { Quadtree } = await import('mapspinner/quadtree.js')
const { resolveLodConfig, applyLodConfig } = await import('mapspinner/lod-config.js')
const { TERRAIN_DEFAULTS: TD } = await import('mapspinner/terrain-defaults.js')
const { worldToFaceLocal } = await import('mapspinner/planet-orchestrator-cull.js')
const { cubeFaceOf } = await import(pathToFileURL(path.join(REPO, 'src/terrain/PlacementLattice.js')).href)
const { loadWorldModule } = await imp('src/sdk/WorldLocator.js')
const { resolveTerrainConfig } = await imp('src/shared/terrainConfig.js')
const { loadPlanetSampler, planetSamplerOptsOf } = await imp('src/terrain/TerrainPhysics.js')
const { createPlanetFrame } = await imp('src/terrain/PlanetFrame.js')
const { createTerrainMeshSurface } = await import(pathToFileURL(path.join(REPO, 'src/terrain/TerrainMeshSurface.js')).href)
const loaded = await loadWorldModule(path.join(REPO, 'apps', 'world', 'tps-game.js'))
const tcfg = resolveTerrainConfig(loaded)
const sampler = await loadPlanetSampler(planetSamplerOptsOf(tcfg))
const frame = createPlanetFrame({ sampler, anchorDir: tcfg.anchorDir || [0, 1, 0], offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const R = frame.radius
const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, 70 * Math.PI / 180)
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

const focusRadiusM = Number(process.env.FOCUS || 450), D = 0
const payload = payloadAt(D, 0)
const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => payload, focusRadiusM })
surface.setFocus(D, 0); surface.sync()
const E = frame.east, U = frame.up, N = frame.north, aH = frame.anchorHeight
const camW = [0,1,2].map(i => U[i] * (R + aH) + E[i] * D)
const reach = focusRadiusM * 1.6 * 4 / Math.PI
const samples = []
for (let x = 0; x <= 712; x += 9.7) for (let z = -712; z <= 712; z += 9.3) {
  const dist = Math.hypot(x - D, z)
  if (dist < 600 || dist > 700) continue
  if (surface.heightAtLocal(x, z) !== null) continue
  samples.push([x, z, dist])
  if (samples.length >= 4) break
}
const info = samples.map(([x, z, dist]) => {
  const truth = frame.cpuGroundHeightLocal(x, z)
  const world = frame.localToWorld(x, truth, z)
  const leaves = []
  const f0 = cubeFaceOf(world[0], world[1], world[2])
  {
    const f = f0
    const lc = worldToFaceLocal(f, world, R)
    for (let i = 0; i < payload.count; i++) {
      if (payload.faces[i] !== f) continue
      const ox = payload.offsets[i*4], oy = payload.offsets[i*4+1], l = payload.offsets[i*4+2]
      if (lc[0] >= ox && lc[0] <= ox + l && lc[1] >= oy && lc[1] <= oy + l) {
        const cam = worldToFaceLocal(f, camW, R)
        const rx = Math.max(0, Math.abs(ox + l * 0.5 - cam[0]) - l * 0.5), rz = Math.max(0, Math.abs(oy + l * 0.5 - cam[1]) - l * 0.5)
        leaves.push({ f, ox: +ox.toFixed(1), oy: +oy.toFixed(1), l: +l.toFixed(1), level: payload.offsets[i*4+3], reachDist: +Math.hypot(rx, rz).toFixed(1), inReach: Math.hypot(rx, rz) <= reach, camFace: cam ? 'ok' : 'null', camLocal: cam ? [+cam[0].toFixed(1), +cam[1].toFixed(1)] : null, lc: [+lc[0].toFixed(1), +lc[1].toFixed(1)] })
      }
    }
  }
  return { x, z, dist: +dist.toFixed(1), leaves }
})


// Hole census with the correct face: how many holes have a covering leaf on their own face, and how many of those are inside the reach.
const census = { holes: 0, holeWithLeaf: 0, holeLeafInReach: 0, sampledHoleFaces: {} }
for (let x = -712; x <= 712; x += 9.7) for (let z = -712; z <= 712; z += 9.3) {
  const dist = Math.hypot(x, z)
  if (dist > Number(process.env.BAND_MAX || 712) || dist < Number(process.env.BAND_MIN || 392)) continue
  if (surface.heightAtLocal(x, z) !== null) continue
  census.holes++
  const truth = frame.cpuGroundHeightLocal(x, z)
  const world = frame.localToWorld(x, truth, z)
  const f = cubeFaceOf(world[0], world[1], world[2])
  census.sampledHoleFaces[f] = (census.sampledHoleFaces[f] || 0) + 1
  const lc = worldToFaceLocal(f, world, R)
  const cam = worldToFaceLocal(f, camW, R)
  let found = false, inReach = false
  for (let i = 0; i < payload.count; i++) {
    if (payload.faces[i] !== f) continue
    const ox = payload.offsets[i*4], oy = payload.offsets[i*4+1], l = payload.offsets[i*4+2]
    if (lc[0] >= ox && lc[0] <= ox + l && lc[1] >= oy && lc[1] <= oy + l) {
      found = true
      const rx = Math.max(0, Math.abs(ox + l * 0.5 - cam[0]) - l * 0.5), rz = Math.max(0, Math.abs(oy + l * 0.5 - cam[1]) - l * 0.5)
      if (Math.hypot(rx, rz) <= reach) inReach = true
    }
  }
  if (found) census.holeWithLeaf++
  if (inReach) census.holeLeafInReach++
}
console.log(JSON.stringify({ reach, census, camLocalFace2: worldToFaceLocal(cubeFaceOf(camW[0], camW[1], camW[2]), camW, R), camFace: cubeFaceOf(camW[0], camW[1], camW[2]) }, null, 1))
