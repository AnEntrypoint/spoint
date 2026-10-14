#!/usr/bin/env node
// MESH SURFACE READ COVERAGE -- a read of the rendered-mesh mirror may not depend on when the
// render loop last synced it.
//
// client/core/TerrainBackdrop.js:130 attaches the mirror to the frame as
// `frame.renderMeshHeightAtLocal`; client/core/ExactPatchFrame.js:60 reads it and, where it does
// not answer, falls through to the frame's own sampler. So "attached" is not the same as
// "serving": the mirror's near-quad index is built by sync(), and sync() used to be reachable only
// from renderPlanet (client/core/TerrainBackdrop.js:290), which the boot does not run until the
// world is revealed -- while grass, vegetation and rocks are placed by the scenery build
// (client/app.js _awaitSceneryBuild, awaited at :484) BEFORE _revealWorld (:515). Every blade,
// tree and rock of the initial ring was therefore placed on the sampler, i.e. in the state
// scripts/grass-terrain-shared-geometry-witness.mjs calls BEFORE.
//
// This witness pins the contract that closes that window, at the layer that owns it and in node:
// the mirror answers for the point it is asked about, and it rebuilds at most once per version so
// a placement burst cannot turn into per-read sync work.
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
const { GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt, surfaceOfCell } = await import(href('src/terrain/VegPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))

const WORLD = process.env.MSRC_WORLD || 'tps-game.js'
const VIEWPORT_H = 1080
const FOVY_DEG = 70
const GRASS_RING_M = 61.6
const BANDS = [[0, 16, 'near'], [16, 40, 'mid'], [40, GRASS_RING_M, 'far']]
const ATTACHED_MAX_M = 0.005
// The before arm has to be measurably off the mesh, or "the attached arm is within 5 mm" is a
// claim any flat site satisfies.
const BEFORE_MIN_M = 0.02

const results = []
function check(id, ok, detail) {
  results.push(ok === true)
  console.log(`${ok === true ? '  [PASS] ' : '  [FAIL] '}${id}: ${detail}`)
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN }
function newBands() { return BANDS.map(() => ({ n: 0, max: 0, all: [] })) }
function push(bands, d, delta) {
  const bi = BANDS.findIndex(([lo, hi]) => d >= lo && d < hi)
  if (bi < 0) return
  const s = bands[bi]
  s.n++; if (delta > s.max) s.max = delta; s.all.push(delta)
}
function rotZ(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] }

const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
console.log(`mesh-surface-read-coverage: world=${WORLD} radius=${R} reliefScale=${tcfg.reliefScale} seed=${worldSeed} hashVersion=${hashVersion}`)

function faceDir(face, u, v, R) {
  const F = FACE_FRAME[face]
  const wx = R * Math.tan((u / R) * (Math.PI / 4))
  const wy = R * Math.tan((v / R) * (Math.PI / 4))
  const ax = F.u[0] * wx + F.v[0] * wy + F.c[0] * R
  const ay = F.u[1] * wx + F.v[1] * wy + F.c[1] * R
  const az = F.u[2] * wx + F.v[2] * wy + F.c[2] * R
  const l = Math.hypot(ax, ay, az) || 1
  return [ax / l, ay / l, az / l]
}

function buildSite(anchorDir) {
  const sampler = createHeightSampler({ radius: R, seed: tcfg.seed, reliefScale: tcfg.reliefScale, hashVersion, carves: terrainCarvesOf(tcfg) })
  const frame = createPlanetFrame({ sampler, anchorDir, offsetY: tcfg.offsetY || 0, reliefScale: tcfg.reliefScale })
  const ground0 = frame.groundHeightLocal(0, 0)
  const qt = new Quadtree(R)
  const lod = resolveLodConfig({ maxLevel: tcfg.maxLevel, splitFactor: tcfg.splitFactor }, FOVY_DEG * Math.PI / 180)
  const splitDist = applyLodConfig(qt, R, VIEWPORT_H, lod)
  const camWorld = frame.localToWorld(0, ground0 + 1.7, 0)
  const camAlt = Math.hypot(camWorld[0], camWorld[1], camWorld[2]) - R
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
  const payload = { offsets, faces, count: leaves.length, gridSize: TD.gridMeshSize, radius: R }
  return { sampler, frame, ground0, leaves, gridSize: TD.gridMeshSize, payload, lod, splitDist, camAlt }
}

const site = buildSite(rotZ(45))
const { frame, payload } = site
console.log(`    site anchorDir=rotZ(45) anchorHeight=${frame.anchorHeight.toFixed(3)} drawnQuads=${site.leaves.length} gridSize=${site.gridSize} camAlt=${site.camAlt.toFixed(2)}`)

// ---------------------------------------------------------------- M01: an empty payload refuses
{
  const surface = createTerrainMeshSurface({
    frame,
    heightAtDir: (d) => site.sampler.heightAt(d),
    quads: () => ({ offsets: new Float32Array(0), faces: new Float32Array(0), count: 0, gridSize: site.gridSize, radius: R }),
  })
  let refused = 0
  for (let k = 0; k < 1000; k++) {
    const t = (k / 1000) * Math.PI * 2
    if (isMeshSurfaceNoGround(surface.heightAtLocal(Math.cos(t) * 20, Math.sin(t) * 20))) refused++
  }
  const st = surface.stats()
  check('M01-empty-payload-refuses', refused === 1000 && st.served === 0 && st.syncs <= 2,
    `${refused}/1000 reads refused, served=${st.served}, syncs=${st.syncs} (a mirror with nothing drawn answers nothing and does not spin)`)
}

// ------------------------------------------------- M02: a never-synced mirror serves on first read
const surface = createTerrainMeshSurface({
  frame,
  heightAtDir: (d) => site.sampler.heightAt(d),
  quads: () => payload,
})
{
  const y = surface.heightAtLocal(0, 0)
  const st = surface.stats()
  check('M02-unsynced-read-serves', Number.isFinite(y) && st.served >= 1 && st.nearQuads > 0 && st.syncs === 1,
    `first read y=${Number.isFinite(y) ? y.toFixed(6) : String(y)} served=${st.served} nearQuads=${st.nearQuads} syncs=${st.syncs}`)
}

// ------------------------------------------- M03: placement through the frame sits on that mirror
{
  frame.renderMeshHeightAtLocal = surface.heightAtLocal
  const afterFrame = createExactPatchFrame(frame).placementFrame
  const lattice = latticeFor(frame, GRASS)
  const keys = new Set()
  for (let x = -GRASS_RING_M - GRASS.CHUNK; x <= GRASS_RING_M + GRASS.CHUNK; x += GRASS.CHUNK) {
    for (let z = -GRASS_RING_M - GRASS.CHUNK; z <= GRASS_RING_M + GRASS.CHUNK; z += GRASS.CHUNK) {
      if (Math.hypot(x, z) > GRASS_RING_M + GRASS.CHUNK) continue
      keys.add(chunkKeyAtLocal(lattice, frame, x, z))
    }
  }
  const before = newBands(), after = newBands()
  for (const key of keys) {
    for (const [which, f] of [['before', frame], ['after', afterFrame]]) {
      const dec = lattice.decodeChunk(key, [0, 0, 0])
      const cell = createPlacementCell(frame)
      const seed = (worldSeed | 0) ^ 0x6a55
      for (let gz = 0; gz < GRASS.GRID; gz++) {
        for (let gx = 0; gx < GRASS.GRID; gx++) {
          placementCellAt(frame, lattice, dec, gx, gz, seed, 0, 20, 21, cell)
          const rho = surfaceOfCell(f, cell)
          if (!Number.isFinite(rho)) continue
          const x = cell.at[0], y = cell.at[1], z = cell.at[2]
          const dist = Math.hypot(x, z)
          if (!(dist < GRASS_RING_M)) continue
          const my = surface.heightAtLocal(x, z)
          if (my === null) continue
          push(which === 'before' ? before : after, dist, Math.abs(y - my))
        }
      }
    }
  }
  const band = (b, i) => `n=${String(b[i].n).padStart(5)} mean=${mean(b[i].all).toFixed(4)}m max=${b[i].max.toFixed(4)}m`
  for (let i = 0; i < BANDS.length; i++) {
    console.log(`    band ${BANDS[i][2].padEnd(4)} [${BANDS[i][0]},${BANDS[i][1]})m  detached ${band(before, i)}   attached ${band(after, i)}`)
  }
  const beforeFar = before[BANDS.length - 1].max
  const afterOk = after.every((b) => b.n > 0 && b.max <= ATTACHED_MAX_M)
  check('M03-detached-arm-is-off-the-mesh', beforeFar >= BEFORE_MIN_M,
    `detached far max ${beforeFar.toFixed(4)}m >= ${BEFORE_MIN_M}m, so the ${ATTACHED_MAX_M}m gate below is not vacuous`)
  check('M04-attached-arm-sits-on-the-mesh', afterOk,
    `attached per-band max ${after.map((b) => b.max.toFixed(4)).join('/')}m all <= ${ATTACHED_MAX_M}m with no explicit sync()`)
}

// -------------------------------------------------- M05: reads inside the footprint do not resync
{
  const before = surface.stats().syncs
  for (let k = 0; k < 5000; k++) {
    const t = (k / 5000) * Math.PI * 2
    surface.heightAtLocal(Math.cos(t) * 40, Math.sin(t) * 40)
  }
  const after = surface.stats().syncs
  check('M05-no-resync-storm', after === before,
    `5000 reads inside the footprint: syncs ${before} -> ${after}`)
}

// ------------------------------------------- M06: a read outside the footprint rebuilds exactly once
{
  const before = surface.stats().syncs
  surface.sync()
  const midR = surface.stats().syncs
  for (let k = 0; k < 200; k++) surface.heightAtLocal(1200 + k, 1200 + k)
  const after = surface.stats().syncs
  check('M06-rebuild-once-per-version', midR === before + 1 && after === midR + 1,
    `render sync ${before} -> ${midR}, then 200 reads beyond the footprint -> ${after} (one rebuild, not 200)`)
}

const failed = results.filter((r) => !r).length
console.log('')
if (failed) { console.error(`FAIL: ${failed} of ${results.length} checks failed`); process.exit(1) }
console.log(`RESULT: PASS -- mesh-surface-read-coverage: ${results.length} of ${results.length} checks passed`)
