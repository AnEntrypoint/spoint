#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'
import { measureUncontested, formatRowContention, fingerprintFields, describeContested } from './lib/timing-gate.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? String(ARGS.get(n)) : String(d))
const has = (n) => ARGS.has(n)

const SHAPES = flag('shapes', 'dense10k,dense50k,real').split(',').map((s) => s.trim()).filter(Boolean)
const FRAMES = Number(flag('frames', '400'))
const WARMUP = Number(flag('warmup', '120'))
const SPACING = Number(flag('spacing', '3'))
const SPEED = Number(flag('speed', '7'))
const MESH_FAR = Number(flag('mesh-far', '90'))
const REPEATS = Number(flag('repeats', '5'))
const REF_ARMS = Number(flag('ref-arms', '1'))
const REQUIRE_DROP = Number(flag('require-drop', '50'))
const US_NOISE_LIMIT = Number(flag('us-noise-limit', '15'))
const CONTEST_RETRIES = Number(flag('contest-retries', '3'))
const LABEL = flag('label', 'veg-lod-sweep-' + Date.now())
const BASELINE = has('baseline') ? flag('baseline', '') : ''
const DT = 1 / 60

const LOD_DISTANCES = [0, 14, 35]
const LOD_HYSTERESIS = 0.12
const SHADOW_DISTANCE = 35
const ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'vec3' }
const NO_MESH_TIER = -1
const REAL_INSTANCERS = 90
const REAL_PER_INSTANCER = 47
const REAL_EXTENT = 1280

function makeLevels() {
  const base = new THREE.BoxGeometry(6, 12, 6)
  base.translate(0, 6, 0)
  base.computeBoundingSphere()
  const shared = base.boundingSphere.clone()
  const levels = []
  for (let i = 0; i < LOD_DISTANCES.length; i++) {
    const g = new THREE.BoxGeometry(6 - i * 1.5, 12 - i * 3, 6 - i * 1.5)
    g.translate(0, 6, 0)
    g.boundingSphere = shared.clone()
    levels.push({ geometry: g, material: new THREE.MeshStandardMaterial(), distance: LOD_DISTANCES[i] })
  }
  const shadowGeo = new THREE.BoxGeometry(1.5, 3, 1.5)
  shadowGeo.translate(0, 6, 0)
  shadowGeo.boundingSphere = shared.clone()
  return { levels, shadowGeo, bounds: shared }
}

function thresholdsSq() { return LOD_DISTANCES.map((d) => { const t = d - d * LOD_HYSTERESIS; return t * t }) }

function tierFor(tsq, meshFarSq, dsq) {
  if (dsq >= meshFarSq) return NO_MESH_TIER
  for (let i = tsq.length - 1; i > 0; i--) if (dsq >= tsq[i]) return i
  return 0
}

function newInstancer(n) {
  const { levels, shadowGeo } = makeLevels()
  const scene = new THREE.Scene()
  const inst = createWebGPULodInstancer(scene, levels, Math.max(n, 1), ATTRIBUTE_SCHEMA, {
    hysteresis: LOD_HYSTERESIS,
    shadowGeometry: shadowGeo,
    shadowMaterial: levels[0].material,
    shadowDistance: SHADOW_DISTANCE,
  })
  if (MESH_FAR > 0) inst.setMeshFarDistance(MESH_FAR)
  return inst
}

function buildShape(kind) {
  const instancers = []
  const posById = []
  const extentOf = []
  if (kind === 'real') {
    const per = REAL_PER_INSTANCER
    for (let k = 0; k < REAL_INSTANCERS; k++) {
      const inst = newInstancer(per)
      const map = new Map()
      inst.addInstances(per, (p) => {
        const a = (p.id * 2654435761) >>> 0
        const j = (p.id * 40503 + k * 7919) >>> 0
        const x = ((j % 997) / 997 - 0.5) * REAL_EXTENT
        const z = (((a ^ 0x5bf03635) >>> 0) % 991 / 991 - 0.5) * REAL_EXTENT
        p.position.set(x, 0, z)
        map.set(p.id, [x, 0, z])
      })
      instancers.push(inst); posById.push(map); extentOf.push(REAL_EXTENT)
    }
  } else {
    const n = kind === 'dense10k' ? 10000 : 50000
    const side = Math.max(1, Math.ceil(Math.sqrt(n)))
    const half = (side - 1) * SPACING * 0.5
    const inst = newInstancer(n)
    const map = new Map()
    inst.addInstances(n, (p) => {
      const gx = p.id % side, gz = Math.floor(p.id / side)
      const x = gx * SPACING - half, z = gz * SPACING - half
      p.position.set(x, 0, z)
      map.set(p.id, [x, 0, z])
    })
    instancers.push(inst); posById.push(map); extentOf.push(half * 2)
  }
  return { kind, instancers, posById, extent: Math.max(...extentOf), radius: makeLevels().bounds.radius, center: [0, 6, 0] }
}

function cameraAt(shape, frame, cam) {
  const start = -0.35 * shape.extent
  const travelled = SPEED * DT * frame
  const yaw = Math.PI / 4 + 0.35 * Math.sin(frame * 0.05)
  cam.position.set(start + Math.cos(Math.PI / 4) * travelled, 1.7, start + Math.sin(Math.PI / 4) * travelled)
  cam.rotation.set(0, yaw, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
}

function collectSurvivors(inst) {
  const tierIds = inst.tierIds
  const out = []
  for (let t = 0; t < tierIds.length; t++) {
    const ids = tierIds[t]
    for (let i = 0; i < ids.length; i++) out.push(ids[i] * 8 + t)
  }
  out.sort((a, b) => a - b)
  return out
}

function referenceSurvivors(st) {
  const out = []
  for (const [id] of st.pos) {
    if (st.tier[id] === NO_MESH_TIER || st.culled[id]) continue
    out.push(id * 8 + st.tier[id])
  }
  out.sort((a, b) => a - b)
  return out
}

function advanceReference(st, eye, frustum) {
  const mx = eye.x - st.eye[0], my = eye.y - st.eye[1], mz = eye.z - st.eye[2]
  const moved = st.stale || mx * mx + my * my + mz * mz >= 0.25
  if (moved) { st.eye[0] = eye.x; st.eye[1] = eye.y; st.eye[2] = eye.z; st.stale = false }
  const planes = frustum.planes
  for (const [id, p] of st.pos) {
    let tier = st.tier[id]
    if (moved) {
      const dx = p[0] - eye.x, dy = p[1] - eye.y, dz = p[2] - eye.z
      tier = tierFor(st.tsq, st.meshFarSq, dx * dx + dy * dy + dz * dz)
    }
    let culled = false
    if (tier !== NO_MESH_TIER) {
      const cx = p[0] + st.center[0], cy = p[1] + st.center[1], cz = p[2] + st.center[2]
      for (let q = 0; q < 6; q++) {
        const pl = planes[q]
        if (pl.normal.x * cx + pl.normal.y * cy + pl.normal.z * cz + pl.constant < -st.radius) { culled = true; break }
      }
    }
    st.tier[id] = tier
    st.culled[id] = culled
  }
  return moved
}

function makeRefStates(shape) {
  const tsq = thresholdsSq()
  const meshFarSq = MESH_FAR * MESH_FAR
  return shape.posById.map((pos) => {
    let maxId = 0
    for (const id of pos.keys()) if (id > maxId) maxId = id
    return {
      pos, tsq, meshFarSq, center: shape.center, radius: shape.radius,
      eye: [0, 0, 0], stale: true, tier: new Int8Array(maxId + 8), culled: new Uint8Array(maxId + 8),
    }
  })
}

function buildArm(kind) {
  const shape = buildShape(kind)
  return { shape, refs: makeRefStates(shape), before: shape.instancers.map((i) => ({ ...i.sweepStats })), cpuUs: 0, wallUs: 0, mismatches: 0, firstMismatch: null, movedFrames: 0 }
}

function stepFrame(arm, f, cam, frustum, check, withRef) {
  const insts = arm.shape.instancers
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  for (let k = 0; k < insts.length; k++) insts[k].updateLOD(cam.position, frustum, true)
  const t1 = performance.now()
  const c1 = process.cpuUsage(c0)
  arm.cpuUs += c1.user + c1.system
  arm.wallUs += (t1 - t0) * 1000
  if (!withRef) return
  if (advanceReference(arm.refs[0], cam.position, frustum)) arm.movedFrames++
  for (let k = 1; k < arm.refs.length; k++) advanceReference(arm.refs[k], cam.position, frustum)
  if (!check) return
  for (let k = 0; k < insts.length; k++) {
    const got = collectSurvivors(insts[k])
    const want = referenceSurvivors(arm.refs[k])
    if (got.length !== want.length) {
      arm.mismatches++
      if (!arm.firstMismatch) arm.firstMismatch = { frame: f, instancer: k, got: got.length, want: want.length }
    } else {
      for (let i = 0; i < got.length; i++) {
        if (got[i] !== want[i]) { arm.mismatches++; if (!arm.firstMismatch) arm.firstMismatch = { frame: f, instancer: k, index: i, got: got[i], want: want[i] }; break }
      }
    }
  }
}

function editPhase(arm, cam, frustum, projScreen, frames, withRef) {
  const shape = arm.shape
  const inst0 = shape.instancers[0]
  const ref0 = arm.refs[0]
  const ids = [...shape.posById[0].keys()].slice(0, Math.max(1, Math.floor(shape.posById[0].size * 0.1)))
  for (const id of ids) { inst0.removeInstances(id); shape.posById[0].delete(id) }
  inst0.addInstances(ids.length, (p) => {
    const x = 0.4 * shape.extent + (p.id % 40) * SPACING
    const z = 0.4 * shape.extent + Math.floor(p.id / 40) * SPACING
    p.position.set(x, 0, z)
    shape.posById[0].set(p.id, [x, 0, z])
    ref0.tier[p.id] = 0
    ref0.culled[p.id] = 0
  })
  let editMoved = 0
  for (let f = 0; f < 4; f++) {
    cameraAt(shape, frames + f, cam)
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projScreen)
    for (let k = 0; k < shape.instancers.length; k++) shape.instancers[k].updateLOD(cam.position, frustum, true)
    if (!withRef) continue
    if (advanceReference(arm.refs[0], cam.position, frustum)) editMoved++
    for (let k = 1; k < arm.refs.length; k++) advanceReference(arm.refs[k], cam.position, frustum)
    const got = collectSurvivors(inst0)
    const want = referenceSurvivors(ref0)
    if (got.length !== want.length) { arm.mismatches++; if (!arm.firstMismatch) arm.firstMismatch = { phase: 'placement-edit', frame: f, got: got.length, want: want.length } }
    else for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) { arm.mismatches++; if (!arm.firstMismatch) arm.firstMismatch = { phase: 'placement-edit', frame: f, index: i, got: got[i], want: want[i] }; break }
  }
  return editMoved
}

function runPaired(kind, frames, checkEvery, armCount) {
  const arms = []
  for (let a = 0; a < armCount; a++) arms.push(buildArm(kind))
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000)
  const frustum = new THREE.Frustum()
  const projScreen = new THREE.Matrix4()
  for (let f = 0; f < frames; f++) {
    cameraAt(arms[0].shape, f, cam)
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projScreen)
    const check = checkEvery > 0 && (f % checkEvery === 0 || f === frames - 1)
    for (let a = 0; a < arms.length; a++) stepFrame(arms[a], f, cam, frustum, check && a < REF_ARMS, a < REF_ARMS)
  }
  const total = frames + 4
  return arms.map((arm, a) => {
    const editMoved = editPhase(arm, cam, frustum, projScreen, frames, a < REF_ARMS)
    let walked = 0, tests = 0, calls = 0, survivorsSum = 0
    for (let k = 0; k < arm.shape.instancers.length; k++) {
      const b = arm.before[k], a = arm.shape.instancers[k].sweepStats
      walked += a.recordsWalked - b.recordsWalked
      tests += a.planeTests - b.planeTests
      calls += a.updateCalls - b.updateCalls
      for (let t = 0; t < arm.shape.instancers[k].tierIds.length; t++) survivorsSum += arm.shape.instancers[k].tierIds[t].length
    }
    return {
      shape: kind,
      instancers: arm.shape.instancers.length,
      instances: arm.shape.posById.reduce((s, m) => s + m.size, 0),
      frames: total,
      movedFrames: arm.movedFrames + editMoved,
      updateCallsPerFrame: +(calls / total).toFixed(2),
      planeTestsPerFrame: +(tests / total).toFixed(1),
      recordsPerFrame: +(walked / total).toFixed(1),
      survivorsAtEnd: survivorsSum,
      cpuUsPerFrame: +(arm.cpuUs / frames).toFixed(1),
      wallUsPerFrame: +(arm.wallUs / frames).toFixed(1),
      mismatchCount: arm.mismatches,
      firstMismatch: arm.firstMismatch,
    }
  })
}

function usSummary(arms) {
  const samples = arms.slice(1).map((a) => a.cpuUsPerFrame)
  const min = Math.min(...samples), max = Math.max(...samples)
  return { min, spreadPct: +(((max - min) / min) * 100).toFixed(2), samples }
}

function pctDelta(a, b) { return +(((b - a) / a) * 100).toFixed(2) }

const results = []
let failed = false
const reasons = []

for (const kind of SHAPES) {
  const armCount = Math.max(3, REPEATS)
  const measured = await measureUncontested(`veg-lod-sweep ${kind}`, mark => {
    runPaired(kind, WARMUP, 0, armCount)
    const arms = runPaired(kind, FRAMES, 8, armCount)
    mark()
    return { arms }
  }, { retries: CONTEST_RETRIES })
  const arms = measured.arms
  const control = {
    planeTests: pctDelta(arms[1].planeTestsPerFrame, arms[2].planeTestsPerFrame),
    records: pctDelta(arms[1].recordsPerFrame, arms[2].recordsPerFrame),
    us: pctDelta(arms[1].cpuUsPerFrame, arms[2].cpuUsPerFrame),
  }
  const row = { shape: kind, arm: arms[1], controlArm: arms[2], controlDeltaPct: control, warmupArm: arms[0], us: usSummary(arms), ...fingerprintFields(measured) }
  results.push(row)
  console.log(`${kind}: ${formatRowContention(row)}`)
  for (const a of arms) if (a.mismatchCount > 0) { failed = true; reasons.push(`${kind}: surviving set differs from the brute-force sweep (${a.mismatchCount} mismatches, first ${JSON.stringify(a.firstMismatch)})`) }
  if (row.contested) { failed = true; reasons.push(`${kind}: ${describeContested([row], CONTEST_RETRIES)}`) }
  console.log(`shape=${kind} instances=${arms[1].instances} instancers=${arms[1].instancers} records/frame=${arms[1].recordsPerFrame} planeTests/frame=${arms[1].planeTestsPerFrame} cpuUs/frame=${arms[1].cpuUsPerFrame} wallUs/frame=${arms[1].wallUsPerFrame} survivors=${arms[1].survivorsAtEnd} controlDeltaPct=${JSON.stringify(control)}`)
}

const byShape = new Map(results.map((r) => [r.shape, r]))
const scalingPair = ['dense10k', 'dense50k'].map((s) => byShape.get(s)).filter(Boolean)
if (scalingPair.length === 2) {
  const [lo, hi] = scalingPair
  const countRatio = hi.arm.instances / lo.arm.instances
  const survivorRatio = hi.arm.survivorsAtEnd / lo.arm.survivorsAtEnd
  const recordsRatio = hi.arm.recordsPerFrame / lo.arm.recordsPerFrame
  const planeRatio = hi.arm.planeTestsPerFrame / lo.arm.planeTestsPerFrame
  const logGap = (cost, ref) => Math.abs(Math.log(cost / ref))
  const scaling = {
    countRatio: +countRatio.toFixed(2),
    survivorRatio: +survivorRatio.toFixed(2),
    recordsRatio: +recordsRatio.toFixed(2),
    planeTestsRatio: +planeRatio.toFixed(2),
    recordsGapToSurvivor: +logGap(recordsRatio, survivorRatio).toFixed(3),
    recordsGapToCount: +logGap(recordsRatio, countRatio).toFixed(3),
    planeGapToSurvivor: +logGap(planeRatio, survivorRatio).toFixed(3),
    planeGapToCount: +logGap(planeRatio, countRatio).toFixed(3),
  }
  for (const r of results) r.scaling = scaling
  console.log('scaling: ' + JSON.stringify(scaling))
  if (scaling.recordsGapToSurvivor >= scaling.recordsGapToCount) { failed = true; reasons.push(`records walked ratio ${scaling.recordsRatio} is no closer to the survivor ratio ${scaling.survivorRatio} than to the count ratio ${scaling.countRatio}: cost still tracks total instances`) }
  if (scaling.planeGapToSurvivor >= scaling.planeGapToCount) { failed = true; reasons.push(`plane test ratio ${scaling.planeTestsRatio} is no closer to the survivor ratio ${scaling.survivorRatio} than to the count ratio ${scaling.countRatio}: cost still tracks total instances`) }
}

if (BASELINE) {
  const base = JSON.parse(readFileSync(resolve(ROOT, BASELINE), 'utf8'))
  for (const row of results) {
    const b = base.results.find((r) => r.shape === row.shape)
    if (!b) { failed = true; reasons.push(`no baseline arm for shape ${row.shape}`); continue }
    const dPlane = pctDelta(b.arm.planeTestsPerFrame, row.arm.planeTestsPerFrame)
    const dRec = pctDelta(b.arm.recordsPerFrame, row.arm.recordsPerFrame)
    const baseUs = usSummary([null, b.arm, b.controlArm])
    const dUsMin = pctDelta(baseUs.min, row.us.min)
    const noiseFloor = Math.max(baseUs.spreadPct, row.us.spreadPct)
    row.vsBaselinePct = { planeTests: dPlane, records: dRec, usMin: dUsMin }
    row.usNoiseFloorPct = noiseFloor
    console.log(`shape=${row.shape} vs baseline: planeTests ${dPlane}% records ${dRec}% us/frame(min) ${dUsMin}% noiseFloor ${noiseFloor}%`)
    if (noiseFloor > US_NOISE_LIMIT) console.log(`shape=${row.shape} us/frame unmeasured: arm spread ${baseUs.spreadPct}% / ${row.us.spreadPct}% exceeds ${US_NOISE_LIMIT}%, decision rests on work units`)
    if (row.shape === 'dense10k') {
      if (dPlane > -REQUIRE_DROP) { failed = true; reasons.push(`plane tests at dense10k dropped only ${-dPlane}% (need >= ${REQUIRE_DROP}%)`) }
      if (dRec > -REQUIRE_DROP) { failed = true; reasons.push(`records walked at dense10k dropped only ${-dRec}% (need >= ${REQUIRE_DROP}%)`) }
      if (Math.abs(row.controlDeltaPct.planeTests) > REQUIRE_DROP / 2 || Math.abs(row.controlDeltaPct.records) > REQUIRE_DROP / 2) { failed = true; reasons.push(`control arm noise exceeds half the required drop: ${JSON.stringify(row.controlDeltaPct)}`) }
      if (noiseFloor <= US_NOISE_LIMIT && dUsMin > -noiseFloor) { failed = true; reasons.push(`us/frame(min) at dense10k improved only ${-dUsMin}% which is inside the ${noiseFloor}% noise floor`) }
    }
    if (row.shape === 'real' && row.arm.recordsPerFrame > b.arm.recordsPerFrame) { failed = true; reasons.push(`real-shape records walked rose ${b.arm.recordsPerFrame} -> ${row.arm.recordsPerFrame}`) }
    if (row.shape === 'real' && noiseFloor <= US_NOISE_LIMIT && dUsMin > noiseFloor) { failed = true; reasons.push(`real-shape sweep regressed ${dUsMin}% cpu/frame(min) (noise floor ${noiseFloor}%) with planeTests ${b.arm.planeTestsPerFrame} -> ${row.arm.planeTestsPerFrame} and records ${b.arm.recordsPerFrame} -> ${row.arm.recordsPerFrame}`) }
    const survivorDelta = Math.abs(row.arm.survivorsAtEnd - b.arm.survivorsAtEnd)
    if (survivorDelta > Math.max(2, b.arm.survivorsAtEnd * 0.01)) { failed = true; reasons.push(`shape ${row.shape}: survivor count moved ${b.arm.survivorsAtEnd} -> ${row.arm.survivorsAtEnd}`) }
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const outPath = resolve(OUT_DIR, LABEL + '.json')
const payload = { label: LABEL, generatedAt: new Date().toISOString(), frames: FRAMES, warmup: WARMUP, spacing: SPACING, speed: SPEED, meshFar: MESH_FAR, results }
writeFileSync(outPath, JSON.stringify(payload, null, 2))

if (failed) for (const r of reasons) console.log('FAIL: ' + r)
console.log('RESULT: ' + (failed ? 'FAIL' : 'PASS'))
console.log('json: ' + outPath)
process.exit(failed ? 1 : 0)
