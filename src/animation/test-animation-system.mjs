import * as THREE from 'three'
import { AnimationSystem } from './AnimationSystem.js'
import { SkeletonUtils } from './SkeletonUtils.js'
import { BlendTree1D, BlendTree2D } from './BlendTree.js'

const _v0 = new THREE.Vector3()
const _q0 = new THREE.Quaternion()

export async function testAnimationSystem() {
  console.log('[test-animation-system] Starting tests...')

  const results = {
    passed: 0,
    failed: 0,
    tests: [],
  }

  function assert(condition, testName) {
    if (condition) {
      results.passed++
      results.tests.push({ name: testName, status: 'PASS' })
      console.log(`✓ ${testName}`)
    } else {
      results.failed++
      results.tests.push({ name: testName, status: 'FAIL' })
      console.error(`✗ ${testName}`)
    }
  }

  const bones = []
  for (let i = 0; i < 10; i++) {
    const bone = new THREE.Bone()
    bone.name = i === 0 ? 'Hips' : `Bone_${i}`
    if (i > 0) bones[i - 1].add(bone)
    bones.push(bone)
  }

  const skeleton = new THREE.Skeleton(bones)
  const skinnedMesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), skeleton)

  console.log('\n--- Testing SkeletonUtils ---')

  const hipBone = SkeletonUtils.findBoneByHumanoidName(skeleton, 'hips')
  assert(hipBone !== null && hipBone.name === 'Hips', 'Find hip bone by humanoid name')

  const boneMap = SkeletonUtils.buildBoneMap(skeleton)
  assert(boneMap.size === bones.length, 'Build bone map')

  const rootBone = SkeletonUtils.getRootBone(skeleton)
  assert(rootBone !== null, 'Get root bone')

  const q1 = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5).normalize()
  const packedBuffer = new Int16Array(4)
  SkeletonUtils.packQuaternion(q1, packedBuffer, 0)
  const unpackedQ = SkeletonUtils.unpackQuaternion(packedBuffer, 0)
  assert(Math.abs(q1.x - unpackedQ.x) < 0.01, 'Quaternion packing/unpacking precision')

  console.log('\n--- Testing BlendTree1D ---')

  const clip1 = new THREE.AnimationClip('Idle', 1, [])
  const clip2 = new THREE.AnimationClip('Walk', 2, [])
  const clip3 = new THREE.AnimationClip('Run', 2, [])

  const blendTree1D = new BlendTree1D()
  blendTree1D.addClip(clip1, 0).addClip(clip2, 2).addClip(clip3, 5)

  blendTree1D.setParameter(0)
  let weights = blendTree1D.getWeights()
  assert(weights[0] === 1 && weights[1] === 0 && weights[2] === 0, 'BlendTree1D at threshold 0')

  blendTree1D.setParameter(3)
  weights = blendTree1D.getWeights()
  assert(Math.abs(weights[1] - 0.67) < 0.1 && Math.abs(weights[2] - 0.33) < 0.1, 'BlendTree1D interpolation')

  blendTree1D.setParameter(10)
  weights = blendTree1D.getWeights()
  assert(weights[2] === 1, 'BlendTree1D at high threshold')

  console.log('\n--- Testing BlendTree2D ---')

  const blendTree2D = new BlendTree2D()
  blendTree2D.addClip(clip1, 0, 0)
  blendTree2D.addClip(clip2, 1, 0)
  blendTree2D.addClip(clip3, 0, 1)

  blendTree2D.setParameter(0, 0)
  weights = blendTree2D.getWeights()
  assert(weights[0] === 1, '2D blend at center')

  blendTree2D.setParameter(0.5, 0.5)
  weights = blendTree2D.getWeights()
  assert(weights[0] > 0 && weights[1] > 0 && weights[2] > 0, '2D blend with multiple weights')

  console.log('\n--- Testing AnimationSystem ---')

  const animSystem = new AnimationSystem(skinnedMesh, {
    clips: [clip1, clip2, clip3],
    enableIK: true,
  })

  assert(animSystem.skeleton !== null, 'AnimationSystem creates skeleton')
  assert(animSystem.blender !== null, 'AnimationSystem creates blender')
  assert(animSystem.ikRig !== null, 'AnimationSystem creates IK rig')

  const bone = animSystem.getSkeletonBone('Hips')
  assert(bone !== null, 'Get skeleton bone by humanoid name')

  animSystem.addClip('Idle', clip1)
  assert(animSystem.blender.clips.has('Idle'), 'Register animation clip')

  animSystem.initializeController()
  assert(animSystem.controller !== null, 'Initialize animation controller')

  const initialState = animSystem.controller.getState()
  assert(initialState === 'idle', 'Controller starts in idle state')

  animSystem.controller.update(1 / 60, {
    speed: 2,
    isGrounded: true,
  })

  const movedState = animSystem.controller.getState()
  assert(movedState === 'walk', 'Controller transitions to walk on speed > 1.5')

  console.log('\n--- Testing Skeleton State Packing ---')

  const stateBuffer = new Int16Array(skeleton.bones.length * 4)
  const offset = animSystem.packSkeletonState(stateBuffer)
  assert(offset === skeleton.bones.length * 4, 'Pack skeleton state buffer')

  animSystem.unpackSkeletonState(stateBuffer)
  let allIdentity = true
  for (const bone of skeleton.bones) {
    if (Math.abs(bone.quaternion.w - 1) > 0.01) {
      allIdentity = false
    }
  }
  assert(allIdentity, 'Unpack skeleton state (identity quaternions)')

  animSystem.dispose()

  console.log(`\n=== Test Results ===`)
  console.log(`Passed: ${results.passed}`)
  console.log(`Failed: ${results.failed}`)
  console.log(`Total: ${results.passed + results.failed}`)

  return results
}

testAnimationSystem().catch(e => console.error('Test failed:', e))
