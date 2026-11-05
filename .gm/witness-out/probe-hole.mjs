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
const reachU = focusRadiusM * 1.6 * 4 / Math.PI
const cam4 = worldToFaceLocal(4, camW, R)
const out = []
for (let x = -400; x <= 400 && out.length < 4; x += 7.1) for (let z = -400; z <= 400 && out.length < 4; z += 6.9) {
  const dist = Math.hypot(x, z)
  if (dist > 360 || dist < 200) continue
  if (surface.heightAtLocal(x, z) !== null) continue
  const truth = frame.cpuGroundHeightLocal(x, z)
  const world = frame.localToWorld(x, truth, z)
  const f = cubeFaceOf(world[0], world[1], world[2])
  const lc = worldToFaceLocal(f, world, R)
  const cam = worldToFaceLocal(f, camW, R)
  const covering = []
  for (let i = 0; i < payload.count; i++) {
    if (payload.faces[i] !== f) continue
    const ox = payload.offsets[i*4], oy = payload.offsets[i*4+1], l = payload.offsets[i*4+2]
    if (lc[0] >= ox && lc[0] <= ox + l && lc[1] >= oy && lc[1] <= oy + l) {
      const boxU = Math.abs(ox + l*0.5 - cam[0]) <= reachU + l*0.5
      const boxV = Math.abs(oy + l*0.5 - cam[1]) <= reachU + l*0.5
      covering.push({ ox: +ox.toFixed(1), oy: +oy.toFixed(1), l: +l.toFixed(1), lvl: payload.offsets[i*4+3], boxU, boxV })
    }
  }
  out.push({ x: +x.toFixed(1), z: +z.toFixed(1), dist: +dist.toFixed(1), face: f, lc: [+lc[0].toFixed(1), +lc[1].toFixed(1)], cam: [+cam[0].toFixed(1), +cam[1].toFixed(1)], cam4: [+cam4[0].toFixed(1), +cam4[1].toFixed(1)], reachU: +reachU.toFixed(1), covering: covering.slice(0, 3) })
}
console.log(JSON.stringify(out, null, 1))
