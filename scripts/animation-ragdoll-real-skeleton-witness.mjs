import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const THREE = await import('../node_modules/three/build/three.module.js')
const { AnimationSystem } = await import('../src/animation/AnimationSystem.js')
const { parseRagdollActivation } = await import('../src/animation/ragdollActivation.js')
const { RAGDOLL_JOINTS } = await import('../src/animation/RagdollPose.js')

const names = ['Hips', 'Spine', 'Chest', 'Neck', 'Head']
const bones = names.map(n => { const b = new THREE.Bone(); b.name = n; return b })
for (let i = 1; i < bones.length; i++) bones[i - 1].add(bones[i])
const skeleton = new THREE.Skeleton(bones)
const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
mesh.add(bones[0])
mesh.bind(skeleton)
const sys = new AnimationSystem(mesh, { enableIK: false, clips: [] })
const pose = sys.setRagdollPlan(parseRagdollActivation({ all: 0.4, bones: { head: 0.1 } })).ragdoll
assert.ok(pose, 'setRagdollPlan must create a pose on the real skeleton')
assert.equal(pose.getStrength('head'), 0.1, 'the per-bone strength reaches the real pose')
assert.equal(pose.getStrength('spine'), 0.4, 'unnamed joints take the all strength on the real pose')
assert.equal(RAGDOLL_JOINTS.length, 16)
console.log('RESULT: PASS AnimationSystem builds headless on a real three.js skeleton and setRagdollPlan sets per-bone strength on the real RagdollPose (head 0.1, spine 0.4)')
