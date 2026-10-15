// Witness: is the drawn-mesh surface ONE authority, and does the mirror's lazy sync earn the
// version it latches?
//
// Two latent defects on the same attachment, client/core/TerrainBackdrop.js:130 assigning
// frame.renderMeshHeightAtLocal = meshSurface.heightAtLocal:
//
//   A. BY VALUE VS LIVE. client/core/ExactPatchFrame.js:60 captured that property into a local when
//      the placement frame was built, and that capture is what client/core/Grass.js,
//      Vegetation.js and Rocks.js hold for the life of the ring. src/terrain/GrassPlacement.js read
//      the SAME property live, per cell. After a late attach or a rebuild -- the mirror is rebuilt
//      with the planet, and a quality tier change re-attaches it at a different maxLevel -- the two
//      answer from different meshes: the ground a blade is placed against comes from the old one and
//      the surface it is drawn on is the new one. This arm builds two real mirrors over one frame
//      at two LOD tiers, attaches the first, constructs the placement frame the way boot does, then
//      re-attaches the second, and asks what the placement frame answers against what is drawn.
//
//   B. A LATCHED VERSION IT DID NOT EARN. src/terrain/TerrainMeshSurface.js ensureCoverage set
//      lazySyncVersion = version after every sync, including one that produced zero quads, so the
//      first read of the boot ring -- made before the renderer had drawn anything -- claimed the
//      whole version as covered and every read behind it in that version answered "no ground" and
//      fell through to the CPU sampler even once the quads existed. This arm reads before the
//      renderer has drawn, lets it draw without calling sync(), and reads again.
//
// Both arms are run against the module under test by path, so the same measurement can be pointed
// at the pre-fix source: a witness that passes either way is not evidence.
import { Quadtree } from 'mapspinner/quadtree.js'
import { resolveLodConfig, applyLodConfig } from 'mapspinner/lod-config.js'
import { TERRAIN_DEFAULTS as TD } from 'mapspinner/terrain-defaults.js'
import { worldToFaceLocal } from 'mapspinner/planet-orchestrator-cull.js'
import { createHeightSampler } from 'mapspinner/height-cpu'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
// The modules under test. Default is what ships; --module / --surface-module point the SAME
// measurement at an older copy of the file (e.g. `git show HEAD:client/core/ExactPatchFrame.js`
// written beside it) to prove the check can fail and is not passing on silence.
const EXACT_MODULE = arg('module', 'client/core/ExactPatchFrame.js')
const SURFACE_MODULE = arg('surface-module', 'src/terrain/TerrainMeshSurface.js')

const WORLD = arg('world', 'tps-game.js')
const VIEWPORT_H = Number(arg('viewport-h', 1080))
const FOVY_DEG = Number(arg('fovy', 70))
const FOCUS_RADIUS_M = 480
const GRASS_RING_M = 61.6
const BANDS = [[0, 16, 'near'], [16, 40, 'mid'], [40, GRASS_RING_M, 'far']]
// A rebuild at a coarser tier: three whole maxLevel steps, which is what a QualityGovernor tier
// shed moves (splitFactor is inert, so terrain quality only moves in maxLevel steps).
const REBUILD_LEVEL_DROP = 3
// The fixed arm: the placement frame and the drawn mesh are one surface, so the residual is the
// read's own tolerance -- the same 5 mm the shared-geometry gate pins the AFTER arm to.
const ATTACHED_MAX_M = 0.005
// The control: if the two attachments were the same mesh, arm A could not fail and would prove
// nothing. Two real tiers over relief have to differ by more than this.
const TIERS_DIFFER_MIN_M = 0.05

const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const { createPlanetFrame } = await import(href('src/terrain/PlanetFrame.js'))
const { terrainCarvesOf, terrainHashVersionOf } = await import(href('src/shared/terrainConfig.js'))
const { createTerrainMeshSurface } = await import(href(SURFACE_MODULE))
const { createExactPatchFrame } = await import(href(EXACT_MODULE))
const { GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt, surfaceOfCell } = await import(href('src/terrain/VegPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))

const checks = []
function check(label, ok, detail) {
  checks.push({ label, ok: !!ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
const max = (a) => (a.length ? Math.max(...a) : NaN)

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
const anchorDir = tcfg.anchorDir || [0, 1, 0]
console.log(`exact-patch-attachment-resolution: world=${WORLD} radius=${R} hashVersion=${hashVersion} maxLevel=${tcfg.maxLevel}`)
console.log(`  module=${EXACT_MODULE} surface-module=${SURFACE_MODULE}`)

const sampler = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
const heightAtDir = (d) => sampler.heightAt(d)
const ground0 = frame.groundHeightLocal(0, 0)
const camWorld = frame.localToWorld(0, ground0 + 1.7, 0)
const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R

function payloadAt(maxLevel) {
  const qt = new Quadtree(R)
  const lod = resolveLodConfig({ maxLevel, splitFactor: tcfg.splitFactor }, FOVY_DEG * Math.PI / 180)
  applyLodConfig(qt, R, VIEWPORT_H, lod)
  const leaves = []
  for (let face = 0; face < 6; face++) {
    const lc = worldToFaceLocal(face, camWorld, R)
    for (const q of qt.updateQuadtree(lc[0], lc[1], lc[2], lc[0], lc[1], undefined, undefined, camAlt, null)) leaves.push({ face, ...q })
  }
  const offsets = new Float32Array(leaves.length * 4)
  const faces = new Float32Array(leaves.length)
  for (let i = 0; i < leaves.length; i++) {
    const q = leaves[i]
    offsets[i * 4] = q.ox; offsets[i * 4 + 1] = q.oy; offsets[i * 4 + 2] = q.l; offsets[i * 4 + 3] = q.level
    faces[i] = q.face
  }
  return { offsets, faces, count: leaves.length, gridSize: TD.gridMeshSize, radius: R, quads: leaves.length }
}

const payloadA = payloadAt(tcfg.maxLevel)
const payloadB = payloadAt(Math.max(2, tcfg.maxLevel - REBUILD_LEVEL_DROP))
console.log(`  boot mesh: ${payloadA.count} quad(s) at maxLevel=${tcfg.maxLevel}; rebuilt mesh: ${payloadB.count} quad(s) at maxLevel=${Math.max(2, tcfg.maxLevel - REBUILD_LEVEL_DROP)}`)

function surfaceOver(payload) {
  const s = createTerrainMeshSurface({ frame, heightAtDir, quads: () => payload, focusRadiusM: FOCUS_RADIUS_M })
  s.setFocus(0, 0)
  s.sync()
  return s
}

// ---------------------------------------------------------------- arm A: one authority
const surfaceA = surfaceOver(payloadA)
const surfaceB = surfaceOver(payloadB)

frame.renderMeshHeightAtLocal = surfaceA.heightAtLocal
const exact = createExactPatchFrame(frame)
// The rebuild: the planet is rebuilt at another tier and the mirror is re-attached to the same
// frame. Nothing tells the placement frames about it -- that is the defect.
frame.renderMeshHeightAtLocal = surfaceB.heightAtLocal

const lattice = latticeFor(frame, GRASS)
const keys = new Set()
for (let x = -GRASS_RING_M - GRASS.CHUNK; x <= GRASS_RING_M + GRASS.CHUNK; x += GRASS.CHUNK) {
  for (let z = -GRASS_RING_M - GRASS.CHUNK; z <= GRASS_RING_M + GRASS.CHUNK; z += GRASS.CHUNK) {
    if (Math.hypot(x, z) > GRASS_RING_M + GRASS.CHUNK) continue
    keys.add(chunkKeyAtLocal(lattice, frame, x, z))
  }
}

const band = () => BANDS.map(() => [])
const cellDelta = band()   // what placement answered, against the mesh that is drawn now
const tierDelta = band()   // control: the two attachments are different meshes
for (const key of keys) {
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  const cell = createPlacementCell(frame)
  const seed = (worldSeed | 0) ^ 0x6a55
  for (let gz = 0; gz < GRASS.GRID; gz++) {
    for (let gx = 0; gx < GRASS.GRID; gx++) {
      placementCellAt(frame, lattice, dec, gx, gz, seed, 0, 20, 21, cell)
      const rho = surfaceOfCell(exact.placementFrame, cell)
      if (!Number.isFinite(rho)) continue
      const x = cell.at[0], y = cell.at[1], z = cell.at[2]
      const dist = Math.hypot(x, z)
      if (!(dist < GRASS_RING_M)) continue
      const drawn = surfaceB.heightAtLocal(x, z)
      const boot = surfaceA.heightAtLocal(x, z)
      if (drawn === null || boot === null) continue
      const bi = BANDS.findIndex(([lo, hi]) => dist >= lo && dist < hi)
      if (bi < 0) continue
      cellDelta[bi].push(Math.abs(y - drawn))
      tierDelta[bi].push(Math.abs(boot - drawn))
    }
  }
}

// The same question without placement in the way: what the frame's own ground port answers, against
// the port itself. One authority resolves these to the same function, so they cannot differ.
const portDelta = []
for (const radius of [8, 32, 56]) {
  for (let k = 0; k < 24; k++) {
    const t = (k / 24) * Math.PI * 2
    const x = Math.cos(t) * radius, z = Math.sin(t) * radius
    const port = exact.placementFrame.groundHeightLocal(x, z)
    const drawn = surfaceB.heightAtLocal(x, z)
    if (!Number.isFinite(port) || drawn === null) continue
    portDelta.push(Math.abs(port - drawn))
  }
}

for (let i = 0; i < BANDS.length; i++) {
  console.log(`  band ${BANDS[i][2].padEnd(4)} [${BANDS[i][0]},${BANDS[i][1]})m  placement-vs-drawn n=${String(cellDelta[i].length).padStart(5)}  mean=${mean(cellDelta[i]).toFixed(4)}m  max=${max(cellDelta[i]).toFixed(4)}m   tiers-differ mean=${mean(tierDelta[i]).toFixed(4)}m max=${max(tierDelta[i]).toFixed(4)}m`)
}
console.log(`  frame ground port vs drawn mesh over ${portDelta.length} sample(s) at 8/32/56m: mean=${mean(portDelta).toFixed(4)}m max=${max(portDelta).toFixed(4)}m`)

const cellAll = cellDelta.flat()
const tierAll = tierDelta.flat()
check(`the two attachments are different meshes, so arm A can fail at all`,
  max(tierAll) > TIERS_DIFFER_MIN_M,
  `the boot mesh and the rebuilt mesh differ by ${mean(tierAll).toFixed(4)}m mean / ${max(tierAll).toFixed(4)}m max over ${tierAll.length} sample(s), over a ${TIERS_DIFFER_MIN_M}m floor`)
for (let i = 0; i < BANDS.length; i++) {
  const nm = BANDS[i][2]
  check(`band ${nm}: placement answers from the mesh that is drawn after the rebuild`,
    cellDelta[i].length >= 100 && max(cellDelta[i]) <= ATTACHED_MAX_M,
    `n=${cellDelta[i].length} max=${max(cellDelta[i]).toFixed(4)}m over a ${ATTACHED_MAX_M}m budget`)
}
check(`the frame's ground port and the drawn mesh are one authority`,
  portDelta.length >= 48 && max(portDelta) <= ATTACHED_MAX_M,
  `max=${max(portDelta).toFixed(4)}m over ${portDelta.length} sample(s), over a ${ATTACHED_MAX_M}m budget`)

// ---------------------------------------------------------------- arm B: the earned latch
let drawnPayload = { offsets: new Float32Array(0), faces: new Float32Array(0), count: 0, gridSize: TD.gridMeshSize, radius: R }
const latchSurface = createTerrainMeshSurface({ frame, heightAtDir, quads: () => drawnPayload, focusRadiusM: FOCUS_RADIUS_M })
latchSurface.setFocus(0, 0)
const beforeDraw = latchSurface.heightAtLocal(0, 0)
const versionBefore = latchSurface.version
// The renderer draws. The mirror is NOT told: sync() is the render loop's call, and the read below
// is the one the boot prewarm makes.
drawnPayload = payloadA
const afterDraw = latchSurface.heightAtLocal(0, 0)
const st = latchSurface.stats()
const syncsAfter = st.syncs
const afterAgain = latchSurface.heightAtLocal(12, 12)
const st2 = latchSurface.stats()
console.log(`  coverage latch: before the draw ${JSON.stringify(beforeDraw)} (version ${versionBefore}), after the draw ${JSON.stringify(afterDraw)} (version ${latchSurface.version}), syncs=${st.syncs} nearQuads=${st.nearQuads}`)
console.log(`  coverage latch: a third read at another point ${JSON.stringify(afterAgain)}, syncs ${syncsAfter} -> ${st2.syncs}`)

check(`a read before the renderer has drawn answers no ground, so the window exists`,
  beforeDraw === null,
  `heightAtLocal answered ${JSON.stringify(beforeDraw)} before any quad was drawn`)
check(`a read after the renderer drew is answered from the drawn mesh, with no sync() in between`,
  Number.isFinite(afterDraw),
  `heightAtLocal answered ${JSON.stringify(afterDraw)} after the quads appeared, nearQuads=${st.nearQuads}`)
check(`the retry is bounded: a further read adds no sync`,
  st2.syncs === syncsAfter,
  `syncs ${syncsAfter} -> ${st2.syncs} over a read at another point`)

const failed = checks.filter((c) => !c.ok).length
for (const c of checks) if (!c.ok) console.log(`FAIL: ${c.label}: ${c.detail}`)
console.log(`MEASURED exact-patch-attachment-resolution: placement-vs-drawn max=${max(cellAll).toFixed(4)}m mean=${mean(cellAll).toFixed(4)}m over ${cellAll.length} sample(s), tiers differ ${mean(tierAll).toFixed(4)}m mean / ${max(tierAll).toFixed(4)}m max, port max=${max(portDelta).toFixed(4)}m, latch ${JSON.stringify(beforeDraw)}->${JSON.stringify(afterDraw)} syncs=${st2.syncs}`)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} label=exact-patch-attachment-resolution -- ${checks.length} check(s), ${failed} failure(s)`)
process.exit(failed ? 1 : 0)
