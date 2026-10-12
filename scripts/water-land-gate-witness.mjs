import * as THREE from 'three/webgpu'

if (!process.env.SPOINT_GPU_WITNESS) {
  process.stdout.write('SKIP water-land-gate: this witness reaches the WebGPURenderer surface by name (isWebGPURenderer), so the gpu-free arm of scripts/check.mjs refuses it and it does not run in this CI. Re-run with SPOINT_GPU_WITNESS=1.\n')
  process.exit(0)
}

const U = (p) => new URL('../' + p, import.meta.url).href
const { initMapspinnerPlanetTSL } = await import(U('packages/mapspinner/src/tsl/planet-tsl.js'))
const { buildGridGeometry } = await import(U('packages/mapspinner/src/patch-grid-geometry.js'))
const { FACE_FRAME } = await import(U('packages/mapspinner/src/planet-orchestrator-cull.js'))
const { createHeightSampler } = await import(U('packages/mapspinner/src/height-cpu.js'))
const { HASH_VERSION_INTEGER } = await import(U('packages/mapspinner/src/tsl/height-spec.js'))
const { TERRAIN_DEFAULTS } = await import(U('packages/mapspinner/src/terrain-defaults.js'))
const { SCULPT_RES } = await import(U('packages/mapspinner/src/tsl/sculpt-tsl.js'))

const LABEL = process.argv.includes('--label=short') ? 'short' : null
const OUT_REL = '.gm/witness-out/water-land-gate-' + (LABEL ? LABEL : 'witness') + '.txt'

const R = 6360000
const SEED = 1337
const HPF_RES = 128
const HASH_VERSION = HASH_VERSION_INTEGER
const VIEW_W = 1280
const VIEW_H = 720
const QUARTER_PI = 0.7853981634
const LAND_ABOVE_SEA_DISCARD_M = 1.0
const WATER_GRID = 4
const WALK_STEPS = 40
const WALK_STEP_M = 25

const waterGrid = buildGridGeometry(WATER_GRID, false)
const WATER_VERTS = waterGrid.vertices.length / 3

const LINES = []
const CHECKS = []
const say = (...s) => { const line = s.join(' '); LINES.push(line); process.stdout.write(line + '\n') }
const check = (id, ok, detail) => { CHECKS.push({ id, ok, detail }); say((ok ? 'PASS' : 'FAIL') + ' ' + id + ': ' + detail) }

const POSES = LABEL === 'short'
  ? [['gnd2m-0,0', 2, 0, 0], ['gnd2m--30,120', 2, -30, 120]]
  : [
    ['gnd2m-0,0', 2, 0, 0],
    ['gnd2m-25,40', 2, 25, 40],
    ['gnd2m--30,120', 2, -30, 120],
    ['gnd2m--15,-12.5', 2, -15, -12.5],
    ['air500m-0,0', 500, 0, 0],
    ['air500m-45,-70', 500, 45, -70],
    ['air10km-0,0', 10000, 0, 0],
  ]

say('water-land-gate witness at ' + new Date().toISOString())
say('')

function poseFor(altM, latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180
  const lo = lonDeg * Math.PI / 180
  const d = R + altM
  const p = [d * Math.cos(la) * Math.cos(lo), d * Math.sin(la), d * Math.cos(la) * Math.sin(lo)]
  return { p, up: [p[0] / d, p[1] / d, p[2] / d] }
}
function camTarget(p, up) { return [p[0] - up[0] * 1000 + 700, p[1] - up[1] * 1000, p[2] - up[2] * 1000 + 700] }
function drive(backdrop, p, up) {
  backdrop.clearCache()
  return backdrop.frame(p, camTarget(p, up), 60 * Math.PI / 180, 0, [0.2, 0.9, 0.4], 0, up, 0, null, null)
}

function vertexDirs(q) {
  const F = FACE_FRAME[q.face]
  const out = new Array(WATER_VERTS)
  for (let k = 0; k < WATER_VERTS; k++) {
    const fx = Math.tan((q.ox + waterGrid.vertices[k * 3] * q.l) / R * QUARTER_PI) * R
    const fy = Math.tan((q.oy + waterGrid.vertices[k * 3 + 1] * q.l) / R * QUARTER_PI) * R
    const dx = F.u[0] * fx + F.v[0] * fy + F.c[0] * R
    const dy = F.u[1] * fx + F.v[1] * fy + F.c[1] * R
    const dz = F.u[2] * fx + F.v[2] * fy + F.c[2] * R
    const m = Math.hypot(dx, dy, dz)
    out[k] = [dx / m, dy / m, dz / m]
  }
  return out
}
function latticeKeys(q) {
  const out = new Array(WATER_VERTS)
  for (let k = 0; k < WATER_VERTS; k++) {
    const fx = Math.tan((q.ox + waterGrid.vertices[k * 3] * q.l) / R * QUARTER_PI) * R
    const fy = Math.tan((q.oy + waterGrid.vertices[k * 3 + 1] * q.l) / R * QUARTER_PI) * R
    out[k] = q.face + ':' + Math.round(fx) + ':' + Math.round(fy)
  }
  return out
}
function instancesOf(backdrop) {
  const geo = backdrop.water.mesh.geometry
  const o = geo.getAttribute('iOffset').array
  const f = geo.getAttribute('iFace').array
  const out = []
  for (let i = 0; i < geo.instanceCount; i++) out.push({ ox: o[i * 4], oy: o[i * 4 + 1], l: o[i * 4 + 2], lv: o[i * 4 + 3], face: f[i] })
  return out
}
const qKey = (q) => q.face + '|' + q.ox + '|' + q.oy + '|' + q.l + '|' + q.lv

const sampler = createHeightSampler({ radius: R, seed: SEED, hpfTexRes: HPF_RES, hashVersion: HASH_VERSION })
for (let i = 0; i < 6; i++) sampler.heightAt([Math.cos(i), Math.sin(i), 0.5])

let gateEvals = 0
const gateHeightAt = (d) => { gateEvals++; return sampler.heightAt(d) }

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

const renderer = { isWebGPURenderer: true, domElement: { width: VIEW_W, height: VIEW_H } }
const planetOpts = (extra) => ({ water: true, sky: false, loadSurfaceTextures: false, planetRadius: R, hpfSeed: SEED, hpfTexRes: HPF_RES, hashVersion: HASH_VERSION, maxLevel: TERRAIN_DEFAULTS.maxLevel, ...extra })

const open = await initMapspinnerPlanetTSL(renderer, new THREE.Scene(), planetOpts({}))
const gated = await initMapspinnerPlanetTSL(renderer, new THREE.Scene(), planetOpts({ heightAt: gateHeightAt }))
const walker = await initMapspinnerPlanetTSL(renderer, new THREE.Scene(), planetOpts({ heightAt: gateHeightAt }))

check('water-lattice-is-5x5', WATER_VERTS === 25, 'WATER_GRID ' + WATER_GRID + ' -> ' + WATER_VERTS + ' vertices/instance = (WATER_GRID+1)^2, the exact lattice the water VS displaces at')
check('gate-on-requires-a-height-sampler', open.water.landGateStats().active === false && gated.water.landGateStats().active === true,
  'no heightAt -> active=false; heightAt supplied -> active=true')
check('gate-probes-every-lattice-point', gated.water.landGateStats().samplesPerInstance === WATER_VERTS,
  'the gate probes ' + gated.water.landGateStats().samplesPerInstance + ' points per instance, matching the ' + WATER_VERTS + ' the VS evaluates')

const warm = poseFor(2, 0, 0)
drive(open, warm.p, warm.up)
drive(gated, warm.p, warm.up)

say('')
say('warm-up pose gnd2m-0,0 primes the memo, so pose 1 (the same pose) re-evaluates nothing: its gateEval is 0 by design.')
say('the walk phase below runs on a third backdrop whose memo starts empty, so the cold cost is measured there.')
say('pose                inst  bruteS  distinct  dedup   dryInst  dryFrac  gateLook  gateEval  bruteWall  us/samp')

let tInst = 0, tBruteS = 0, tDistinct = 0, tDry = 0, tLook = 0, tEval = 0, tBruteWall = 0
let setMismatch = 0, dryMismatch = 0, counterMismatch = 0
for (const [label, alt, lat, lon] of POSES) {
  const { p, up } = poseFor(alt, lat, lon)

  const openRes = drive(open, p, up)
  const O = instancesOf(open)
  if (O.length !== openRes.waterQuadCount) setMismatch++

  const dirs = [], keys = []
  for (const q of O) { dirs.push(vertexDirs(q)); keys.push(latticeKeys(q)) }

  const heights = new Array(O.length)
  let bruteCalls = 0
  const t0 = performance.now()
  for (let i = 0; i < O.length; i++) {
    const ds = dirs[i]
    let minH = Infinity
    for (let k = 0; k < WATER_VERTS; k++) { const h = sampler.heightAt(ds[k]); bruteCalls++; if (h < minH) minH = h }
    heights[i] = minH
  }
  const bruteEvalMs = performance.now() - t0

  const distinct = new Set()
  const drySet = new Set()
  for (let i = 0; i < O.length; i++) {
    for (const k of keys[i]) distinct.add(k)
    if (heights[i] > LAND_ABOVE_SEA_DISCARD_M) drySet.add(qKey(O[i]))
  }
  const bruteWall = bruteEvalMs

  gated.water.resetLandGateStats()
  gateEvals = 0
  drive(gated, p, up)
  const G = instancesOf(gated)
  const st = gated.water.landGateStats()
  if (st.evaluations !== gateEvals) counterMismatch++

  const expect = O.filter((q) => !drySet.has(qKey(q))).map(qKey).sort().join(';')
  const got = G.map(qKey).sort().join(';')
  if (expect !== got) setMismatch++
  for (const q of G) if (drySet.has(qKey(q))) dryMismatch++

  const bruteS = O.length * WATER_VERTS
  tInst += O.length; tBruteS += bruteS; tDistinct += distinct.size; tDry += drySet.size
  tLook += st.lookups; tEval += st.evaluations; tBruteWall += bruteWall
  say(label.padEnd(19), String(O.length).padStart(5), String(bruteS).padStart(8), String(distinct.size).padStart(9),
    (100 * (1 - distinct.size / bruteS)).toFixed(1).padStart(7) + '%', String(drySet.size).padStart(9),
    (100 * drySet.size / Math.max(1, O.length)).toFixed(1).padStart(8) + '%', String(st.lookups).padStart(10),
    String(st.evaluations).padStart(10), bruteWall.toFixed(1).padStart(11),
    (bruteWall * 1000 / bruteS).toFixed(2).padStart(9))
}

const avgInst = tInst / POSES.length
const avgBruteS = tBruteS / POSES.length
const avgEval = tEval / POSES.length
const avgLook = tLook / POSES.length
const measuredBruteMsPerRebuild = tBruteWall / POSES.length
const usFromWall = tBruteWall * 1000 / tBruteS
const usBench = usPerSample
const bruteMsPerRebuild = measuredBruteMsPerRebuild
const gateMsPerRebuild = avgEval * usFromWall / 1000

say('')
say('re-derived claim (water-vertex lane, sha d67c1175)')
say('  samples per instance           ' + WATER_VERTS + ' = (WATER_GRID+1)^2 -- the water VS displaces at exactly these points')
say('  instances per rebuild          ' + Math.round(avgInst) + ' avg (' + tInst + ' over ' + POSES.length + ' poses)')
say('  brute gate samples per rebuild ' + Math.round(avgBruteS) + ' (' + WATER_VERTS + ' x ' + Math.round(avgInst) + ')')
say('  cpu heightAt, real lattice dirs ' + usFromWall.toFixed(2) + ' us/sample (' + tBruteS + ' calls, 25 per instance, no early exit -- the honest basis)')
say('  cpu heightAt, d67c1175 microbench ' + usBench.toFixed(2) + ' us/sample median (min ' + usMin.toFixed(2) + ' max ' + usMax.toFixed(2) + ' over 5 batches of 4000)')
say('  brute gate cost per rebuild    ' + bruteMsPerRebuild.toFixed(1) + ' ms of main thread (measured wall; ' + (avgBruteS * usBench / 1000).toFixed(1) + ' ms at the microbench rate)')
say('  dry instances                  ' + tDry + '/' + tInst + ' = ' + (100 * tDry / tInst).toFixed(1) + '%  -> the gate can only help this often')
say('  lattice sharing                ' + tDistinct + ' distinct points for ' + tBruteS + ' samples (' + (100 * (1 - tDistinct / tBruteS)).toFixed(1) + '% dedup inside one rebuild)')
say('')
say('shipped gate (ordered early-exit + persistent lattice memo)')
say('  lattice lookups per rebuild    ' + Math.round(avgLook) + ' avg (was ' + Math.round(avgBruteS) + ')')
say('  height evaluations per rebuild ' + avgEval.toFixed(1) + ' avg (was ' + Math.round(avgBruteS) + ')')
say('  gate cost per rebuild          ' + gateMsPerRebuild.toFixed(2) + ' ms  (' + (bruteMsPerRebuild / Math.max(gateMsPerRebuild, 1e-9)).toFixed(0) + 'x cheaper than brute)')

say('')
say('walk: ' + WALK_STEPS + ' consecutive rebuilds, ' + WALK_STEP_M + ' m per step, fresh memo')
let walkMin = Infinity, walkMax = 0, walkSum = 0, walkInst = 0, walkOpenInst = 0, firstEval = 0
for (let s = 0; s < WALK_STEPS; s++) {
  const { p, up } = poseFor(2, (s * WALK_STEP_M) / 111320, (s * WALK_STEP_M) / 111320 * 0.7)
  walker.water.resetLandGateStats()
  gateEvals = 0
  drive(walker, p, up)
  const st = walker.water.landGateStats()
  if (st.evaluations !== gateEvals) counterMismatch++
  if (s === 0) firstEval = st.evaluations
  walkInst += walker.water.mesh.geometry.instanceCount
  walkOpenInst += drive(open, p, up).waterQuadCount
  const e = st.evaluations
  walkSum += e
  if (s > 0) { if (e < walkMin) walkMin = e; if (e > walkMax) walkMax = e }
}
const walkAvg = walkSum / WALK_STEPS
say('  cold rebuild evaluations       ' + firstEval + ' (' + (firstEval * usFromWall / 1000).toFixed(2) + ' ms, once per boot)')
say('  steady-state evaluations       avg ' + walkAvg.toFixed(1) + ' / rebuild (min ' + walkMin + ' max ' + walkMax + ' over rebuilds 1..' + (WALK_STEPS - 1) + ')')
say('  steady-state cost per rebuild  ' + (walkAvg * usFromWall / 1000).toFixed(3) + ' ms')
say('  memo size after the walk       ' + walker.water.landGateStats().memoPoints + ' lattice points')
say('  instances per rebuild          ' + (walkOpenInst / WALK_STEPS).toFixed(1) + ' ungated -> ' + (walkInst / WALK_STEPS).toFixed(1) + ' gated (' + (100 * (1 - walkInst / walkOpenInst)).toFixed(1) + '% dropped)')

say('')
const sculptHeights = new Float32Array(SCULPT_RES * SCULPT_RES)
gated.setSculptOverride([0, 0], 100, { up: [0, 1, 0], east: [1, 0, 0], north: [0, 0, 1] }, sculptHeights)
const sculptOff = gated.water.landGateStats().active
gated.clearSculptOverride()
const sculptBackOn = gated.water.landGateStats().active
check('gate-stands-down-under-a-sculpt-override', sculptOff === false && sculptBackOn === true,
  'a live sculpt override makes the CPU mirror disagree with the GPU height, so the gate is off while it is set (active ' + sculptOff + ' -> ' + sculptBackOn + ')')

check('brute-and-gated-agree-on-every-instance', setMismatch === 0 && dryMismatch === 0,
  'at all ' + POSES.length + ' poses the shipped instance set is exactly the brute set minus the instances whose ' + WATER_VERTS + ' samples are all above +' + LAND_ABOVE_SEA_DISCARD_M + ' m')
check('brute-cost-is-a-dropped-frame', bruteMsPerRebuild > 8, 'the ungated ' + WATER_VERTS + '-samples-per-instance land test costs ' + bruteMsPerRebuild.toFixed(1) + ' ms of main thread per rebuild (measured wall, ' + tBruteS + ' real heightAt calls), over half of a 16.7 ms frame')
check('shipped-gate-is-affordable', gateMsPerRebuild * 4 < bruteMsPerRebuild && walkAvg * usFromWall / 1000 < 1.0,
  'shipped gate ' + gateMsPerRebuild.toFixed(2) + ' ms/rebuild cold (brute ' + bruteMsPerRebuild.toFixed(1) + ' ms) and ' + (walkAvg * usFromWall / 1000).toFixed(3) + ' ms in steady state')
check('evaluation-counter-is-real', counterMismatch === 0 && tEval > 0,
  'the witness counted ' + tEval + ' heightAt calls through its own wrapper and the gate counter agreed at every rebuild')
check('dry-waste-is-real', tDry > 0, tDry + ' of ' + tInst + ' instances (' + (100 * tDry / tInst).toFixed(1) + '%) sit over terrain above +' + LAND_ABOVE_SEA_DISCARD_M + ' m at all ' + WATER_VERTS + ' samples')
check('gate-drops-something', walker.water.landGateStats().memoPoints > 0 && walkInst < walkOpenInst,
  'the gate memoised ' + walker.water.landGateStats().memoPoints + ' lattice points and dropped ' + (walkOpenInst - walkInst) + ' of ' + walkOpenInst + ' instances over the walk')

open.dispose()
gated.dispose()
walker.dispose()

const passed = CHECKS.filter((c) => c.ok).length
const failed = CHECKS.length - passed
say('')
say('RESULT: ' + (failed === 0 ? 'PASS' : 'FAIL') + ' -- ' + passed + '/' + CHECKS.length + ' checks, ' +
  Math.round(avgInst) + ' instance(s)/rebuild, brute ' + bruteMsPerRebuild.toFixed(1) +
  ' ms/rebuild, shipped gate ' + gateMsPerRebuild.toFixed(2) + ' ms/rebuild cold and ' +
  (walkAvg * usFromWall / 1000).toFixed(3) + ' ms steady state, decisions identical')

const { writeFileSync, mkdirSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { fileURLToPath } = await import('node:url')
const outPath = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), OUT_REL)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, LINES.join('\n') + '\n', 'utf8')
process.exit(failed === 0 ? 0 : 1)
