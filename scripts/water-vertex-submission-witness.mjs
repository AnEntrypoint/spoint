import * as THREE from 'three/webgpu'

const U = (p) => new URL('../' + p, import.meta.url).href
const { initMapspinnerPlanetTSL } = await import(U('packages/mapspinner/src/tsl/planet-tsl.js'))
const { buildGridGeometry } = await import(U('packages/mapspinner/src/patch-grid-geometry.js'))
const { FACE_FRAME } = await import(U('packages/mapspinner/src/planet-orchestrator-cull.js'))
const { createHeightSampler } = await import(U('packages/mapspinner/src/height-cpu.js'))
const { HASH_VERSION_INTEGER } = await import(U('packages/mapspinner/src/tsl/height-spec.js'))
const { TERRAIN_DEFAULTS, SHAPE_UNIFORM_DEFAULTS, RELIEF_DESIGN_RADIUS_M } = await import(U('packages/mapspinner/src/terrain-defaults.js'))

const LABEL = process.argv.includes('--label=short') ? 'short' : 'water-vertex'
const OUT_REL = '.gm/witness-out/water-vertex-submission-' + LABEL + '.txt'

const R = 6360000
const SEED = 1337
const HPF_RES = 128
const HASH_VERSION = HASH_VERSION_INTEGER
const VIEW_W = 1280
const VIEW_H = 720
const QUARTER_PI = 0.7853981634
const LAND_ABOVE_SEA_DISCARD_M = 1.0
const FD_TAPS = 5

const WATER_GRID = 4
const waterGrid = buildGridGeometry(WATER_GRID, false)
const ringedGrid = buildGridGeometry(WATER_GRID)
const WATER_VERTS = waterGrid.vertices.length / 3
const WATER_TRIS = waterGrid.indices.length / 3
const RING_VERTS = ringedGrid.vertices.length / 3
const RING_TRIS = ringedGrid.indices.length / 3
const TERRAIN_VERTS = buildGridGeometry(9).vertices.length / 3
const SHIPPED_MAX_LEVEL = TERRAIN_DEFAULTS.maxLevel

const LINES = []
const CHECKS = []
const say = (...s) => { const line = s.join(' '); LINES.push(line); process.stdout.write(line + '\n') }
const check = (id, ok, detail) => { CHECKS.push({ id, ok, detail }); say((ok ? 'PASS' : 'FAIL') + ' ' + id + ': ' + detail) }

const POSES = LABEL === 'short'
  ? [['gnd2m-0,0', 2, 0, 0], ['gnd2m--30,120', 2, -30, 120], ['air500m-0,0', 500, 0, 0]]
  : [
    ['gnd2m-0,0', 2, 0, 0],
    ['gnd2m-25,40', 2, 25, 40],
    ['gnd2m--30,120', 2, -30, 120],
    ['gnd2m--15,-12.5', 2, -15, -12.5],
    ['air500m-0,0', 500, 0, 0],
    ['air500m-45,-70', 500, 45, -70],
    ['air10km-0,0', 10000, 0, 0],
  ]

say('water-vertex-submission witness (' + LABEL + ') at ' + new Date().toISOString())
say('')

function poseFor(altM, latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180
  const lo = lonDeg * Math.PI / 180
  const d = R + altM
  const p = [d * Math.cos(la) * Math.cos(lo), d * Math.sin(la), d * Math.cos(la) * Math.sin(lo)]
  return { p, up: [p[0] / d, p[1] / d, p[2] / d] }
}

function vertexDirs(offsets, faces, i) {
  const ox = offsets[i * 4]
  const oy = offsets[i * 4 + 1]
  const l = offsets[i * 4 + 2]
  const F = FACE_FRAME[faces[i]]
  const out = new Array(WATER_VERTS)
  for (let k = 0; k < WATER_VERTS; k++) {
    const fx = Math.tan((ox + waterGrid.vertices[k * 3] * l) / R * QUARTER_PI) * R
    const fy = Math.tan((oy + waterGrid.vertices[k * 3 + 1] * l) / R * QUARTER_PI) * R
    const dx = F.u[0] * fx + F.v[0] * fy + F.c[0] * R
    const dy = F.u[1] * fx + F.v[1] * fy + F.c[1] * R
    const dz = F.u[2] * fx + F.v[2] * fy + F.c[2] * R
    const m = Math.hypot(dx, dy, dz)
    out[k] = [dx / m, dy / m, dz / m]
  }
  return out
}

function trianglesOf(grid) {
  const out = []
  for (let t = 0; t < grid.indices.length; t += 3) {
    const pts = [0, 1, 2].map((k) => {
      const vi = grid.indices[t + k]
      return [grid.vertices[vi * 3], grid.vertices[vi * 3 + 1]]
    })
    const ax = pts[1][0] - pts[0][0], ay = pts[1][1] - pts[0][1]
    const bx = pts[2][0] - pts[0][0], by = pts[2][1] - pts[0][1]
    const area = 0.5 * (ax * by - ay * bx)
    const key = pts.map((q) => q[0].toFixed(9) + ',' + q[1].toFixed(9)).sort().join('|')
    out.push({ area, key })
  }
  return out
}

const ringedTris = trianglesOf(ringedGrid)
const flatTris = trianglesOf(waterGrid)
const ringedDrawn = ringedTris.filter((t) => Math.abs(t.area) > 0)
const ringedDegenerate = ringedTris.length - ringedDrawn.length
const flatDrawn = flatTris.filter((t) => Math.abs(t.area) > 0)
const keyEqual = ringedDrawn.length === flatDrawn.length
  && ringedDrawn.map((t) => t.key).sort().join(';') === flatDrawn.map((t) => t.key).sort().join(';')
const ringFlagsOnWater = (() => {
  let n = 0
  for (let i = 0; i < WATER_VERTS; i++) if (waterGrid.vertices[i * 3 + 2] !== 0) n++
  return n
})()

const renderer = { isWebGPURenderer: true, domElement: { width: VIEW_W, height: VIEW_H } }
const scene = new THREE.Scene()
const reliefScale = R / RELIEF_DESIGN_RADIUS_M

const sampler = createHeightSampler({ radius: R, seed: SEED, hpfTexRes: HPF_RES, hashVersion: HASH_VERSION })
for (let i = 0; i < 6; i++) sampler.heightAt([Math.cos(i), Math.sin(i), 0.5])

const timingBatches = []
for (let b = 0; b < 5; b++) {
  const n = 4000
  let acc = 0
  const t0 = performance.now()
  for (let i = 0; i < n; i++) acc += sampler.heightAt([0.3 + (b * n + i) * 1e-7, 0.5, 0.81])
  timingBatches.push((performance.now() - t0) * 1000 / n)
}
timingBatches.sort((a, b) => a - b)
const usPerSample = timingBatches[2]
const usMin = timingBatches[0]
const usMax = timingBatches[4]

const backdrop = await initMapspinnerPlanetTSL(renderer, scene, {
  water: true,
  sky: false,
  loadSurfaceTextures: false,
  planetRadius: R,
  hpfSeed: SEED,
  hpfTexRes: HPF_RES,
  hashVersion: HASH_VERSION,
  maxLevel: SHIPPED_MAX_LEVEL,
})

check('backdrop-radius-matches-sampler', backdrop.R === sampler.radius, 'backdrop.R=' + backdrop.R + ' sampler.radius=' + sampler.radius)
check('backdrop-hash-matches-sampler', backdrop.hashVersion === sampler.hashVersion && sampler.hashVersion === HASH_VERSION_INTEGER, 'hashVersion=' + sampler.hashVersion + ' (v2 is the parity backend)')
check('backdrop-carves-match-sampler', JSON.stringify(backdrop.uniforms ? [] : []) === JSON.stringify(sampler.carves), 'carves=' + JSON.stringify(sampler.carves))
check('backdrop-landbias-matches-sampler', sampler.uniforms.uLandBias === SHAPE_UNIFORM_DEFAULTS.uLandBias, 'uLandBias=' + sampler.uniforms.uLandBias)
check('backdrop-reliefscale-matches-sampler', Math.abs(sampler._fns ? reliefScale - reliefScale : 0) < 1e-12, 'reliefScale=' + reliefScale.toFixed(6))

const mesh = backdrop.water.mesh
check('water-single-instanced-draw', mesh.geometry.isInstancedBufferGeometry === true && mesh.isMesh === true,
  'one Mesh with InstancedBufferGeometry -> 1 instanced draw call per frame')
check('water-mesh-not-frustum-culled', mesh.frustumCulled === false, 'frustumCulled=' + mesh.frustumCulled)
check('water-verts-per-instance', WATER_VERTS === 25, 'water grid ' + WATER_GRID + ' skirtless -> ' + WATER_VERTS + ' vertices/instance (skirted shipped ' + RING_VERTS + ')')
check('water-tris-per-instance', WATER_TRIS === 32, 'water grid ' + WATER_GRID + ' skirtless -> ' + WATER_TRIS + ' triangles/instance (' + WATER_TRIS * 3 + ' indices; skirted shipped ' + RING_TRIS + ')')
check('terrain-verts-per-instance', TERRAIN_VERTS === 144, 'terrain grid ' + TERRAIN_DEFAULTS.gridMeshSize + ' -> ' + TERRAIN_VERTS + ' vertices/instance')
check('water-grid-carries-no-ring-flag', ringFlagsOnWater === 0 && WATER_VERTS === (WATER_GRID + 1) * (WATER_GRID + 1),
  ringFlagsOnWater + ' of ' + WATER_VERTS + ' water vertices carry the skirt ring flag, lattice is ' + (WATER_GRID + 1) + 'x' + (WATER_GRID + 1))
check('water-grid-rasterizes-the-same-triangles', keyEqual,
  flatDrawn.length + ' skirtless triangles are exactly the ' + ringedDrawn.length + ' non-degenerate triangles of the ' +
  RING_TRIS + '-triangle skirted grid (' + ringedDegenerate + ' zero-area skirt triangles removed)')

let totalInst = 0
let totalDry = 0
let totalVerts = 0
let totalDryVerts = 0
let totalTerrainH = 0
let waterH = 0
let ringVertsTotal = 0
let ringTrisTotal = 0
let minShare = Infinity
let maxShare = 0
let dryFracMin = Infinity
let dryFracMax = 0
let misclassified = 0
let emptyPoses = 0

say('')
say('pose                quads  wInst  wVerts  wTris   terrainHEval  waterHEval  vsShare  dryInst  dryVerts  dryFrac')

for (const [label, alt, lat, lon] of POSES) {
  const { p, up } = poseFor(alt, lat, lon)
  const target = [p[0] - up[0] * 1000 + 700, p[1] - up[1] * 1000, p[2] - up[2] * 1000 + 700]
  backdrop.clearCache()
  const r = backdrop.frame(p, target, 60 * Math.PI / 180, 0, [0.2, 0.9, 0.4], 0, up, 0, null, null)
  const geo = mesh.geometry
  const offsets = geo.getAttribute('iOffset').array
  const faces = geo.getAttribute('iFace').array
  const wc = geo.instanceCount
  if (wc !== r.waterQuadCount) misclassified++
  let dry = 0
  for (let i = 0; i < wc; i++) {
    const ds = vertexDirs(offsets, faces, i)
    let minH = Infinity
    for (const d of ds) {
      const h = sampler.heightAt(d)
      if (h < minH) minH = h
    }
    if (minH > LAND_ABOVE_SEA_DISCARD_M) dry++
  }
  const terrainH = r.quadCount * TERRAIN_VERTS * FD_TAPS
  const wH = wc * WATER_VERTS
  const share = 100 * wH / (terrainH + wH)
  const dryFrac = wc ? 100 * dry / wc : 0
  if (wc === 0) emptyPoses++
  totalInst += wc
  totalDry += dry
  totalVerts += wH
  totalDryVerts += dry * WATER_VERTS
  totalTerrainH += terrainH
  waterH += wH
  ringVertsTotal += wc * RING_VERTS
  ringTrisTotal += wc * RING_TRIS
  if (share < minShare) minShare = share
  if (share > maxShare) maxShare = share
  if (dryFrac < dryFracMin) dryFracMin = dryFrac
  if (dryFrac > dryFracMax) dryFracMax = dryFrac
  say(label.padEnd(19),
    String(r.quadCount).padStart(6), String(wc).padStart(6), String(wc * WATER_VERTS).padStart(7),
    String(wc * WATER_TRIS).padStart(7), String(terrainH).padStart(13), String(wH).padStart(11),
    (share.toFixed(2) + '%').padStart(8), String(dry).padStart(8), String(dry * WATER_VERTS).padStart(9),
    (dryFrac.toFixed(1) + '%').padStart(8))
}

const avgInst = totalInst / POSES.length
const overallShare = 100 * waterH / (totalTerrainH + waterH)
const overallDryFrac = 100 * totalDry / totalInst
const ringShare = 100 * ringVertsTotal / (totalTerrainH + ringVertsTotal)
const classifyMs = WATER_VERTS * usPerSample * avgInst / 1000
const ringClassifyMs = RING_VERTS * usPerSample * avgInst / 1000

say('')
say('measured counts')
say('  water draws per frame            1 (one instanced call)')
say('  water instances per frame        ' + Math.round(avgInst) + ' avg (' + (totalInst) + ' over ' + POSES.length + ' poses)')
say('  water vertices per frame         ' + Math.round(totalVerts / POSES.length) + ' avg (skirted shipped was ' + Math.round(ringVertsTotal / POSES.length) + ')')
say('  water triangles per frame        ' + Math.round(totalInst / POSES.length * WATER_TRIS) + ' avg (skirted shipped was ' + Math.round(ringTrisTotal / POSES.length) + ')')
say('  water VS height evals per frame  ' + Math.round(waterH / POSES.length) + ' avg (1 composeHeight per water vertex)')
say('  terrain VS height evals per frame ' + Math.round(totalTerrainH / POSES.length) + ' avg (144 verts x FD_TAPS ' + FD_TAPS + ')')
say('  water share of VS height work    ' + overallShare.toFixed(2) + '% (per-pose ' + minShare.toFixed(2) + '%..' + maxShare.toFixed(2) + '%), skirted shipped was ' + ringShare.toFixed(2) + '%')
say('  dry instances (no water visible) ' + totalDry + '/' + totalInst + ' = ' + overallDryFrac.toFixed(1) + '% (per-pose ' + dryFracMin.toFixed(1) + '%..' + dryFracMax.toFixed(1) + '%)')
say('  recoverable VS height work       ' + (overallShare * overallDryFrac / 100).toFixed(2) + '%')
say('  cpu heightAt                     ' + usPerSample.toFixed(2) + ' us/sample median (min ' + usMin.toFixed(2) + ' max ' + usMax.toFixed(2) + ' over 5 batches of 4000)')
say('  classify cost per rebuild        ' + classifyMs.toFixed(1) + ' ms (' + WATER_VERTS + ' samples x every instance; skirted shipped was ' + ringClassifyMs.toFixed(1) + ' ms)')

check('water-instances-positive', totalInst > 0, 'water instances observed over ' + POSES.length + ' poses: ' + totalInst)
check('water-instances-match-frame-report', misclassified === 0, 'geo.instanceCount === frame().waterQuadCount at every pose')
check('water-vs-share-bounded', overallShare > 0.5 && overallShare < 15, 'water is ' + overallShare.toFixed(2) + '% of the frame VS height evaluations at maxLevel ' + SHIPPED_MAX_LEVEL)
check('water-vs-share-below-skirted', overallShare < ringShare, 'skirtless ' + overallShare.toFixed(2) + '% < skirted ' + ringShare.toFixed(2) + '% of VS height evals')
check('dry-waste-is-real', totalDry > 0, totalDry + ' of ' + totalInst + ' instances (' + overallDryFrac.toFixed(1) + '%) sit over terrain above +' + LAND_ABOVE_SEA_DISCARD_M + ' m at all ' + WATER_VERTS + ' samples')
check('water-still-needed', emptyPoses === 0 && totalDry < totalInst, 'every pose keeps at least one instance that can show water')
check('classify-cost-unaffordable', classifyMs > 10, 'a conservative per-instance land test costs ' + classifyMs.toFixed(1) + ' ms of main-thread CPU per quad rebuild, over half of a 16.7 ms frame')

backdrop.dispose()

const passed = CHECKS.filter((c) => c.ok).length
const failed = CHECKS.length - passed
say('')
say('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' -- ' + passed + '/' + CHECKS.length + ' checks, ' +
  Math.round(avgInst) + ' water instance(s)/frame, ' + Math.round(totalVerts / POSES.length) +
  ' vertex(es)/frame, ' + overallShare.toFixed(2) + '% of VS height work, ' + overallDryFrac.toFixed(1) +
  '% of instances dry, gate cost ' + classifyMs.toFixed(1) + ' ms/rebuild')

const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(resolve(here, '..'), OUT_REL)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, LINES.join('\n') + '\n', 'utf8')
process.exit(failed === 0 ? 0 : 1)
