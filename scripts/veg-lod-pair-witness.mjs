#!/usr/bin/env node
import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'

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

const PAIRS = Number(flag('pairs', '4'))
const TREES = Number(flag('trees', '1500'))
const FRAMES = Number(flag('frames', '120'))
const CHURN = Number(flag('churn', '0.1'))
const HIDDEN = Number(flag('hidden', '0.05'))
const EXTENT = Number(flag('extent', '900'))
const SPEED = Number(flag('speed', '45'))
const MESH_FAR = Number(flag('mesh-far', '90'))
const CHECK_EVERY = Number(flag('check-every', '8'))
const SHARE_MAX_FRAC = Number(flag('share-max-frac', '0.52'))
const DT = 1 / 60

const LOD_DISTANCES = [0, 14, 35]
const LOD_HYSTERESIS = 0.12
const SHADOW_DISTANCE = 35
const ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'vec3' }
const NO_MESH_TIER = -1
const LOD_REEVAL_MOVE_SQ = 0.5 * 0.5

const failures = []
const fail = (m) => { if (failures.length < 24) failures.push(m) }
function expect(ok, m) { if (!ok) fail(m) }

const BOUNDS = (() => {
  const g = new THREE.BoxGeometry(6, 12, 6)
  g.translate(0, 6, 0)
  g.computeBoundingSphere()
  return g.boundingSphere.clone()
})()
const BOUNDS_CENTER = [BOUNDS.center.x, BOUNDS.center.y, BOUNDS.center.z]
const BOUNDS_RADIUS = BOUNDS.radius

function levelsFor(withShadow) {
  const levels = []
  for (let i = 0; i < LOD_DISTANCES.length; i++) {
    const g = new THREE.BoxGeometry(6 - i * 1.5, 12 - i * 3, 6 - i * 1.5)
    g.translate(0, 6, 0)
    g.boundingSphere = BOUNDS.clone()
    levels.push({ geometry: g, material: new THREE.MeshStandardMaterial(), distance: LOD_DISTANCES[i] })
  }
  let shadowGeo = null
  if (withShadow) {
    shadowGeo = new THREE.BoxGeometry(1.5, 3, 1.5)
    shadowGeo.translate(0, 6, 0)
    shadowGeo.boundingSphere = BOUNDS.clone()
  }
  return { levels, shadowGeo }
}

function makeBranch(scene) {
  const { levels, shadowGeo } = levelsFor(true)
  const inst = createWebGPULodInstancer(scene, levels, Math.max(TREES, 1), ATTRIBUTE_SCHEMA, {
    hysteresis: LOD_HYSTERESIS,
    shadowGeometry: shadowGeo,
    shadowMaterial: levels[0].material,
    shadowDistance: SHADOW_DISTANCE,
  })
  inst.setMeshFarDistance(MESH_FAR)
  return inst
}

function makeLeaf(scene, host) {
  const { levels } = levelsFor(false)
  const inst = createWebGPULodInstancer(scene, levels, Math.max(TREES, 1), ATTRIBUTE_SCHEMA, {
    hysteresis: LOD_HYSTERESIS,
    host: host || null,
  })
  inst.setMeshFarDistance(MESH_FAR)
  return inst
}

function treePos(tree, pair) {
  const a = (tree * 2654435761 + pair * 40503 + 12345) >>> 0
  const x = (((a >>> 3) % 9973) / 9973 - 0.5) * EXTENT
  const z = ((((a >>> 11) ^ 0x5bf03635) >>> 0) % 9967 / 9967 - 0.5) * EXTENT
  return [x, 0, z]
}

function makePairKind(pair, shared) {
  const scene = new THREE.Scene()
  const branch = makeBranch(scene)
  const leaf = makeLeaf(scene, shared ? branch : undefined)
  const branchIdOf = new Int32Array(TREES).fill(-1)
  const leafIdOf = new Int32Array(TREES).fill(-1)
  const posOf = new Float64Array(TREES * 3)
  for (let t = 0; t < TREES; t++) {
    const p = treePos(t, pair)
    posOf[t * 3] = p[0]; posOf[t * 3 + 1] = p[1]; posOf[t * 3 + 2] = p[2]
  }
  return { pair, shared, branch, leaf, branchIdOf, leafIdOf, posOf }
}

function addAll(kind) {
  const place = (inst, idOf) => {
    let c = 0
    inst.addInstances(TREES, (e) => {
      const t = c++
      e.position.set(kind.posOf[t * 3], kind.posOf[t * 3 + 1], kind.posOf[t * 3 + 2])
      idOf[t] = e.id
    })
  }
  place(kind.branch, kind.branchIdOf)
  place(kind.leaf, kind.leafIdOf)
}

const THRESHOLDS_SQ = LOD_DISTANCES.map((d) => { const t = d - d * LOD_HYSTERESIS; return t * t })
const MESH_FAR_SQ = MESH_FAR * MESH_FAR

function referenceTier(dsq) {
  if (dsq >= MESH_FAR_SQ) return NO_MESH_TIER
  for (let i = THRESHOLDS_SQ.length - 1; i > 0; i--) if (dsq >= THRESHOLDS_SQ[i]) return i
  return 0
}

function makeReference(kind) {
  return {
    kind,
    eye: [0, 0, 0],
    stale: true,
    tier: new Int8Array(TREES).fill(NO_MESH_TIER),
    culled: new Uint8Array(TREES),
    visible: new Uint8Array(TREES).fill(1),
  }
}

function advanceReference(ref, eye, frustum) {
  const dx = eye.x - ref.eye[0], dy = eye.y - ref.eye[1], dz = eye.z - ref.eye[2]
  const moved = ref.stale || dx * dx + dy * dy + dz * dz >= LOD_REEVAL_MOVE_SQ
  if (moved) { ref.eye[0] = eye.x; ref.eye[1] = eye.y; ref.eye[2] = eye.z; ref.stale = false }
  const planes = frustum ? frustum.planes : null
  for (let t = 0; t < TREES; t++) {
    if (ref.kind.branchIdOf[t] < 0 || ref.kind.leafIdOf[t] < 0) continue
    const px = ref.kind.posOf[t * 3], py = ref.kind.posOf[t * 3 + 1], pz = ref.kind.posOf[t * 3 + 2]
    if (moved) {
      const ddx = px - eye.x, ddy = py - eye.y, ddz = pz - eye.z
      ref.tier[t] = referenceTier(ddx * ddx + ddy * ddy + ddz * ddz)
    }
    let culled = false
    if (planes && ref.tier[t] !== NO_MESH_TIER) {
      const cx = px + BOUNDS_CENTER[0], cy = py + BOUNDS_CENTER[1], cz = pz + BOUNDS_CENTER[2]
      for (let q = 0; q < 6; q++) {
        const pl = planes[q]
        if (pl.normal.x * cx + pl.normal.y * cy + pl.normal.z * cz + pl.constant < -BOUNDS_RADIUS) { culled = true; break }
      }
    }
    ref.culled[t] = culled ? 1 : 0
  }
  return moved
}

function drawnTierOf(inst, idOf) {
  const treeOf = new Map()
  for (let t = 0; t < TREES; t++) if (idOf[t] >= 0) treeOf.set(idOf[t], t)
  const out = new Int8Array(TREES).fill(NO_MESH_TIER)
  const tiers = inst.tierIds
  for (let ti = 0; ti < tiers.length; ti++) {
    const ids = tiers[ti]
    for (let i = 0; i < ids.length; i++) {
      const t = treeOf.get(ids[i])
      if (t === undefined) { fail(`tier ${ti} holds id ${ids[i]} that no tree maps to`); continue }
      out[t] = ti
    }
  }
  return out
}

function wantTierOf(ref) {
  const out = new Int8Array(TREES).fill(NO_MESH_TIER)
  for (let t = 0; t < TREES; t++) {
    if (!ref.visible[t] || ref.culled[t] || ref.tier[t] === NO_MESH_TIER) continue
    out[t] = ref.tier[t]
  }
  return out
}

function compareTiers(label, got, want, kind) {
  let first = null
  let n = 0
  for (let t = 0; t < TREES; t++) {
    if (got[t] === want[t]) continue
    n++
    if (first === null) first = { tree: t, got: got[t], want: want[t] }
  }
  if (n > 0) fail(`${label}: ${n} tree(s) drawn at the wrong LOD tier, first ${JSON.stringify(first)}`)
  return { label, mismatches: n }
}

function snapshotStats(kinds) {
  const acc = { updateCalls: 0, recordsWalked: 0, planeTests: 0, cellsTested: 0, cellsSkipped: 0, rebuilds: 0, rebuildRecords: 0, mirrored: 0 }
  for (const k of kinds) for (const inst of [k.branch, k.leaf]) {
    const s = inst.sweepStats
    for (const key in acc) acc[key] += s[key]
  }
  return acc
}

function buildArm(shared) {
  const kinds = []
  for (let p = 0; p < PAIRS; p++) kinds.push(makePairKind(p, shared))
  for (const k of kinds) addAll(k)
  return { shared, kinds, refs: kinds.map(makeReference), stats0: snapshotStats(kinds) }
}

function stepArm(arm, cam, frustum, viewChanged, withRef) {
  for (const k of arm.kinds) {
    k.branch.updateLOD(cam.position, frustum, viewChanged)
    k.leaf.updateLOD(cam.position, frustum, viewChanged)
  }
  if (!withRef) return 0
  let moved = 0
  for (const ref of arm.refs) if (advanceReference(ref, cam.position, frustum)) moved++
  return moved
}

function checkArm(arm, label, frame) {
  for (let i = 0; i < arm.kinds.length; i++) {
    const k = arm.kinds[i], ref = arm.refs[i]
    const want = wantTierOf(ref)
    const armTag = `${label} pair${i} frame${frame}`
    compareTiers(`${armTag} branch`, drawnTierOf(k.branch, k.branchIdOf), want, k)
    compareTiers(`${armTag} leaf`, drawnTierOf(k.leaf, k.leafIdOf), want, k)
  }
}

function decidePerTree(arm) {
  const out = []
  for (let i = 0; i < arm.kinds.length; i++) {
    const k = arm.kinds[i]
    out.push({ branch: drawnTierOf(k.branch, k.branchIdOf), leaf: drawnTierOf(k.leaf, k.leafIdOf) })
  }
  return out
}

function sameDecisions(a, b, label) {
  let n = 0
  let first = null
  for (let i = 0; i < a.length; i++) {
    for (const side of ['branch', 'leaf']) {
      const x = a[i][side], y = b[i][side]
      for (let t = 0; t < TREES; t++) {
        if (x[t] === y[t]) continue
        n++
        if (first === null) first = { pair: i, side, tree: t, a: x[t], b: y[t] }
      }
    }
  }
  if (n > 0) fail(`${label}: ${n} tree(s) changed LOD decision between arms, first ${JSON.stringify(first)}`)
  return n
}

function survivorCount(arm, side) {
  let n = 0
  for (const k of arm.kinds) {
    const ids = side === 'branch' ? k.branch.tierIds : k.leaf.tierIds
    for (const list of ids) n += list.length
  }
  return n
}

function shadowCount(arm) {
  let n = 0
  for (const k of arm.kinds) n += k.branch.shadowActiveCount
  return n
}

function churnArm(arm, count, permanent) {
  const n = Math.max(1, Math.floor(TREES * count))
  for (const k of arm.kinds) {
    for (let t = 0; t < n; t++) {
      k.branch.removeInstances(k.branchIdOf[t])
      k.leaf.removeInstances(k.leafIdOf[t])
      k.branchIdOf[t] = -1
      k.leafIdOf[t] = -1
    }
    if (permanent) {
      for (const ref of arm.refs) if (ref.kind === k) for (let t = 0; t < n; t++) ref.visible[t] = 0
      continue
    }
    let c = 0
    k.branch.addInstances(n, (e) => {
      const t = c++
      const x = 0.42 * EXTENT + (t % 40) * 3
      const z = 0.42 * EXTENT + Math.floor(t / 40) * 3
      k.posOf[t * 3] = x; k.posOf[t * 3 + 1] = 0; k.posOf[t * 3 + 2] = z
      e.position.set(x, 0, z)
      k.branchIdOf[t] = e.id
    })
    c = 0
    k.leaf.addInstances(n, (e) => {
      const t = c++
      e.position.set(k.posOf[t * 3], k.posOf[t * 3 + 1], k.posOf[t * 3 + 2])
      k.leafIdOf[t] = e.id
    })
    for (const ref of arm.refs) if (ref.kind === k) { ref.stale = true; for (let t = 0; t < n; t++) { ref.tier[t] = 0; ref.culled[t] = 0 } }
  }
}

function hideSome(arm, hidden) {
  const want = Math.max(1, Math.floor(TREES * HIDDEN))
  for (let i = 0; i < arm.kinds.length; i++) {
    const k = arm.kinds[i], ref = arm.refs[i]
    let n = 0
    for (let t = 0; t < TREES && n < want; t++) {
      if (k.branchIdOf[t] < 0 || k.leafIdOf[t] < 0) continue
      k.branch.setVisibilityAt(k.branchIdOf[t], !hidden)
      k.leaf.setVisibilityAt(k.leafIdOf[t], !hidden)
      ref.visible[t] = hidden ? 0 : 1
      n++
    }
    if (n === 0) fail(`hideSome(hidden=${hidden}) found no live tree in pair ${i}, so setVisibilityAt was never exercised`)
  }
}

const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000)
const frustum = new THREE.Frustum()
const projScreen = new THREE.Matrix4()

function cameraAt(frame) {
  const start = -0.35 * EXTENT
  const travelled = SPEED * DT * frame
  const yaw = Math.PI / 4 + 0.35 * Math.sin(frame * 0.05)
  cam.position.set(start + Math.cos(Math.PI / 4) * travelled, 1.7, start + Math.sin(Math.PI / 4) * travelled)
  cam.rotation.set(0, yaw, 0)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  frustum.setFromProjectionMatrix(projScreen)
}

const independent = buildArm(false)
const shared = buildArm(true)

const frames = []
let checkedFrames = 0
for (let f = 0; f < FRAMES; f++) {
  cameraAt(f)
  stepArm(independent, cam, frustum, true, true)
  stepArm(shared, cam, frustum, true, true)
  const check = (f % CHECK_EVERY === 0) || f === FRAMES - 1
  if (!check) continue
  checkedFrames++
  checkArm(independent, 'independent', f)
  checkArm(shared, 'shared', f)
  frames.push(f)
}

const steadyIndependent = decidePerTree(independent)
const steadyShared = decidePerTree(shared)
sameDecisions(steadyIndependent, steadyShared, 'steady frames')

for (let i = 0; i < independent.kinds.length; i++) {
  const a = steadyIndependent[i]
  let n = 0
  for (let t = 0; t < TREES; t++) if (a.branch[t] !== a.leaf[t]) n++
  if (n > 0) fail(`independent pair${i}: branch and leaf disagree on ${n} tree(s), so a shared walk cannot be substituted`)
}

churnArm(independent, CHURN, false)
churnArm(shared, CHURN, false)
const churnFrames = 24
for (let f = 0; f < churnFrames; f++) {
  cameraAt(FRAMES + f)
  stepArm(independent, cam, frustum, true, true)
  stepArm(shared, cam, frustum, true, true)
  if (f === churnFrames - 1) { checkArm(independent, 'churn', FRAMES + f); checkArm(shared, 'churn', FRAMES + f); checkedFrames++ }
}
const churnIndependent = decidePerTree(independent)
const churnShared = decidePerTree(shared)
sameDecisions(churnIndependent, churnShared, 'churn frames')

for (let cycle = 0; cycle < 5; cycle++) {
  churnArm(independent, CHURN, false)
  churnArm(shared, CHURN, false)
  for (let f = 0; f < 6; f++) {
    cameraAt(FRAMES + churnFrames + 100 + cycle * 6 + f)
    stepArm(independent, cam, frustum, true, true)
    stepArm(shared, cam, frustum, true, true)
  }
  checkArm(independent, `reuse${cycle}`, FRAMES + churnFrames + 100 + cycle * 6 + 5)
  checkArm(shared, `reuse${cycle}`, FRAMES + churnFrames + 100 + cycle * 6 + 5)
  checkedFrames++
  sameDecisions(decidePerTree(independent), decidePerTree(shared), `free-list reuse cycle ${cycle}`)
}

churnArm(independent, CHURN, true)
churnArm(shared, CHURN, true)
for (let f = 0; f < 8; f++) {
  cameraAt(FRAMES + churnFrames + 200 + f)
  stepArm(independent, cam, frustum, true, true)
  stepArm(shared, cam, frustum, true, true)
}
checkArm(independent, 'permanent-removal', FRAMES + churnFrames + 207)
checkArm(shared, 'permanent-removal', FRAMES + churnFrames + 207)
checkedFrames++
sameDecisions(decidePerTree(independent), decidePerTree(shared), 'permanent-removal frames')

hideSome(independent, true)
hideSome(shared, true)
for (let f = 0; f < 12; f++) {
  cameraAt(FRAMES + churnFrames + f)
  stepArm(independent, cam, frustum, true, true)
  stepArm(shared, cam, frustum, true, true)
}
checkArm(independent, 'hidden', FRAMES + churnFrames + 11)
checkArm(shared, 'hidden', FRAMES + churnFrames + 11)
checkedFrames++
const hiddenIndependent = decidePerTree(independent)
const hiddenShared = decidePerTree(shared)
sameDecisions(hiddenIndependent, hiddenShared, 'hidden frames')

hideSome(independent, false)
hideSome(shared, false)
for (let f = 0; f < 12; f++) {
  cameraAt(FRAMES + churnFrames + 12 + f)
  stepArm(independent, cam, frustum, true, true)
  stepArm(shared, cam, frustum, true, true)
}
checkArm(independent, 'reshown', FRAMES + churnFrames + 23)
checkArm(shared, 'reshown', FRAMES + churnFrames + 23)
checkedFrames++
const reshownIndependent = decidePerTree(independent)
const reshownShared = decidePerTree(shared)
sameDecisions(reshownIndependent, reshownShared, 'reshown frames')

for (let f = 0; f < 12; f++) {
  cameraAt(FRAMES + churnFrames + 24 + f)
  stepArm(independent, cam, null, true, true)
  stepArm(shared, cam, null, true, true)
}
checkArm(independent, 'no-frustum', FRAMES + churnFrames + 35)
checkArm(shared, 'no-frustum', FRAMES + churnFrames + 35)
checkedFrames++
sameDecisions(decidePerTree(independent), decidePerTree(shared), 'no-frustum frames')

const SETTLE_FRAME = FRAMES + churnFrames + 36
cameraAt(SETTLE_FRAME)
stepArm(independent, cam, frustum, true, false)
stepArm(shared, cam, frustum, true, false)
const stillBeforeInd = snapshotStats(independent.kinds)
const stillBeforeShr = snapshotStats(shared.kinds)
for (let f = 0; f < 6; f++) {
  cameraAt(SETTLE_FRAME)
  stepArm(independent, cam, frustum, false, false)
  stepArm(shared, cam, frustum, false, false)
}
const stillAfterInd = snapshotStats(independent.kinds)
const stillAfterShr = snapshotStats(shared.kinds)
const indStillWalks = stillAfterInd.recordsWalked - stillBeforeInd.recordsWalked
const shrStillWalks = stillAfterShr.recordsWalked - stillBeforeShr.recordsWalked
if (indStillWalks !== 0 || shrStillWalks !== 0) fail(`camera still under LOD_REEVAL_MOVE_SQ still walked ${indStillWalks}/${shrStillWalks} record(s)`)
const stillUpdateCalls = (stillAfterShr.updateCalls - stillBeforeShr.updateCalls)
if (stillUpdateCalls !== 6 * PAIRS * 2) fail(`camera-still frames issued ${stillUpdateCalls} updateLOD call(s), expected ${6 * PAIRS * 2}`)

const viewBefore = snapshotStats(shared.kinds)
cameraAt(FRAMES + churnFrames + 36)
stepArm(shared, cam, frustum, true, false)
const viewAfter = snapshotStats(shared.kinds)
if (viewAfter.recordsWalked - viewBefore.recordsWalked <= 0) fail('viewChanged=true on a still camera did not re-walk any record')

for (let i = 0; i < independent.kinds.length; i++) {
  const k = independent.kinds[i]
  const sk = shared.kinds[i]
  k.branch.removeInstances(k.branchIdOf[TREES - 1])
  k.leaf.removeInstances(k.leafIdOf[TREES - 1])
  k.branch.removeInstances(k.branchIdOf[TREES - 1])
  k.leaf.removeInstances(k.leafIdOf[TREES - 1])
  k.branch.removeInstances(-1)
  k.leaf.removeInstances(-1)
  k.branchIdOf[TREES - 1] = -1
  k.leafIdOf[TREES - 1] = -1
  sk.branch.removeInstances(sk.branchIdOf[TREES - 1])
  sk.leaf.removeInstances(sk.leafIdOf[TREES - 1])
  sk.branch.removeInstances(sk.branchIdOf[TREES - 1])
  sk.leaf.removeInstances(sk.leafIdOf[TREES - 1])
  sk.branch.removeInstances(-1)
  sk.leaf.removeInstances(-1)
  sk.branchIdOf[TREES - 1] = -1
  sk.leafIdOf[TREES - 1] = -1
  k.branch.setVisibilityAt(k.branchIdOf[TREES - 2], false)
  k.leaf.setVisibilityAt(k.leafIdOf[TREES - 2], false)
  sk.branch.setVisibilityAt(sk.branchIdOf[TREES - 2], false)
  sk.leaf.setVisibilityAt(sk.leafIdOf[TREES - 2], false)
  k.branch.updateLOD(cam.position, frustum, true)
  k.leaf.updateLOD(cam.position, frustum, true)
  sk.branch.updateLOD(cam.position, frustum, true)
  sk.leaf.updateLOD(cam.position, frustum, true)
  if (k.branch.count !== sk.branch.count || k.leaf.count !== sk.leaf.count) fail(`pair${i}: double/bogus removal left control ${k.branch.count}/${k.leaf.count} vs shared ${sk.branch.count}/${sk.leaf.count} live`)
}

function makeShadowedLeaf(scene, host) {
  const { levels, shadowGeo } = levelsFor(true)
  const inst = createWebGPULodInstancer(scene, levels, Math.max(TREES, 1), ATTRIBUTE_SCHEMA, {
    hysteresis: LOD_HYSTERESIS,
    shadowGeometry: shadowGeo,
    shadowMaterial: levels[0].material,
    shadowDistance: SHADOW_DISTANCE,
    host: host || null,
  })
  inst.setMeshFarDistance(MESH_FAR)
  return inst
}

function shadowedPairKind(shared) {
  const scene = new THREE.Scene()
  const branch = makeBranch(scene)
  const leaf = shared ? makeShadowedLeaf(scene, branch) : makeShadowedLeaf(scene, null)
  return { pair: -1, shared, branch, leaf, branchIdOf: new Int32Array(TREES).fill(-1), leafIdOf: new Int32Array(TREES).fill(-1), posOf: new Float64Array(TREES * 3) }
}

const shadowCtl = shadowedPairKind(false)
const shadowShr = shadowedPairKind(true)
for (const k of [shadowCtl, shadowShr]) {
  for (let t = 0; t < TREES; t++) { const p = treePos(t, 7); k.posOf[t * 3] = p[0]; k.posOf[t * 3 + 2] = p[2] }
  addAll(k)
}
for (let f = 0; f < 24; f++) {
  cameraAt(400 + f)
  stepArm({ kinds: [shadowCtl], refs: [] }, cam, frustum, true, false)
  stepArm({ kinds: [shadowShr], refs: [] }, cam, frustum, true, false)
}
if (shadowCtl.branch.shadowActiveCount !== shadowShr.branch.shadowActiveCount) fail(`branch shadow instances ${shadowCtl.branch.shadowActiveCount} -> ${shadowShr.branch.shadowActiveCount}`)
if (shadowCtl.leaf.shadowActiveCount !== shadowShr.leaf.shadowActiveCount) fail(`leaf shadow instances ${shadowCtl.leaf.shadowActiveCount} -> ${shadowShr.leaf.shadowActiveCount}`)
if (shadowCtl.leaf.shadowActiveCount !== shadowCtl.branch.shadowActiveCount) fail(`control leaf shadow ${shadowCtl.leaf.shadowActiveCount} does not match its branch ${shadowCtl.branch.shadowActiveCount}`)
if (shadowShr.leaf.shadowActiveCount !== shadowShr.branch.shadowActiveCount) fail(`shared leaf shadow ${shadowShr.leaf.shadowActiveCount} does not match its branch ${shadowShr.branch.shadowActiveCount}`)
if (shadowShr.leaf.shadowActiveCount === 0) fail('shadowed satellite drew 0 shadow instance(s), so the shadow comparison proves nothing')
if (shadowShr.leaf.sweepStats.recordsWalked !== 0) fail(`shared leaf walked ${shadowShr.leaf.sweepStats.recordsWalked} record(s)`)
if (shadowShr.leaf.sweepStats.mirrored <= 0) fail('shadowed satellite mirrored 0 decision(s), so mirrorShadow was never exercised')

for (const lead of [0, 60]) {
  const scene = new THREE.Scene()
  const branch = makeBranch(scene)
  const leaf = makeLeaf(scene, branch)
  cameraAt(520)
  let branchId = -1
  branch.addInstances(1, (e) => { e.position.set(cam.position.x + lead, 0, cam.position.z + lead); branchId = e.id })
  if (lead > 0) { branch.updateLOD(cam.position, frustum, true); branch.updateLOD(cam.position, frustum, true) }
  let leafId = -1
  leaf.addInstances(1, (e) => { e.position.set(cam.position.x + lead, 0, cam.position.z + lead); leafId = e.id })
  leaf.updateLOD(cam.position, frustum, true)
  branch.updateLOD(cam.position, frustum, true)
  const branchTier = drawnTierOf(branch, (() => { const m = new Int32Array(TREES).fill(-1); m[0] = branchId; return m })())
  const leafTier = drawnTierOf(leaf, (() => { const m = new Int32Array(TREES).fill(-1); m[0] = leafId; return m })())
  if (branchTier[0] !== leafTier[0]) fail(`host add followed by ${lead === 0 ? 'no' : 'two'} updateLOD before the satellite add: branch tier ${branchTier[0]} but leaf tier ${leafTier[0]}`)
}

const emptyScene = new THREE.Scene()
const emptyBranch = makeBranch(emptyScene)
const emptyLeaf = makeLeaf(emptyScene, emptyBranch)
emptyBranch.addInstances(0, () => {})
emptyLeaf.addInstances(0, () => {})
emptyBranch.updateLOD(cam.position, frustum, true)
emptyLeaf.updateLOD(cam.position, frustum, true)
if (emptyBranch.count !== 0 || emptyLeaf.count !== 0) fail(`empty pair reports ${emptyBranch.count}/${emptyLeaf.count} instance(s)`)
const singleScene = new THREE.Scene()
const singleBranch = makeBranch(singleScene)
const singleLeaf = makeLeaf(singleScene, singleBranch)
singleBranch.addInstances(1, (e) => { e.position.set(0, 0, 0) })
singleLeaf.addInstances(1, (e) => { e.position.set(0, 0, 0) })
for (let f = 0; f < 8; f++) { cameraAt(f); singleBranch.updateLOD(cam.position, frustum, true); singleLeaf.updateLOD(cam.position, frustum, true) }
if (singleBranch.tierIds[0].length !== singleLeaf.tierIds[0].length || singleBranch.count !== singleLeaf.count) fail('single-tree pair branch and leaf disagree')

let mismatchThrew = false
try {
  const badScene = new THREE.Scene()
  const goodBranch = makeBranch(badScene)
  const badLevels = [
    { geometry: BOX(6, 12, 6), material: new THREE.MeshStandardMaterial(), distance: 0 },
    { geometry: BOX(4.5, 9, 4.5), material: new THREE.MeshStandardMaterial(), distance: 20 },
    { geometry: BOX(3, 6, 3), material: new THREE.MeshStandardMaterial(), distance: 35 },
  ]
  createWebGPULodInstancer(badScene, badLevels, 8, ATTRIBUTE_SCHEMA, { hysteresis: LOD_HYSTERESIS, host: goodBranch })
} catch (e) { mismatchThrew = /LOD threshold/.test(String(e && e.message)) }
if (!mismatchThrew) fail('a satellite whose LOD thresholds differ from its host was accepted')

function BOX(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(0, h / 2, 0)
  g.boundingSphere = BOUNDS.clone()
  return g
}

let unpairedThrew = false
try {
  const upScene = new THREE.Scene()
  const upBranch = makeBranch(upScene)
  const upLeaf = makeLeaf(upScene, upBranch)
  upLeaf.addInstances(4, (e) => { e.position.set(0, 0, 0) })
} catch (e) { unpairedThrew = /not paired/.test(String(e && e.message)) }
if (!unpairedThrew) fail('a satellite add with no host add behind it was accepted')

let underThrew = false
try {
  const us = new THREE.Scene()
  const ub = makeBranch(us)
  const ul = makeLeaf(us, ub)
  ub.addInstances(2, (e) => { e.position.set(0, 0, 0) })
  ul.addInstances(1, (e) => { e.position.set(0, 0, 0) })
  ub.addInstances(1, (e) => { e.position.set(0, 0, 0) })
} catch (e) { underThrew = /unconsumed/.test(String(e && e.message)) }
if (!underThrew) fail('a satellite add that consumed fewer host slots than the host allocated was accepted')

const indStats = snapshotStats(independent.kinds)
const shrStats = snapshotStats(shared.kinds)
for (const k of independent.kinds) { k.branch.updateLOD(cam.position, frustum, true); k.leaf.updateLOD(cam.position, frustum, true) }
for (const k of shared.kinds) { k.branch.updateLOD(cam.position, frustum, true); k.leaf.updateLOD(cam.position, frustum, true) }
const indFinal = snapshotStats(independent.kinds)
const shrFinal = snapshotStats(shared.kinds)

const dInd = {}
const dShr = {}
for (const key in indStats) { dInd[key] = indFinal[key] - indStats[key]; dShr[key] = shrFinal[key] - shrStats[key] }

const runInd = {}
const runShr = {}
for (const key in indStats) { runInd[key] = indFinal[key] - independent.stats0[key]; runShr[key] = shrFinal[key] - shared.stats0[key] }

let leafWalk = 0, leafCells = 0, leafRebuilds = 0, leafRebuildRecords = 0, leafMirrored = 0
for (const k of shared.kinds) {
  const s = k.leaf.sweepStats
  leafWalk += s.recordsWalked
  leafCells += s.cellsTested
  leafRebuilds += s.rebuilds
  leafRebuildRecords += s.rebuildRecords
  leafMirrored += s.mirrored
  if (s.mirrored <= 0) fail(`pair ${k.pair}: shared leaf mirrored 0 decision(s)`)
}
if (leafMirrored > runShr.recordsWalked) fail(`shared arm mirrored ${leafMirrored} decision(s) but walked only ${runShr.recordsWalked} record(s)`)
if (leafWalk !== 0) fail(`shared leaf still walked ${leafWalk} record(s)`)
if (leafCells !== 0) fail(`shared leaf still tested ${leafCells} cell(s)`)
if (leafRebuilds !== 0) fail(`shared leaf still rebuilt its grid ${leafRebuilds} time(s)`)
if (leafRebuildRecords !== 0) fail(`shared leaf still rebuilt ${leafRebuildRecords} record(s)`)
if (leafMirrored <= 0) fail('shared leaf mirrored 0 decision(s), so its LOD would be frozen')

const ratios = {}
for (const key of ['recordsWalked', 'cellsTested', 'planeTests', 'rebuilds', 'rebuildRecords']) {
  const a = runInd[key], b = runShr[key]
  ratios[key] = a > 0 ? +(b / a).toFixed(3) : null
}

const indLeafSurvivors = survivorCount(independent, 'leaf')
const shrLeafSurvivors = survivorCount(shared, 'leaf')
const indBranchSurvivors = survivorCount(independent, 'branch')
const shrBranchSurvivors = survivorCount(shared, 'branch')
if (indLeafSurvivors === 0) fail('control arm drew 0 leaf instance(s), so the survivor comparison proves nothing')
if (indBranchSurvivors === 0) fail('control arm drew 0 branch instance(s), so the survivor comparison proves nothing')
if (indLeafSurvivors !== shrLeafSurvivors) fail(`leaf survivors ${indLeafSurvivors} -> ${shrLeafSurvivors}`)
if (indBranchSurvivors !== shrBranchSurvivors) fail(`branch survivors ${indBranchSurvivors} -> ${shrBranchSurvivors}`)
const indShadow = shadowCount(independent)
const shrShadow = shadowCount(shared)
if (indShadow !== shrShadow) fail(`branch shadow instances ${indShadow} -> ${shrShadow}`)

for (const key of ['recordsWalked', 'cellsTested', 'planeTests', 'rebuilds', 'rebuildRecords']) {
  const r = ratios[key]
  if (r === null) { fail(`control arm counted 0 ${key} over the whole run, so the ${key} ratio proves nothing`); continue }
  if (r > SHARE_MAX_FRAC) fail(`${key} shared/independent = ${r}, above ${SHARE_MAX_FRAC}`)
}

console.log(`pairs=${PAIRS} trees/pair=${TREES} frames=${FRAMES} checked=${checkedFrames} extent=${EXTENT} meshFar=${MESH_FAR}`)
console.log(`whole run    control arm: ${JSON.stringify(runInd)}`)
console.log(`whole run    shared arm : ${JSON.stringify(runShr)}`)
console.log(`ratio shared/control: ${JSON.stringify(ratios)} (cap ${SHARE_MAX_FRAC})`)
console.log(`survivors branch ${indBranchSurvivors}->${shrBranchSurvivors} leaf ${indLeafSurvivors}->${shrLeafSurvivors} shadow ${indShadow}->${shrShadow}`)
console.log(`shared leaf: walked=${leafWalk} cells=${leafCells} rebuilds=${leafRebuilds} rebuildRecords=${leafRebuildRecords} mirrored=${leafMirrored}`)

if (failures.length) for (const f of failures) console.log('FAIL: ' + f)
console.log(`RESULT: ${failures.length ? 'FAIL' : 'PASS'} -- ${checkedFrames} check frame(s) over ${PAIRS} branch/leaf pair(s) of ${TREES} tree(s), shared walk at ${JSON.stringify(ratios)} of the control arm's counted work`)
process.exitCode = failures.length ? 1 : 0
