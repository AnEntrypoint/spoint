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
{
const beforeMod = await import(pathToFileURL(path.resolve('.gm/witness-out/tms-before.mjs')).href)
const oldSurf = beforeMod.createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => payload, focusRadiusM })
oldSurf.setFocus(0, 0); oldSurf.sync()
let cmpN = 0, maxAbs = 0, nullMismatch = 0
for (let x = -400; x <= 400; x += 7.1) for (let z = -400; z <= 400; z += 6.9) {
  if (Math.hypot(x, z) > 400) continue
  const a = surface.heightAtLocal(x, z), c = oldSurf.heightAtLocal(x, z)
  cmpN++
  if (a === null || c === null) { if (a !== c) nullMismatch++ } else maxAbs = Math.max(maxAbs, Math.abs(a - c))
}
const TM = 60
for (let i = 0; i < 5; i++) { surface.setFocus(i, 0); surface.sync(); oldSurf.setFocus(i, 0); oldSurf.sync() }
let tA = performance.now()
for (let i = 0; i < TM; i++) { oldSurf.setFocus(i * 1.0, 0); oldSurf.sync() }
const oldMs = (performance.now() - tA) / TM
tA = performance.now()
for (let i = 0; i < TM; i++) { surface.setFocus(i * 1.0, 0); surface.sync() }
const newMs = (performance.now() - tA) / TM
console.log(JSON.stringify({ probes: cmpN, maxAbsHeightDiff: maxAbs, nullMismatch, movingSyncMs: { before: +oldMs.toFixed(3), after: +newMs.toFixed(3) } }))
}
