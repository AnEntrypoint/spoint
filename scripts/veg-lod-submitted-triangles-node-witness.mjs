#!/usr/bin/env node
// veg-lod-submitted-triangles-node-witness
//
// WHAT IT MEASURES: at each of several camera distances, how many triangles the real
// client/core/WebGPULodInstancer.js submits per drawn instance and in total. The counted work
// unit is the geometry index count of the LOD level each drawn instance lands in, summed over
// the instances the sweep actually placed in a tier.
//
// WHAT IT DOES NOT MEASURE: no frame is rasterised and no pixel is compared. It cannot say a
// distant tree LOOKS right, only that the distance ladder hands it a coarser mesh and that
// beyond the mesh-far distance the sweep hands it no mesh at all. The name says submitted
// triangles for that reason, not fidelity.
//
// The LOD distances, hysteresis and mesh-far distance are the shipped ones. The three level
// geometries are synthetic stand-ins with distinct triangle counts (180 / 20 / 12): the shipped
// tree meshes are GLB assets that cannot be loaded here, so what is pinned is the ladder's
// selection and its cost, not the art.
import * as THREE from 'three'
import { createWebGPULodInstancer } from '../client/core/WebGPULodInstancer.js'

const LABEL = 'veg-lod-submitted-triangles'

const LOD_DISTANCES = [0, 14, 35]
const LOD_HYSTERESIS = 0.12
const SHADOW_DISTANCE = 35
const MESH_FAR = 90
const ATTRIBUTE_SCHEMA = { windPhase: 'float', tint: 'vec3' }
const LEVEL_SEGMENTS = [[3, 6, 3], [1, 2, 1], [1, 1, 1]]
const INSTANCES_PER_BAND = 100
const BAND_SIDE = 10
const BAND_SPACING = 1
// 5 and 20 and 45 sit inside levels 0, 1, 2 of the [0,14,35] ladder; 80 is still inside level 2
// but at four fifths of mesh-far; 120 is past mesh-far and must draw nothing.
const BANDS = [5, 20, 45, 80, 120]

function flag(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? dflt : hit.slice(name.length + 3)
}
const MUTATE = flag('mutate', 'none')
const KNOWN_MUTATIONS = new Set(['none', 'flat-geometry', 'threshold-shift', 'no-mesh-far'])
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
  const distances = MUTATE === 'threshold-shift' ? LOD_DISTANCES.map((d) => d * 0.5) : LOD_DISTANCES
  const out = []
  for (let i = 0; i < distances.length; i++) {
    const seg = MUTATE === 'flat-geometry' ? LEVEL_SEGMENTS[0] : LEVEL_SEGMENTS[i]
    const g = new THREE.BoxGeometry(6, 12, 6, seg[0], seg[1], seg[2])
    g.translate(0, 6, 0)
    g.boundingSphere = BOUNDS.clone()
    out.push({ geometry: g, material: new THREE.MeshStandardMaterial(), distance: distances[i] })
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
  inst.setMeshFarDistance(MUTATE === 'no-mesh-far' ? 10000 : MESH_FAR)
  return { inst, trisPerLevel: levels.map((l) => l.geometry.index.count / 3) }
}

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000)
camera.position.set(0, 1.7, 0)
camera.lookAt(0, 1.7, 1)
camera.updateMatrixWorld(true)
camera.updateProjectionMatrix()
const projScreen = new THREE.Matrix4()
projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
const frustum = new THREE.Frustum()
frustum.setFromProjectionMatrix(projScreen)

say(`${LABEL} witness at ${new Date().toISOString()}`)
say(`mutate=${MUTATE} distances=${JSON.stringify(levelsFor().map((l) => l.distance))} ` +
  `hysteresis=${LOD_HYSTERESIS} meshFar=${MUTATE === 'no-mesh-far' ? 10000 : MESH_FAR} ` +
  `instancesPerBand=${INSTANCES_PER_BAND}`)
say('')
say('bandM  tiers        drawn  submittedTris  trisPerDrawnInstance')

// One fresh instancer per band, so every instance starts with its LOD band unset and the tier it
// is given is the raw ladder tier for its distance with no hysteresis history behind it.
const rows = []
for (const band of BANDS) {
  const { inst, trisPerLevel } = makeInstancer(INSTANCES_PER_BAND)
  const half = (BAND_SIDE - 1) * BAND_SPACING * 0.5
  inst.addInstances(INSTANCES_PER_BAND, (p) => {
    const lx = (p.id % BAND_SIDE) * BAND_SPACING - half
    const lz = Math.floor(p.id / BAND_SIDE) * BAND_SPACING - half
    p.position.set(lx, 0, band + lz)
  })
  inst.updateLOD(camera.position, frustum, true)
  let drawn = 0
  let submitted = 0
  inst.tierIds.forEach((ids, tier) => {
    drawn += ids.length
    submitted += ids.length * trisPerLevel[tier]
  })
  const row = {
    band,
    tiers: inst.tierIds.map((t) => t.length),
    drawn,
    submitted,
    perDrawn: drawn === 0 ? 0 : +(submitted / drawn).toFixed(3),
  }
  rows.push(row)
  say(String(band).padStart(5),
    JSON.stringify(row.tiers).padEnd(12),
    String(row.drawn).padStart(6),
    String(row.submitted).padStart(14),
    String(row.perDrawn).padStart(21))
  inst.dispose()
}

say('')

const near = rows[0]
const mid = rows[1]
const far = rows[2]
const fringe = rows[3]
const beyond = rows[4]

// The ladder must hand out a mesh at every distance inside mesh-far and none outside it.
expect(near.drawn === INSTANCES_PER_BAND && mid.drawn === INSTANCES_PER_BAND && far.drawn === INSTANCES_PER_BAND,
  `every band inside meshFar ${MESH_FAR} m drew all ${INSTANCES_PER_BAND} instance(s): ` +
  `5m=${near.drawn} 20m=${mid.drawn} 45m=${far.drawn}`)
expect(beyond.drawn === 0 && beyond.submitted === 0,
  `the band past meshFar ${MESH_FAR} m drew ${beyond.drawn} instance(s) submitting ${beyond.submitted} triangle(s)`)

// Tier selection at each band, against the ladder the levels declare.
expect(near.tiers[0] === INSTANCES_PER_BAND,
  `at 5 m the ladder drew all ${INSTANCES_PER_BAND} instance(s) at level 0: ${JSON.stringify(near.tiers)}`)
expect(mid.tiers[1] > 0 && mid.tiers[0] < INSTANCES_PER_BAND,
  `at 20 m the ladder moved instances off level 0 onto level 1: ${JSON.stringify(mid.tiers)}`)
expect(far.tiers[2] === INSTANCES_PER_BAND,
  `at 45 m the ladder drew all ${INSTANCES_PER_BAND} instance(s) at level 2: ${JSON.stringify(far.tiers)}`)

// The point of the exercise: cost per drawn instance falls as the camera recedes.
expect(near.perDrawn > mid.perDrawn && mid.perDrawn > far.perDrawn,
  `submitted triangles per drawn instance fall with distance: 5m=${near.perDrawn} > 20m=${mid.perDrawn} > 45m=${far.perDrawn}`)
expect(far.perDrawn >= fringe.perDrawn && fringe.perDrawn > beyond.perDrawn,
  `it never rises again out to mesh-far and drops to nothing past it: 45m=${far.perDrawn} >= 80m=${fringe.perDrawn} > 120m=${beyond.perDrawn}`)
expect(near.submitted > 0 && far.submitted * 10 <= near.submitted,
  `the whole ${INSTANCES_PER_BAND}-instance patch submits ${near.submitted} triangle(s) at 5 m and ${far.submitted} at 45 m, a factor of ` +
  `${(near.submitted / Math.max(far.submitted, 1)).toFixed(1)}`)

const passed = failures.length === 0
say('')
say(`measured: ${near.submitted} -> ${mid.submitted} -> ${far.submitted} -> ${fringe.submitted} -> ${beyond.submitted} ` +
  `triangle(s) submitted at ${BANDS.join(' m, ')} m, ` +
  `${near.perDrawn} -> ${mid.perDrawn} -> ${far.perDrawn} -> ${fringe.perDrawn} -> ${beyond.perDrawn} per drawn instance`)
say(`RESULT: ${passed ? 'PASS' : 'FAIL'} -- ${BANDS.length} distance band(s) of ${INSTANCES_PER_BAND} instance(s), ` +
  `${near.perDrawn} -> ${far.perDrawn} triangle(s) per drawn instance from 5 m to 45 m, ` +
  `${beyond.submitted} triangle(s) past meshFar ${MESH_FAR} m`)
process.exit(passed ? 0 : 1)
