#!/usr/bin/env node
// veg-lod-sweep-cost-node-witness
//
// WHAT IT MEASURES: the counted work the real client/core/WebGPULodInstancer.js sweep performs
// per frame -- records walked and frustum plane tests -- and whether that work tracks what is
// actually drawn instead of how many instances exist. Every number is a counter the instancer
// itself increments; nothing is timed and nothing is rasterised.
//
// WHAT IT DOES NOT MEASURE: no frame cost is claimed. Milliseconds per frame on a real scene is a
// rasterised measurement and is not reproduced here. The claim is only that the sweep visits a
// bounded number of instance records per drawn instance, and that a fivefold population growth
// does not move that number fivefold.
//
// Second phase: a placement edit that changes the live instance count, and whether the spatial
// index describes the new population after a single updateLOD.
import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'

const LABEL = 'veg-lod-sweep-cost'

const LOD_DISTANCES = [0, 14, 35]
const LOD_HYSTERESIS = 0.12
const SHADOW_DISTANCE = 35
const MESH_FAR = 90
const ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'vec3' }
const LEVEL_SEGMENTS = [[3, 6, 3], [1, 2, 1], [1, 1, 1]]
const SCALING_COUNTS = [10000, 50000]
const SCALING_FRAMES = 240
const SCALING_SPACING = 3
const SCALING_SPEED = 7
const EDIT_INSTANCES = 2000
const EDIT_SPACING = 3
const EDIT_SETTLE_FRAMES = 4
const RECORDS_PER_SURVIVOR_CAP = 4
const GROWTH_FRACTION = 0.6

function flag(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const MUTATE = flag('mutate', 'none')
const KNOWN_MUTATIONS = new Set(['none', 'full-walk', 'skip-refresh'])
if (!KNOWN_MUTATIONS.has(MUTATE)) {
  console.log(`RESULT: FAIL ${LABEL} -- --mutate=${MUTATE} is not one of ${[...KNOWN_MUTATIONS].join(', ')}`)
  process.exit(1)
}

const LINES = []
const say = (...s) => { const line = s.join(' '); LINES.push(line); process.stdout.write(line + '\n') }
const failures = []
function expect(ok, detail) {
  if (!ok) failures.push(detail)
  say((ok ? 'PASS ' : 'FAIL ') + detail)
  return ok
}

const BOUNDS = (() => {
  const g = new THREE.BoxGeometry(6, 12, 6)
  g.translate(0, 6, 0)
  g.computeBoundingSphere()
  return g.boundingSphere.clone()
})()

function levelsFor() {
  const out = []
  for (let i = 0; i < LOD_DISTANCES.length; i++) {
    const seg = LEVEL_SEGMENTS[i]
    const g = new THREE.BoxGeometry(6, 12, 6, seg[0], seg[1], seg[2])
    g.translate(0, 6, 0)
    g.boundingSphere = BOUNDS.clone()
    out.push({ geometry: g, material: new THREE.MeshStandardMaterial(), distance: LOD_DISTANCES[i] })
  }
  return out
}

function makeInstancer(capacity) {
  const levels = levelsFor()
  const shadowGeo = new THREE.BoxGeometry(1.5, 3, 1.5)
  shadowGeo.translate(0, 6, 0)
  shadowGeo.boundingSphere = BOUNDS.clone()
  const inst = createWebGPULodInstancer(new THREE.Scene(), levels, capacity, ATTRIBUTE_SCHEMA, {
    hysteresis: LOD_HYSTERESIS,
    shadowGeometry: shadowGeo,
    shadowMaterial: levels[0].material,
    shadowDistance: SHADOW_DISTANCE,
  })
  inst.setMeshFarDistance(MESH_FAR)
  return inst
}

function gridFill(inst, count, spacing) {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)))
  const half = (side - 1) * spacing * 0.5
  inst.addInstances(count, (p) => {
    p.position.set((p.id % side) * spacing - half, 0, Math.floor(p.id / side) * spacing - half)
  })
  return half
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000)
const frustum = new THREE.Frustum()
const projScreen = new THREE.Matrix4()

function poseCamera(travelled, yaw, height) {
  camera.position.set(-0.35 * height + Math.cos(Math.PI / 4) * travelled, 1.7, -0.35 * height + Math.sin(Math.PI / 4) * travelled)
  camera.rotation.set(0, yaw, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  frustum.setFromProjectionMatrix(projScreen)
}

say(`${LABEL} witness at ${new Date().toISOString()}`)
say(`mutate=${MUTATE} counts=${SCALING_COUNTS.join(',')} frames=${SCALING_FRAMES} ` +
  `meshFar=${MESH_FAR} recordsPerSurvivorCap=${RECORDS_PER_SURVIVOR_CAP}`)
say('')

// ------------------------------------------------ phase 1: work per frame vs population
say('instances  drawn  recordsPerFrame  planeTestsPerFrame  recordsPerDrawn  recordsPerInstance')

const scaling = []
for (const count of SCALING_COUNTS) {
  const inst = makeInstancer(count)
  const half = gridFill(inst, count, SCALING_SPACING)
  const before = { ...inst.sweepStats }
  for (let f = 0; f < SCALING_FRAMES; f++) {
    const travelled = SCALING_SPEED * (1 / 60) * f
    poseCamera(travelled, Math.PI / 4 + 0.35 * Math.sin(f * 0.05), half * 2)
    // 'full-walk' models a caller re-applying the mesh-far knob every frame: it invalidates the
    // sweep grid every frame, so the sweep can no longer skip anything.
    if (MUTATE === 'full-walk') inst.setMeshFarDistance(MESH_FAR)
    inst.updateLOD(camera.position, frustum, true)
  }
  const after = { ...inst.sweepStats }
  let drawn = 0
  for (const tier of inst.tierIds) drawn += tier.length
  const row = {
    instances: count,
    drawn,
    recordsPerFrame: +((after.recordsWalked - before.recordsWalked) / SCALING_FRAMES).toFixed(1),
    planeTestsPerFrame: +((after.planeTests - before.planeTests) / SCALING_FRAMES).toFixed(1),
  }
  row.recordsPerDrawn = +(row.recordsPerFrame / Math.max(drawn, 1)).toFixed(2)
  row.recordsPerInstance = +(row.recordsPerFrame / count).toFixed(4)
  scaling.push(row)
  say(String(row.instances).padStart(9), String(row.drawn).padStart(6),
    String(row.recordsPerFrame).padStart(16), String(row.planeTestsPerFrame).padStart(19),
    String(row.recordsPerDrawn).padStart(16), String(row.recordsPerInstance).padStart(18))
  inst.dispose()
}

say('')

const small = scaling[0]
const large = scaling[1]
const countRatio = large.instances / small.instances
const recordsRatio = +(large.recordsPerFrame / Math.max(small.recordsPerFrame, 1)).toFixed(3)
const planeRatio = +(large.planeTestsPerFrame / Math.max(small.planeTestsPerFrame, 1)).toFixed(3)

expect(small.drawn > 0 && large.drawn > 0,
  `both populations drew instances: ${small.instances} -> ${small.drawn} drawn, ${large.instances} -> ${large.drawn} drawn`)
expect(small.recordsPerFrame > 0 && large.recordsPerFrame > 0,
  `the sweep walked records at both populations: ${small.recordsPerFrame} and ${large.recordsPerFrame} record(s)/frame`)
expect(small.planeTestsPerFrame > 0 && large.planeTestsPerFrame > 0,
  `the sweep tested frustum planes at both populations: ${small.planeTestsPerFrame} and ${large.planeTestsPerFrame} plane test(s)/frame`)
expect(small.recordsPerFrame <= RECORDS_PER_SURVIVOR_CAP * small.drawn,
  `at ${small.instances} instance(s) the sweep walked ${small.recordsPerFrame} record(s)/frame for ${small.drawn} drawn, ` +
  `${small.recordsPerDrawn} record(s) per drawn instance (cap ${RECORDS_PER_SURVIVOR_CAP})`)
expect(large.recordsPerFrame <= RECORDS_PER_SURVIVOR_CAP * large.drawn,
  `at ${large.instances} instance(s) the sweep walked ${large.recordsPerFrame} record(s)/frame for ${large.drawn} drawn, ` +
  `${large.recordsPerDrawn} record(s) per drawn instance (cap ${RECORDS_PER_SURVIVOR_CAP})`)
expect(recordsRatio <= countRatio * GROWTH_FRACTION,
  `${countRatio}x the instances grew records walked only ${recordsRatio}x ` +
  `(${GROWTH_FRACTION} of the population ratio is the ceiling)`)
expect(small.recordsPerFrame < small.instances && large.recordsPerFrame < large.instances,
  `the sweep never visits the whole population in a frame: ${small.recordsPerFrame} of ${small.instances}, ` +
  `${large.recordsPerFrame} of ${large.instances}`)

say(`ratios: instances ${countRatio}x, records ${recordsRatio}x, planeTests ${planeRatio}x`)
say('')

// ------------------------------------------------ phase 2: one-frame reindex after an edit
const editInst = makeInstancer(EDIT_INSTANCES)
const editHalf = gridFill(editInst, EDIT_INSTANCES, EDIT_SPACING)
for (let f = 0; f < EDIT_SETTLE_FRAMES; f++) {
  poseCamera(SCALING_SPEED * (1 / 60) * f, Math.PI / 4, editHalf * 2)
  editInst.updateLOD(camera.position, frustum, true)
}
const countBefore = editInst.count
const gridBefore = editInst.sweepGrid.instances
const removed = Math.max(1, Math.floor(countBefore * 0.1))
const readded = Math.max(1, Math.floor(countBefore * 0.05))
for (let i = 0; i < removed; i++) editInst.removeInstances(i)
editInst.addInstances(readded, (p) => p.position.set(4000 + (p.id % 20) * 3, 0, 4000 + Math.floor(p.id / 20) * 3))
const editBefore = { ...editInst.sweepStats }
// 'skip-refresh' models an edit path that mutates placements and never re-runs the sweep.
if (MUTATE !== 'skip-refresh') editInst.updateLOD(camera.position, frustum, true)
const editAfter = { ...editInst.sweepStats }
const countAfter = editInst.count
const gridAfter = editInst.sweepGrid.instances
const editWalked = editAfter.recordsWalked - editBefore.recordsWalked

say(`placement edit: ${countBefore} instance(s), grid ${gridBefore}; removed ${removed}, added ${readded} -> ` +
  `${countAfter} instance(s), grid ${gridAfter}, ${editWalked} record(s) walked on the next frame`)

expect(countAfter !== countBefore,
  `the edit changed the live population, so the index has something to catch up with: ${countBefore} -> ${countAfter}`)
expect(editWalked > 0,
  `the frame after the placement edit walked ${editWalked} record(s), so the sweep ran`)
expect(gridAfter === countAfter,
  `one frame after the edit the index describes ${gridAfter} instance(s) and the population is ${countAfter}`)

const passed = failures.length === 0
say('')
say(`RESULT: ${passed ? 'PASS' : 'FAIL'} -- ${small.recordsPerDrawn}/${large.recordsPerDrawn} record(s) walked per drawn ` +
  `instance at ${SCALING_COUNTS.join('/')} instance(s), records grew ${recordsRatio}x against ${countRatio}x the population, ` +
  `index re-synchronised to ${countAfter} instance(s) within one frame of a placement edit`)
process.exit(passed ? 0 : 1)
