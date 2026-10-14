// PERF-fill-overdraw-backface-1013.
//
// The frame is fill-bound: at 1920x1080 on an rAF-unlocked instrument wall p50 runs 50.55-59.16 ms
// while ThreadTime runs only 7.244-8.543 ms, and pixels x2.25 produced wall x2.18 while draws/frame
// moved x1.02. With ~30-40 draws/frame the lever is per-pixel cost, so the change is removing
// fragments we pay for and never see: the terrain patch grid is an OPEN heightfield, and DoubleSide
// rasterizes its back-facing half into a depth test it then loses.
//
// What this witness pins, gpu-free:
//   1. the terrain material BUILDS single-sided -- the real object out of createTerrainMaterialTSL,
//      not a grep of a line, so a later edit that reintroduces DoubleSide fails here;
//   2. the side it builds is the one the camera sees (named by the browser arm, which culls each
//      side in turn and diffs the frame per band) and NOT DoubleSide;
//   3. the surfaces whose backfaces are load-bearing are UNCHANGED: grass cards (GrassTSL.js),
//      vegetation leaves (VegetationBuild.js) and the water surface (water-tsl.js) are all still
//      DoubleSide. Those are the "a blade seen from behind" class, and breaking them costs more
//      fidelity than the fill saved;
//   4. the vertex stencil the row must not move (FD_TAPS) is untouched, so the gain is fill and
//      fill alone;
//   5. the change is a single assignment site, so there is no second place that re-doubles it.
//
// gpu-free: it builds the real node graph in node. It never touches an adapter.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three/webgpu'
import { uniform, vec3 } from 'three/tsl'
import { createTerrainMaterialTSL, FD_TAPS } from '../packages/mapspinner/src/tsl/terrain-material-tsl.js'
import { TERRAIN_DEFAULTS as TD } from '../packages/mapspinner/src/terrain-defaults.js'
import { PLANET_RADIUS_M } from '../packages/mapspinner/src/planet-radius.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MATERIAL_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/terrain-material-tsl.js'), 'utf8')
const GRASS_TSL_SRC = readFileSync(join(ROOT, 'client/core/GrassTSL.js'), 'utf8')
const GRASS_MATERIAL_SRC = readFileSync(join(ROOT, 'client/core/GrassMaterial.js'), 'utf8')
const VEG_BUILD_SRC = readFileSync(join(ROOT, 'client/core/VegetationBuild.js'), 'utf8')
const WATER_SRC = readFileSync(join(ROOT, 'packages/mapspinner/src/tsl/water-tsl.js'), 'utf8')

const LABEL = 'terrain-side-single'
// Named by the browser arm: culling each side in turn and diffing the frame per band, the side that
// leaves the picture intact is the one the camera sees. It is restated here so a later flip of this
// constant is a decision, not a drift.
const EXPECTED_SIDE_NAME = 'BackSide'
const EXPECTED_SIDE = THREE.BackSide

const checks = []
function expect(label, got, want) {
  const pass = Object.is(got, want) || got === want
  checks.push({ label, got, want, pass })
  return pass
}

// ---- 1. the terrain material builds single-sided ------------------------------------------------
const HPF_RES = 4
const hpfTexture = new THREE.DataTexture(new Float32Array(HPF_RES * HPF_RES * 6 * 4), HPF_RES, HPF_RES * 6)
hpfTexture.format = THREE.RGBAFormat
hpfTexture.type = THREE.FloatType
hpfTexture.needsUpdate = true

const sky = {
  uniforms: { sunDir: uniform(new THREE.Vector3(0, 1, 0)), camAtm: uniform(new THREE.Vector3(0, 0, 0)) },
  solarIrradiance: vec3(1, 1, 1),
  transmittanceToSunAtGround: () => vec3(1, 1, 1),
  marchRadiance: () => vec3(0.1, 0.1, 0.1),
}

const built = createTerrainMaterialTSL({
  sky,
  defRadius: PLANET_RADIUS_M,
  reliefScale: TD.reliefScale ?? 0.1,
  landBias: 0,
  beachShelfM: 1,
  hpfRes: HPF_RES,
  hpfTexture,
  gridSize: 16,
  hashVersion: 2,
  carves: [],
})
const terrainMaterial = built && built.material
expect('createTerrainMaterialTSL returns a material to inspect', !!terrainMaterial, true)
expect('the terrain material is the one the page builds', terrainMaterial && terrainMaterial.name, 'mapspinner-terrain-tsl')
expect(`the terrain material builds ${EXPECTED_SIDE_NAME}, the side the camera sees`, terrainMaterial && terrainMaterial.side, EXPECTED_SIDE)
expect('the terrain material is NOT double-sided, so its back-facing half is culled', terrainMaterial && terrainMaterial.side !== THREE.DoubleSide, true)
expect('the terrain material is still opaque, so culling a side cannot be hiding a blend', terrainMaterial && terrainMaterial.transparent, false)

// ---- 2. the assignment is one site ---------------------------------------------------------------
const sideAssignments = MATERIAL_SRC.split('\n').filter((l) => /material\.side\s*=/.test(l))
expect('exactly one line assigns the terrain material side', sideAssignments.length, 1)
expect('that line is the single-sided one', /material\.side = THREE\.(Front|Back)Side/.test(sideAssignments[0] || ''), true)
expect('no second site re-doubles it', /material\.side = THREE\.DoubleSide/.test(MATERIAL_SRC), false)

// ---- 3. the surfaces whose backfaces are load-bearing are untouched ------------------------------
// Grass cards and vegetation leaves are double-sided BY DESIGN: a blade is a card, and culling its
// back makes a field of grass disappear wherever the camera is behind a blade. The water surface is
// a grid the camera can cross. None of the three is authorised to change.
expect('grass (TSL) is still DoubleSide', /new MeshBasicNodeMaterial\(\{ side: THREE\.DoubleSide \}\)/.test(GRASS_TSL_SRC), true)
expect('grass (legacy material) is still DoubleSide', /side: THREE\.DoubleSide,/.test(GRASS_MATERIAL_SRC), true)
expect('vegetation leaves are still DoubleSide', /leafMat\.side = THREE\.DoubleSide/.test(VEG_BUILD_SRC), true)
expect('the water surface is still DoubleSide', /material\.side = THREE\.DoubleSide/.test(WATER_SRC), true)
expect('vegetation branches still cast from their front side only', /branchMat\.shadowSide = THREE\.FrontSide/.test(VEG_BUILD_SRC), true)

// ---- 4. the vertex stencil did not move ----------------------------------------------------------
expect('the vertex stencil is still three taps, so the gain is fill and fill alone', FD_TAPS, 3)

const failed = checks.filter((c) => !c.pass)
for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.label}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`)
if (failed.length > 0) {
  console.log(`RESULT: FAIL ${failed.length} of ${checks.length} check(s) failed label=${LABEL}`)
  process.exit(1)
}
console.log(`MEASURED ${LABEL}: terrain material side=${EXPECTED_SIDE_NAME}(${EXPECTED_SIDE}) built from createTerrainMaterialTSL; grass, vegetation leaves and water still DoubleSide; ${checks.length} check(s) passed`)
console.log(`RESULT: PASS ${checks.length} check(s) label=${LABEL}`)
