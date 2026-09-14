import * as THREE from 'three'

const VAT_SAMPLE_HZ = 24

const _vtmp = new THREE.Vector3()
const _baseVec = new THREE.Vector3()
const _bindPos = new THREE.Vector3()
const _boneMtx = new THREE.Matrix4()
function boneTransformInto(skinnedMesh, vi, target) {
  const geometry = skinnedMesh.geometry
  const skeleton = skinnedMesh.skeleton
  const posAttr = geometry.attributes.position
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight
  _baseVec.fromBufferAttribute(posAttr, vi).applyMatrix4(skinnedMesh.bindMatrix)
  target.set(0, 0, 0)
  for (let j = 0; j < 4; j++) {
    const weight = skinWeight.getComponent(vi, j)
    if (weight === 0) continue
    const boneIndex = skinIndex.getComponent(vi, j)
    _boneMtx.multiplyMatrices(skeleton.bones[boneIndex].matrixWorld, skeleton.boneInverses[boneIndex])
    const p = _baseVec.clone().applyMatrix4(_boneMtx)
    target.x += p.x * weight; target.y += p.y * weight; target.z += p.z * weight
  }
  target.applyMatrix4(skinnedMesh.bindMatrixInverse)
  return target
}

const _baseNrm = new THREE.Vector3()
const _skinnedNrm = new THREE.Vector3()
const _skinMtx = new THREE.Matrix4()
const _accumMtx = new THREE.Matrix4()
const _weightedMtx = new THREE.Matrix4()
function boneTransformNormalInto(skinnedMesh, vi, target) {
  const geometry = skinnedMesh.geometry
  const skeleton = skinnedMesh.skeleton
  const normalAttr = geometry.attributes.normal
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight
  _baseNrm.fromBufferAttribute(normalAttr, vi)
  _accumMtx.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  for (let j = 0; j < 4; j++) {
    const weight = skinWeight.getComponent(vi, j)
    if (weight === 0) continue
    const boneIndex = skinIndex.getComponent(vi, j)
    _boneMtx.multiplyMatrices(skeleton.bones[boneIndex].matrixWorld, skeleton.boneInverses[boneIndex])
    _weightedMtx.copy(_boneMtx)
    for (let k = 0; k < 16; k++) _weightedMtx.elements[k] *= weight
    for (let k = 0; k < 16; k++) _accumMtx.elements[k] += _weightedMtx.elements[k]
  }
  _skinMtx.multiplyMatrices(skinnedMesh.bindMatrixInverse, _accumMtx)
  _skinMtx.multiply(skinnedMesh.bindMatrix)
  const e = _skinMtx.elements
  target.set(
    e[0] * _baseNrm.x + e[4] * _baseNrm.y + e[8] * _baseNrm.z,
    e[1] * _baseNrm.x + e[5] * _baseNrm.y + e[9] * _baseNrm.z,
    e[2] * _baseNrm.x + e[6] * _baseNrm.y + e[10] * _baseNrm.z
  )
  return target
}

export function bakeVAT(skinnedMesh, mixerRoot, clip, opts = {}) {
  const sampleHz = opts.sampleHz || VAT_SAMPLE_HZ
  const geometry = skinnedMesh.geometry
  const posAttr = geometry.attributes.position
  const normalAttr = geometry.attributes.normal
  const hasNormals = !!normalAttr
  const vertexCount = posAttr.count
  const dt = 1 / sampleHz
  const frameCount = Math.max(2, Math.ceil(clip.duration * sampleHz) + 1)

  const mixer = new THREE.AnimationMixer(mixerRoot)
  const action = mixer.clipAction(clip)
  action.play()
  action.paused = true

  const maxTexSize = opts.maxTexSize || 4096
  const width = Math.min(vertexCount, maxTexSize)
  const rowsPerFrame = Math.ceil(vertexCount / width)
  const height = frameCount * rowsPerFrame

  const data = new Float32Array(width * height * 4)
  const normalData = hasNormals ? new Float32Array(width * height * 4) : null
  const _bindNrm = new THREE.Vector3()

  for (let f = 0; f < frameCount; f++) {
    const t = Math.min(f * dt, clip.duration)
    action.time = t
    mixer.update(0)
    mixerRoot.updateMatrixWorld(true)
    skinnedMesh.skeleton.update()
    for (let vi = 0; vi < vertexCount; vi++) {
      boneTransformInto(skinnedMesh, vi, _vtmp)
      _bindPos.fromBufferAttribute(posAttr, vi)
      const row = f * rowsPerFrame + Math.floor(vi / width)
      const col = vi % width
      const idx = (row * width + col) * 4
      data[idx] = _vtmp.x - _bindPos.x
      data[idx + 1] = _vtmp.y - _bindPos.y
      data[idx + 2] = _vtmp.z - _bindPos.z
      data[idx + 3] = 1
      if (hasNormals) {
        boneTransformNormalInto(skinnedMesh, vi, _skinnedNrm)
        _bindNrm.fromBufferAttribute(normalAttr, vi)
        normalData[idx] = _skinnedNrm.x - _bindNrm.x
        normalData[idx + 1] = _skinnedNrm.y - _bindNrm.y
        normalData[idx + 2] = _skinnedNrm.z - _bindNrm.z
        normalData[idx + 3] = 1
      }
    }
  }

  mixer.stopAllAction()
  mixer.uncacheAction(clip, mixerRoot)

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType)
  texture.needsUpdate = true
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false

  let normalTexture = null
  if (hasNormals) {
    normalTexture = new THREE.DataTexture(normalData, width, height, THREE.RGBAFormat, THREE.FloatType)
    normalTexture.needsUpdate = true
    normalTexture.minFilter = THREE.NearestFilter
    normalTexture.magFilter = THREE.NearestFilter
    normalTexture.wrapS = THREE.ClampToEdgeWrapping
    normalTexture.wrapT = THREE.ClampToEdgeWrapping
    normalTexture.generateMipmaps = false
  }

  return { texture, normalTexture, frameCount, vertexCount, width, rowsPerFrame, duration: clip.duration, sampleHz }
}

export function bakeVATMultiClip(skinnedMesh, mixerRoot, clipsByName, opts = {}) {
  const entries = clipsByName instanceof Map ? Array.from(clipsByName.entries()) : Object.entries(clipsByName)
  const names = opts.names || entries.map(([n]) => n)
  const byName = {}
  for (const name of names) {
    const clip = clipsByName instanceof Map ? clipsByName.get(name) : clipsByName[name]
    if (!clip) continue
    byName[name] = bakeVAT(skinnedMesh, mixerRoot, clip, opts)
  }
  const baked = names.map(n => byName[n]).filter(Boolean)
  return { idle: baked[0] || null, move: baked[1] || baked[0] || null, names, byName }
}
