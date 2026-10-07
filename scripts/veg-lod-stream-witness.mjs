#!/usr/bin/env node
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { measureUncontested, fingerprintFields, describeContested } from './lib/timing-gate.mjs'

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

const MODULE = flag('module', '../client/core/WebGPULodInstancer.js')
const MODULE_URL = /^(file|data|node|https?):/.test(MODULE) ? MODULE : pathToFileURL(resolve(__dirname, MODULE)).href
const { createWebGPULodInstancer } = await import(MODULE_URL)

const SHAPES = flag('shapes', 'dense2k,real90').split(',').map((s) => s.trim()).filter(Boolean)
const FRAMES = Number(flag('frames', '400'))
const WARMUP = Number(flag('warmup', '120'))
const SPACING = Number(flag('spacing', '3'))
const SPEED = Number(flag('speed', '7'))
const MESH_FAR = Number(flag('mesh-far', '90'))
const ADDS_PER_FRAME = Number(flag('adds-per-frame', '4'))
const REPEATS = Number(flag('repeats', '5'))
const CONTEST_RETRIES = Number(flag('contest-retries', '3'))
const REQUIRE_DROP = Number(flag('require-drop', '50'))
const MAX_VISITS_PER_LIVE = Number(flag('max-visits-per-live', '0.6'))
const LABEL = flag('label', 'veg-lod-stream-' + Date.now())
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
const DENSE_COUNT = 2000

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

const thresholdsSq = LOD_DISTANCES.map((d) => { const t = d - d * LOD_HYSTERESIS; return t * t })
const MESH_FAR_SQ = MESH_FAR * MESH_FAR

function tierFor(dsq) {
  if (dsq >= MESH_FAR_SQ) return NO_MESH_TIER
  for (let i = thresholdsSq.length - 1; i > 0; i--) if (dsq >= thresholdsSq[i]) return i
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
  if (kind === 'real90') {
    for (let k = 0; k < REAL_INSTANCERS; k++) {
      const inst = newInstancer(REAL_PER_INSTANCER * 3)
      const map = new Map()
      inst.addInstances(REAL_PER_INSTANCER, (p) => {
        const a = (p.id * 2654435761) >>> 0
        const j = (p.id * 40503 + k * 7919) >>> 0
        const x = ((j % 997) / 997 - 0.5) * REAL_EXTENT
        const z = (((a ^ 0x5bf03635) >>> 0) % 991 / 991 - 0.5) * REAL_EXTENT
        p.position.set(x, 0, z)
        map.set(p.id, [x, 0, z])
      })
      instancers.push(inst); posById.push(map)
    }
    return { kind, instancers, posById, extent: REAL_EXTENT, radius: makeLevels().bounds.radius, center: [0, 6, 0] }
  }
  const inst = newInstancer(DENSE_COUNT * 3)
  const side = Math.max(1, Math.ceil(Math.sqrt(DENSE_COUNT)))
  const half = (side - 1) * SPACING * 0.5
  const map = new Map()
  inst.addInstances(DENSE_COUNT, (p) => {
    const x = (p.id % side) * SPACING - half
    const z = Math.floor(p.id / side) * SPACING - half
    p.position.set(x, 0, z)
    map.set(p.id, [x, 0, z])
  })
  instancers.push(inst); posById.push(map)
  return { kind, instancers, posById, extent: half * 2, radius: makeLevels().bounds.radius, center: [0, 6, 0] }
}

function makeRefStates(shape) {
  return shape.posById.map((pos) => {
    let maxId = 0
    for (const id of pos.keys()) if (id > maxId) maxId = id
    const cap = Math.max(maxId + 1, 64)
    return { pos, tier: new Int8Array(cap), culled: new Uint8Array(cap), eye: [0, 0, 0], stale: true }
  })
}

function refEnsure(st, id) {
  if (id < st.tier.length) return
  let cap = st.tier.length
  while (cap <= id) cap *= 2
  const tier = new Int8Array(cap)
  tier.set(st.tier)
  st.tier = tier
  const culled = new Uint8Array(cap)
  culled.set(st.culled)
  st.culled = culled
}

function advanceReference(st, eye, frustum, shape) {
  const mx = eye.x - st.eye[0], my = eye.y - st.eye[1], mz = eye.z - st.eye[2]
  const moved = st.stale || mx * mx + my * my + mz * mz >= 0.25
  if (moved) { st.eye[0] = eye.x; st.eye[1] = eye.y; st.eye[2] = eye.z; st.stale = false }
  const e = st.eye
  const planes = frustum.planes
  for (const [id, p] of st.pos) {
    const dx = p[0] - e[0], dy = p[1] - e[1], dz = p[2] - e[2]
    const tier = tierFor(dx * dx + dy * dy + dz * dz)
    let culled = false
    if (tier !== NO_MESH_TIER) {
      const cx = p[0] + shape.center[0], cy = p[1] + shape.center[1], cz = p[2] + shape.center[2]
      for (let q = 0; q < 6; q++) {
        const pl = planes[q]
        if (pl.normal.x * cx + pl.normal.y * cy + pl.normal.z * cz + pl.constant < -shape.radius) { culled = true; break }
      }
    }
    st.tier[id] = tier
    st.culled[id] = culled
  }
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

function cameraAt(shape, frame, cam) {
  const start = -0.35 * shape.extent
  const travelled = SPEED * DT * frame
  cam.position.set(start + Math.cos(Math.PI / 4) * travelled, 1.7, start + Math.sin(Math.PI / 4) * travelled)
  cam.rotation.set(0, Math.PI / 4 + 0.35 * Math.sin(frame * 0.05), 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
}

function streamAdds(shape, states, frame) {
  const perInstancer = ADDS_PER_FRAME
  if (perInstancer <= 0) return 0
  let added = 0
  for (let k = 0; k < shape.instancers.length; k++) {
    const inst = shape.instancers[k]
    const map = shape.posById[k]
    inst.addInstances(perInstancer, (p) => {
      const h = (p.id * 2654435761 + frame * 40503) >>> 0
      const x = ((h % 1009) / 1009 - 0.5) * shape.extent
      const z = (((h >>> 10) % 1013) / 1013 - 0.5) * shape.extent
      p.position.set(x, 0, z)
      map.set(p.id, [x, 0, z])
      refEnsure(states[k], p.id)
      added++
    })
    if (perInstancer > 0) states[k].stale = true
  }
  return added
}

function decodeKey(v) { const id = Math.floor(v / 8); return { id, tier: v - id * 8 } }

function compareArm(arm, phase, frame) {
  for (let k = 0; k < arm.shape.instancers.length; k++) {
    const got = collectSurvivors(arm.shape.instancers[k])
    const want = referenceSurvivors(arm.refs[k])
    if (got.length !== want.length) {
      arm.mismatches++
      if (!arm.firstMismatch) arm.firstMismatch = { phase, frame, instancer: k, gotLen: got.length, wantLen: want.length }
      continue
    }
    for (let i = 0; i < got.length; i++) {
      if (got[i] !== want[i]) {
        arm.mismatches++
        if (!arm.firstMismatch) arm.firstMismatch = { phase, frame, instancer: k, index: i, got: decodeKey(got[i]), want: decodeKey(want[i]) }
        break
      }
    }
  }
}

function buildArm(kind, hasRef) {
  const shape = buildShape(kind)
  return {
    shape, hasRef,
    refs: makeRefStates(shape),
    before: shape.instancers.map((i) => ({ ...i.sweepStats })),
    cpuUs: 0, wallUs: 0,
    mismatches: 0, firstMismatch: null,
    teleportMismatches: 0, recycleMismatches: 0,
  }
}

function stepFrame(arm, f, cam, frustum, check, withRef) {
  const insts = arm.shape.instancers
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  streamAdds(arm.shape, arm.refs, f)
  for (let k = 0; k < insts.length; k++) insts[k].updateLOD(cam.position, frustum, true)
  const t1 = performance.now()
  arm.cpuUs += process.cpuUsage(c0).user + process.cpuUsage(c0).system
  arm.wallUs += (t1 - t0) * 1000
  if (!withRef) return
  for (let k = 0; k < arm.refs.length; k++) advanceReference(arm.refs[k], cam.position, frustum, arm.shape)
  if (check) compareArm(arm, 'stream', f)
}

function teleportPhase(arm, cam, frustum, projScreen, frame) {
  const shape = arm.shape
  const corners = [
    [0.45 * shape.extent, 1.7, 0.45 * shape.extent],
    [-0.45 * shape.extent, 1.7, -0.45 * shape.extent],
    [0.45 * shape.extent, 1.7, -0.45 * shape.extent],
  ]
  let first = true
  let maxWalk = 0
  for (const c of corners) {
    cam.position.set(c[0], c[1], c[2])
    cam.rotation.set(0, first ? Math.PI : 0, 0)
    first = false
    cam.updateMatrixWorld(true)
    cam.updateProjectionMatrix()
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projScreen)
    const before = arm.shape.instancers.map((i) => ({ ...i.sweepStats }))
    for (let k = 0; k < shape.instancers.length; k++) shape.instancers[k].updateLOD(cam.position, frustum, true)
    for (let k = 0; k < shape.instancers.length; k++) {
      const d = shape.instancers[k].sweepStats.recordsWalked - before[k].recordsWalked
      if (d > maxWalk) maxWalk = d
    }
    for (let k = 0; k < arm.refs.length; k++) advanceReference(arm.refs[k], cam.position, frustum, shape)
    if (!arm.hasRef) continue
    const beforeCount = arm.mismatches
    compareArm(arm, 'teleport', frame)
    arm.teleportMismatches += arm.mismatches - beforeCount
  }
  return maxWalk
}

function recyclePhase(arm, cam, frustum, projScreen, frame) {
  const shape = arm.shape
  const inst0 = shape.instancers[0]
  const ids = [...shape.posById[0].keys()].slice(0, Math.max(1, Math.floor(shape.posById[0].size * 0.1)))
  for (const id of ids) { inst0.removeInstances(id); shape.posById[0].delete(id) }
  arm.refs[0].stale = true
  inst0.addInstances(ids.length, (p) => {
    const x = 0.2 * shape.extent + (p.id % 40) * SPACING
    const z = 0.2 * shape.extent + Math.floor(p.id / 40) * SPACING
    p.position.set(x, 0, z)
    shape.posById[0].set(p.id, [x, 0, z])
    refEnsure(arm.refs[0], p.id)
  })
  const beforeCount = arm.mismatches
  for (let f = 0; f < 4; f++) {
    cameraAt(shape, frame + f, cam)
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projScreen)
    for (let k = 0; k < shape.instancers.length; k++) shape.instancers[k].updateLOD(cam.position, frustum, true)
    for (let k = 0; k < arm.refs.length; k++) advanceReference(arm.refs[k], cam.position, frustum, shape)
    if (arm.hasRef) compareArm(arm, 'recycle', frame + f)
  }
  if (arm.hasRef) arm.recycleMismatches += arm.mismatches - beforeCount
  return ids.length
}

function runPaired(kind, frames, checkEvery, armCount) {
  const arms = []
  for (let a = 0; a < armCount; a++) arms.push(buildArm(kind, a === 0))
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000)
  const frustum = new THREE.Frustum()
  const projScreen = new THREE.Matrix4()
  for (let f = 0; f < frames; f++) {
    cameraAt(arms[0].shape, f, cam)
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    frustum.setFromProjectionMatrix(projScreen)
    const check = checkEvery > 0 && (f % checkEvery === 0 || f === frames - 1)
    for (let a = 0; a < arms.length; a++) stepFrame(arms[a], f, cam, frustum, check && a === 0, a === 0)
  }
  return arms.map((arm, a) => {
    const maxTeleportWalk = teleportPhase(arm, cam, frustum, projScreen, frames)
    const recycled = recyclePhase(arm, cam, frustum, projScreen, frames + 8)
    const total = frames + 8
    let walked = 0, tests = 0, rebuilds = 0, rebuildRecords = 0, survivorsSum = 0
    for (let k = 0; k < arm.shape.instancers.length; k++) {
      const b = arm.before[k], s = arm.shape.instancers[k].sweepStats
      walked += s.recordsWalked - b.recordsWalked
      tests += s.planeTests - b.planeTests
      rebuilds += (s.rebuilds || 0) - (b.rebuilds || 0)
      rebuildRecords += (s.rebuildRecords || 0) - (b.rebuildRecords || 0)
      for (let t = 0; t < arm.shape.instancers[k].tierIds.length; t++) survivorsSum += arm.shape.instancers[k].tierIds[t].length
    }
    return {
      shape: kind,
      instancers: arm.shape.instancers.length,
      instances: arm.shape.posById.reduce((s, m) => s + m.size, 0),
      frames: total,
      planeTestsPerFrame: +(tests / total).toFixed(1),
      recordsPerFrame: +(walked / total).toFixed(1),
      rebuildRecordsPerFrame: +(rebuildRecords / total).toFixed(1),
      rebuildsPerFrame: +(rebuilds / total).toFixed(3),
      rebuildRecordsPerRebuild: rebuilds > 0 ? +(rebuildRecords / rebuilds).toFixed(1) : 0,
      visitsPerFrame: +((walked + rebuildRecords) / total).toFixed(1),
      survivorsAtEnd: survivorsSum,
      maxTeleportRecords: maxTeleportWalk,
      recycledIds: recycled,
      cpuUsPerFrame: +(arm.cpuUs / frames).toFixed(1),
      wallUsPerFrame: +(arm.wallUs / frames).toFixed(1),
      mismatchCount: arm.mismatches,
      teleportMismatches: arm.teleportMismatches,
      recycleMismatches: arm.recycleMismatches,
      firstMismatch: arm.firstMismatch,
    }
  })
}

function pctDelta(a, b) { return a === 0 ? (b === 0 ? 0 : 100) : +(((b - a) / a) * 100).toFixed(2) }

const results = []
let failed = false
const reasons = []

for (const kind of SHAPES) {
  const armCount = Math.max(3, REPEATS)
  const measured = await measureUncontested(`veg-lod-stream ${kind}`, mark => {
    runPaired(kind, WARMUP, 0, armCount)
    const arms = runPaired(kind, FRAMES, 8, armCount)
    mark()
    return { arms }
  }, { retries: CONTEST_RETRIES })
  const arms = measured.arms
  const control = {
    planeTests: pctDelta(arms[0].planeTestsPerFrame, arms[1].planeTestsPerFrame),
    records: pctDelta(arms[0].recordsPerFrame, arms[1].recordsPerFrame),
  }
  const visitsPerLive = +(arms[0].visitsPerFrame / arms[0].instances).toFixed(3)
  const row = { shape: kind, arm: arms[0], controlArm: arms[1], controlDeltaPct: control, visitsPerLive, ...fingerprintFields(measured) }
  results.push(row)
  console.log(`shape=${kind} instancers=${arms[0].instancers} instances=${arms[0].instances} visits/frame=${arms[0].visitsPerFrame} records/frame=${arms[0].recordsPerFrame} rebuildRecords/frame=${arms[0].rebuildRecordsPerFrame} rebuilds/frame=${arms[0].rebuildsPerFrame} planeTests/frame=${arms[0].planeTestsPerFrame} maxTeleportRecords=${arms[0].maxTeleportRecords} survivors=${arms[0].survivorsAtEnd} visitsPerLive=${visitsPerLive} controlDeltaPct=${JSON.stringify(control)}`)
  for (const a of arms) {
    if (a.mismatchCount > 0) { failed = true; reasons.push(`${kind}: surviving set differs from the brute-force sweep (${a.mismatchCount} mismatches, first ${JSON.stringify(a.firstMismatch)})`) }
    if (a.teleportMismatches > 0) { failed = true; reasons.push(`${kind}: ${a.teleportMismatches} survivor mismatches after a camera teleport across the extent`) }
    if (a.recycleMismatches > 0) { failed = true; reasons.push(`${kind}: ${a.recycleMismatches} survivor mismatches after removing and re-adding instances through recycled ids`) }
  }
  if (row.contested) { failed = true; reasons.push(`${kind}: ${describeContested([row], CONTEST_RETRIES)}`) }
  if (visitsPerLive > MAX_VISITS_PER_LIVE) {
    failed = true
    reasons.push(`${kind}: ${arms[0].visitsPerFrame} instance visits per frame over ${arms[0].instances} live instances is ${visitsPerLive} visits per live instance, above the amortized bound ${MAX_VISITS_PER_LIVE}`)
  }
}

if (BASELINE) {
  const base = JSON.parse(readFileSync(resolve(ROOT, BASELINE), 'utf8'))
  for (const row of results) {
    const b = base.results.find((r) => r.shape === row.shape)
    if (!b) { failed = true; reasons.push(`no baseline arm for shape ${row.shape}`); continue }
    const dRec = pctDelta(b.arm.recordsPerFrame, row.arm.recordsPerFrame)
    const dReb = pctDelta(b.arm.rebuildRecordsPerFrame, row.arm.rebuildRecordsPerFrame)
    const dPlane = pctDelta(b.arm.planeTestsPerFrame, row.arm.planeTestsPerFrame)
    const dVisits = pctDelta(b.arm.visitsPerFrame, row.arm.visitsPerFrame)
    row.vsBaselinePct = { records: dRec, rebuildRecords: dReb, planeTests: dPlane, visits: dVisits }
    console.log(`shape=${row.shape} vs baseline: visits ${dVisits}% records ${dRec}% rebuildRecords ${dReb}% planeTests ${dPlane}%`)
    if (dVisits > -REQUIRE_DROP) { failed = true; reasons.push(`shape ${row.shape}: instance visits per frame dropped only ${-dVisits}% (need >= ${REQUIRE_DROP}%)`) }
    if (dReb > -REQUIRE_DROP) { failed = true; reasons.push(`shape ${row.shape}: rebuild records dropped only ${-dReb}% (need >= ${REQUIRE_DROP}%)`) }
    if (Math.abs(row.controlDeltaPct.records) > REQUIRE_DROP / 2 || Math.abs(row.controlDeltaPct.planeTests) > REQUIRE_DROP / 2) { failed = true; reasons.push(`shape ${row.shape}: control arm noise exceeds half the required drop: ${JSON.stringify(row.controlDeltaPct)}`) }
    const survivorDelta = Math.abs(row.arm.survivorsAtEnd - b.arm.survivorsAtEnd)
    if (survivorDelta > Math.max(2, b.arm.survivorsAtEnd * 0.01)) { failed = true; reasons.push(`shape ${row.shape}: survivor count moved ${b.arm.survivorsAtEnd} -> ${row.arm.survivorsAtEnd}`) }
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const outPath = resolve(OUT_DIR, LABEL + '.json')
writeFileSync(outPath, JSON.stringify({ label: LABEL, generatedAt: new Date().toISOString(), frames: FRAMES, warmup: WARMUP, spacing: SPACING, speed: SPEED, meshFar: MESH_FAR, addsPerFrame: ADDS_PER_FRAME, results }, null, 2))

if (failed) for (const r of reasons) console.log('FAIL: ' + r)
console.log('RESULT: ' + (failed ? 'FAIL' : 'PASS'))
console.log('json: ' + outPath)
process.exit(failed ? 1 : 0)
