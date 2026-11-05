import * as THREE from 'three'

const SKIN_INFLUENCES = 4

function fail(message) {
  throw new Error(`[ProceduralSkeleton] ${message}`)
}

function pivotOf(name, entry) {
  const p = entry?.pivot
  if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) {
    fail(`bone ${name} needs a pivot of three finite numbers; got ${JSON.stringify(p)}`)
  }
  return new THREE.Vector3(p[0], p[1], p[2])
}

export function buildProceduralSkeleton(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('skeleton() must return an object keyed by bone name')
  const names = Object.keys(spec)
  if (names.length === 0) fail('skeleton() declares no bones')

  const rig = new THREE.Group()
  const bones = []
  const byName = new Map()
  const pivots = new Map()

  for (const name of names) {
    const entry = spec[name]
    const pivot = pivotOf(name, entry)
    const bone = new THREE.Bone()
    bone.name = name
    if (entry.parent === undefined) {
      bone.position.copy(pivot)
      rig.add(bone)
    } else {
      const parent = byName.get(entry.parent)
      if (!parent) fail(`bone ${name} names parent ${entry.parent}, which must be declared before it`)
      bone.position.copy(pivot).sub(pivots.get(entry.parent))
      parent.add(bone)
    }
    byName.set(name, bone)
    pivots.set(name, pivot)
    bones.push(bone)
  }

  const skeleton = new THREE.Skeleton(bones)
  rig.updateMatrixWorld(true)
  return { rig, bones, byName, skeleton }
}

export function boneOf(rig, name) {
  const bone = rig.byName.get(name)
  if (!bone) fail(`no bone named ${name}`)
  return bone
}

export function attachToBone(rig, name, object) {
  boneOf(rig, name).add(object)
  return object
}

function influenceIndexOf(skeleton, joint, vertex) {
  if (typeof joint === 'number') {
    if (!Number.isInteger(joint) || joint < 0 || joint >= skeleton.bones.length) {
      fail(`vertex ${vertex} names joint index ${joint}, outside 0..${skeleton.bones.length - 1}`)
    }
    return joint
  }
  const index = skeleton.bones.findIndex((b) => b.name === joint)
  if (index < 0) fail(`vertex ${vertex} names joint ${String(joint)}, which is not a bone of the skeleton`)
  return index
}

export function bindSkin(geometry, skeleton, skin) {
  const count = geometry.attributes.position?.count
  if (!Number.isInteger(count) || count <= 0) fail('geometry has no position attribute')
  if (!skin || !Array.isArray(skin.joints) || !Array.isArray(skin.weights)) fail('skin needs joints and weights arrays')
  const expected = count * SKIN_INFLUENCES
  if (skin.joints.length !== expected || skin.weights.length !== expected) {
    fail(`skin needs ${SKIN_INFLUENCES} influences per vertex: ${expected} entries, got joints=${skin.joints.length} weights=${skin.weights.length}`)
  }

  const indices = new Uint16Array(expected)
  const weights = new Float32Array(expected)
  for (let v = 0; v < count; v += 1) {
    let sum = 0
    for (let k = 0; k < SKIN_INFLUENCES; k += 1) {
      const i = v * SKIN_INFLUENCES + k
      const w = skin.weights[i]
      if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) fail(`vertex ${v} has weight ${String(w)}; weights need finite values of at least 0`)
      indices[i] = w === 0 ? 0 : influenceIndexOf(skeleton, skin.joints[i], v)
      weights[i] = w
      sum += w
    }
    if (!(sum > 0)) fail(`vertex ${v} has no weight`)
    for (let k = 0; k < SKIN_INFLUENCES; k += 1) weights[v * SKIN_INFLUENCES + k] /= sum
  }

  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, SKIN_INFLUENCES))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, SKIN_INFLUENCES))
  return geometry
}

export function createSkinnedBody(geometry, material, rig, skin) {
  bindSkin(geometry, rig.skeleton, skin)
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.add(rig.rig)
  mesh.bind(rig.skeleton)
  return mesh
}
