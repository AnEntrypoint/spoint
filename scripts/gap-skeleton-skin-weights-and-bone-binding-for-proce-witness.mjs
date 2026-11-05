import * as THREE from 'three'
import { attachToBone, boneOf, bindSkin, buildProceduralSkeleton, createSkinnedBody } from '../src/animation/ProceduralSkeleton.js'

let failures = 0
function expect(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`)
  else { failures += 1; console.log(`FAIL ${name} ${detail}`) }
}
function throwsWith(fn, fragment) {
  try { fn(); return false } catch (err) { return String(err.message).includes(fragment) }
}

const spec = {
  hips: { pivot: [0, 1, 0] },
  neck: { parent: 'hips', pivot: [0, 1.5, 0] },
  head: { parent: 'neck', pivot: [0, 1.8, 0.2] },
}

{
  const rig = buildProceduralSkeleton(spec)
  const head = boneOf(rig, 'head').getWorldPosition(new THREE.Vector3())
  expect('child pivots resolve to absolute positions', head.distanceTo(new THREE.Vector3(0, 1.8, 0.2)) < 1e-9, `head=${head.toArray()}`)
  expect('bones are listed in declaration order', rig.bones.map((b) => b.name).join() === 'hips,neck,head')
  expect('skeleton holds one bone per declared name', rig.skeleton.bones.length === 3)
}

expect('a parent declared after its child is refused', throwsWith(() => buildProceduralSkeleton({
  neck: { parent: 'hips', pivot: [0, 1, 0] },
  hips: { pivot: [0, 1, 0] },
}), 'must be declared before it'))

expect('a non-finite pivot is refused', throwsWith(() => buildProceduralSkeleton({ hips: { pivot: [0, NaN, 0] } }), 'three finite numbers'))
expect('an empty skeleton is refused', throwsWith(() => buildProceduralSkeleton({}), 'declares no bones'))
expect('an unknown bone lookup is refused', throwsWith(() => boneOf(buildProceduralSkeleton(spec), 'tail'), 'no bone named tail'))

{
  const rig = buildProceduralSkeleton(spec)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0], 3))
  bindSkin(geo, rig.skeleton, {
    joints: ['hips', 'neck', 'hips', 'hips', 'head', 'head', 'head', 'head'],
    weights: [2, 2, 0, 0, 1, 3, 0, 0],
  })
  const w = geo.attributes.skinWeight.array
  const idx = geo.attributes.skinIndex.array
  expect('vertex weights are normalised to sum 1', Math.abs(w[0] + w[1] + w[2] + w[3] - 1) < 1e-6 && Math.abs(w[0] - 0.5) < 1e-6, `w=${Array.from(w)}`)
  expect('joint names resolve to bone indices', idx[0] === 0 && idx[1] === 1 && idx[4] === 2, `idx=${Array.from(idx)}`)
}

expect('a skin with the wrong entry count is refused', throwsWith(() => {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  bindSkin(geo, buildProceduralSkeleton(spec).skeleton, { joints: [0, 0], weights: [1, 0] })
}, 'influences per vertex'))

expect('an unknown joint name is refused', throwsWith(() => {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  bindSkin(geo, buildProceduralSkeleton(spec).skeleton, { joints: ['tail', 'tail', 'tail', 'tail'], weights: [1, 0, 0, 0] })
}, 'not a bone of the skeleton'))

expect('a vertex with no weight is refused', throwsWith(() => {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3))
  bindSkin(geo, buildProceduralSkeleton(spec).skeleton, { joints: [0, 0, 0, 0], weights: [0, 0, 0, 0] })
}, 'has no weight'))

{
  const rig = buildProceduralSkeleton(spec)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 1.8, 0.7, 0, 1, 0], 3))
  const mesh = createSkinnedBody(geo, new THREE.MeshBasicMaterial(), rig, {
    joints: ['head', 'head', 'head', 'head', 'hips', 'hips', 'hips', 'hips'],
    weights: [1, 0, 0, 0, 1, 0, 0, 0],
  })
  expect('createSkinnedBody returns a SkinnedMesh bound to the rig', mesh.isSkinnedMesh === true && mesh.skeleton === rig.skeleton)
  boneOf(rig, 'head').rotation.x = Math.PI / 2
  mesh.updateMatrixWorld(true)
  rig.skeleton.update()
  const v = new THREE.Vector3()
  mesh.getVertexPosition(0, v)
  expect('a rotated head bone moves the skinned vertex it owns', v.distanceTo(new THREE.Vector3(0, 1.8, 0.7)) > 0.3, `v=${v.toArray()}`)
  const fixed = new THREE.Vector3()
  mesh.getVertexPosition(1, fixed)
  expect('a vertex owned by the hips stays put when the head turns', fixed.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6, `fixed=${fixed.toArray()}`)
}

{
  const rig = buildProceduralSkeleton(spec)
  const ear = new THREE.Object3D()
  attachToBone(rig, 'head', ear)
  expect('attachToBone parents the object to the named bone', ear.parent === boneOf(rig, 'head'))
  expect('attachToBone refuses a missing bone', throwsWith(() => attachToBone(rig, 'tail', new THREE.Object3D()), 'no bone named tail'))
}

if (failures > 0) {
  console.log(`RESULT: FAIL ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: PASS')
