// Witness: does grass sit on the SAME surface the terrain mesh renders, per LOD band?
//
// Two geometry sources are compared at one chart-local (x,z):
//   MESH  -- the triangulated grid the TSL planet actually submits, read back through
//            packages/mapspinner/src/tsl/planet-tsl.js drawnQuads() and queried with
//            src/terrain/TerrainMeshSurface.js
//   GRASS -- the ground height src/terrain/GrassPlacement.js gives a grass cell,
//            which is src/terrain/PlacementChart.js surfaceAlongDir() over the frame.
//
// The same cells and the same chunks are placed twice: once on the frame as it ships (BEFORE)
// and once through client/core/ExactPatchFrame.js with the rendered-mesh surface attached
// (AFTER), and |cell y - meshY(cell x, cell z)| is reported per distance band.
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
const { createExactPatchFrame } = await import(href('client/core/ExactPatchFrame.js'))
const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt, surfaceOfCell } = await import(href('src/terrain/VegPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))

const WORLD = process.env.GTSG_WORLD || 'tps-game.js'
const VIEWPORT_H = Number(process.env.GTSG_VIEWPORT_H || 1080)
const FOVY_DEG = Number(process.env.GTSG_FOVY || 70)
const FOCUS_RADIUS_M = 480
const GRASS_RING_M = 61.6
const BANDS = [[0, 16, 'near'], [16, 40, 'mid'], [40, GRASS_RING_M, 'far']]
const AFTER_CELL_MAX_M = 0.005
const RELIEF_SITE_DEG = 45
const RELIEF_GATE_M = 2

const fail = []
const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', WORLD))
const tcfg = loaded.terrain
const R = tcfg.radius
const hashVersion = terrainHashVersionOf(tcfg)
const worldSeed = (tcfg.seed ?? 0) | 0
console.log(`grass-terrain-shared-geometry: world=${WORLD} radius=${R} reliefScale=${tcfg.reliefScale} seed=${worldSeed} hashVersion=${hashVersion}`)

function rotZ(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), Math.cos(a), 0] }

function buildSite(name, anchorDir) {
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
  const gridSize = TD.gridMeshSize
  const surface = createTerrainMeshSurface({ frame, heightAtDir: (d) => sampler.heightAt(d), quads: () => ({ offsets, faces, count: leaves.length, gridSize, radius: R }), focusRadiusM: FOCUS_RADIUS_M })
  surface.setFocus(0, 0)
  surface.sync()
  return { name, sampler, frame, ground0, leaves, gridSize, surface, lod, splitDist, camAlt }
}

function chartOfQuad(frame, q, R) {
  const E = frame.east, N = frame.north
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let c = 0; c < 4; c++) {
    const d = faceDir(q.face, q.ox + (c & 1 ? q.l : 0), q.oy + (c & 2 ? q.l : 0), R)
    const wx = d[0] * R, wy = d[1] * R, wz = d[2] * R
    const x = wx * E[0] + wy * E[1] + wz * E[2]
    const z = wx * N[0] + wy * N[1] + wz * N[2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  return { minX, maxX, minZ, maxZ }
}
const _fd = [0, 0, 0]
function faceDir(face, u, v, R) {
  const F = FACE_FRAME[face]
  const wx = R * Math.tan((u / R) * (Math.PI / 4))
  const wy = R * Math.tan((v / R) * (Math.PI / 4))
  const ax = F.u[0] * wx + F.v[0] * wy + F.c[0] * R
  const ay = F.u[1] * wx + F.v[1] * wy + F.c[1] * R
  const az = F.u[2] * wx + F.v[2] * wy + F.c[2] * R
  const l = Math.hypot(ax, ay, az) || 1
  _fd[0] = ax / l; _fd[1] = ay / l; _fd[2] = az / l
  return _fd
}

function p95(arr) {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN }

function newBands() { return BANDS.map(() => ({ n: 0, sum: 0, max: 0, all: [] })) }
function push(bands, d, delta) {
  const bi = BANDS.findIndex(([lo, hi]) => d >= lo && d < hi)
  if (bi < 0) return
  const s = bands[bi]
  s.n++; s.sum += delta; if (delta > s.max) s.max = delta; s.all.push(delta)
}

const sites = [
  ['shipped', tcfg.anchorDir || [0, 1, 0]],
  ['relief', rotZ(RELIEF_SITE_DEG)],
]

for (const [name, anchorDir] of sites) {
  const site = buildSite(name, anchorDir)
  const { frame, surface, leaves, gridSize } = site
  const levelHist = new Map()
  for (const q of leaves) levelHist.set(q.level, (levelHist.get(q.level) || 0) + 1)
  console.log(`\n--- site ${name} anchorDir=[${anchorDir.map((v) => v.toFixed(4)).join(',')}] anchorHeight=${frame.anchorHeight.toFixed(3)}`)
  console.log(`    mesh lod: maxLevel=${site.lod.maxLevel} splitFactor=${site.lod.splitFactor} splitDist=${site.splitDist.toFixed(4)} camAlt=${site.camAlt.toFixed(2)} drawnQuads=${leaves.length} gridSize=${gridSize}`)
  console.log(`    level histogram: ${[...levelHist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `L${k}:${v}`).join(' ')}`)

  const ringSamples = []
  for (let k = 0; k < 64; k++) {
    const t = (k / 64) * Math.PI * 2
    try { ringSamples.push(frame.groundHeightLocal(Math.cos(t) * 30, Math.sin(t) * 30)) } catch (_) {}
  }
  const relief = ringSamples.length ? Math.max(...ringSamples) - Math.min(...ringSamples) : NaN
  console.log(`    field relief over a 30m ring: ${relief.toFixed(3)}m`)
  if (name === 'relief' && !(relief >= RELIEF_GATE_M)) fail.push(`relief site only has ${relief.toFixed(3)}m of relief, under the ${RELIEF_GATE_M}m gate`)

  for (const d of [0, 8, 32, 61, 100, 200, 400]) {
    let best = null
    for (const q of leaves) {
      const box = chartOfQuad(frame, q, R)
      if (d < box.minX - 2 || d > box.maxX + 2 || 0 < box.minZ - 2 || 0 > box.maxZ + 2) continue
      const span = Math.abs(box.maxX - box.minX)
      if (!best || span < best.span) best = { level: q.level, span }
    }
    console.log(`    d=${String(d).padStart(4)}m meshLevel=${best ? best.level : '-'} quadSpan=${best ? best.span.toFixed(3) : '-'}m vertexSpacing=${best ? (best.span / gridSize).toFixed(3) : '-'}m`)
  }

  const lattice = latticeFor(frame, GRASS)
  const keys = new Set()
  for (let x = -GRASS_RING_M - GRASS.CHUNK; x <= GRASS_RING_M + GRASS.CHUNK; x += GRASS.CHUNK) {
    for (let z = -GRASS_RING_M - GRASS.CHUNK; z <= GRASS_RING_M + GRASS.CHUNK; z += GRASS.CHUNK) {
      if (Math.hypot(x, z) > GRASS_RING_M + GRASS.CHUNK) continue
      keys.add(chunkKeyAtLocal(lattice, frame, x, z))
    }
  }
  const anchorField = createCachedAnchorField(site.sampler.anchorField, frame)
  const beforeFrame = frame
  frame.renderMeshHeightAtLocal = surface.heightAtLocal
  const afterFrame = createExactPatchFrame(frame).placementFrame

  const cellBefore = newBands(), cellAfter = newBands()
  const bladeBefore = newBands(), bladeAfter = newBands()
  let unserved = 0
  for (const key of keys) {
    for (const [which, f] of [['before', beforeFrame], ['after', afterFrame]]) {
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
          if (my === null) { unserved++; continue }
          push(which === 'before' ? cellBefore : cellAfter, dist, Math.abs(y - my))
        }
      }
      let list = null
      try { list = placementsForGrassChunk(key, f, anchorField, worldSeed) } catch (_) { list = null }
      if (list) for (const b of list) {
        const dist = Math.hypot(b.x, b.z)
        if (!(dist < GRASS_RING_M)) continue
        const my = surface.heightAtLocal(b.x, b.z)
        if (my === null) { unserved++; continue }
        push(which === 'before' ? bladeBefore : bladeAfter, dist, Math.abs(b.y - my))
      }
    }
  }

  const show = (label, bands) => {
    const total = bands.reduce((a, s) => a + s.n, 0)
    if (!total) { console.log(`    ${label}: no sample placed at this site`); return }
    console.log(`    ${label}`)
    for (let i = 0; i < BANDS.length; i++) {
      const [lo, hi, nm] = BANDS[i]
      const s = bands[i]
      console.log(`      band ${nm.padEnd(4)} [${lo},${hi})m  n=${String(s.n).padStart(6)}  mean=${mean(s.all).toFixed(4)}m  p95=${p95(s.all).toFixed(4)}m  max=${s.max.toFixed(4)}m`)
    }
  }
  show('CELL ground vs rendered mesh, BEFORE (frame as shipped)', cellBefore)
  show('CELL ground vs rendered mesh, AFTER  (shared mesh surface)', cellAfter)
  show('BLADE y vs rendered mesh, BEFORE', bladeBefore)
  show('BLADE y vs rendered mesh, AFTER', bladeAfter)
  if (unserved) console.log(`    samples outside the served mesh surface: ${unserved}`)

  for (let i = 0; i < BANDS.length; i++) {
    const nm = BANDS[i][2]
    if (cellAfter[i].n < 100) { fail.push(`${name}/${nm}: only ${cellAfter[i].n} grass cells measured after the change`); continue }
    if (!(cellAfter[i].max <= AFTER_CELL_MAX_M)) fail.push(`${name}/${nm}: after max ${cellAfter[i].max.toFixed(4)}m exceeds ${AFTER_CELL_MAX_M}m`)
    if (!(cellAfter[i].max < cellBefore[i].max)) fail.push(`${name}/${nm}: after max ${cellAfter[i].max.toFixed(4)}m is not below before max ${cellBefore[i].max.toFixed(4)}m`)
    if (!(p95(cellAfter[i].all) < p95(cellBefore[i].all))) fail.push(`${name}/${nm}: after p95 ${p95(cellAfter[i].all).toFixed(4)}m is not below before p95 ${p95(cellBefore[i].all).toFixed(4)}m`)
  }
  const st = surface.stats()
  if (!/^[1-9]\d*$/.test(String(st.served))) fail.push(`${name}: the mesh surface served ${st.served} queries, so the numbers above measure nothing`)
  if (!(cellBefore[BANDS.length - 1].max > cellBefore[0].max)) {
    fail.push(`${name}: before max does not grow with distance (${cellBefore[0].max.toFixed(4)}m near vs ${cellBefore[BANDS.length - 1].max.toFixed(4)}m far)`)
  }
  console.log(`    surface stats: ${JSON.stringify(st)}`)
  console.log('    mesh vs exact field beyond the grass ring (what a wider ring would inherit):')
  for (const d of [100, 200, 400]) {
    const vals = []
    for (let k = 0; k < 32; k++) {
      const t = (k / 32) * Math.PI * 2
      const x = Math.cos(t) * d, z = Math.sin(t) * d
      const my = surface.heightAtLocal(x, z)
      if (my === null) continue
      let fy
      try { fy = frame.groundHeightLocal(x, z) } catch (_) { continue }
      vals.push(Math.abs(my - fy))
    }
    if (!vals.length) { console.log(`      d=${String(d).padStart(4)}m  no sample served`); continue }
    console.log(`      d=${String(d).padStart(4)}m  n=${vals.length}  mean=${mean(vals).toFixed(4)}m  p95=${p95(vals).toFixed(4)}m  max=${Math.max(...vals).toFixed(4)}m`)
  }
}

console.log('')
if (fail.length) {
  for (const f of fail) console.error(`FAIL: ${f}`)
  process.exit(1)
}
console.log('RESULT: PASS')
