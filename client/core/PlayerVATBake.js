// Baked vertex-animation-texture (VAT) bake pipeline: samples a real THREE.AnimationMixer at a fixed
// rate and encodes post-skin position+normal deltas into float DataTextures. Split from PlayerVAT.js --
// the GPU crowd material/renderer that CONSUMES these bakes stays there. See that file's own header for
// the full VAT design rationale (why this exists, multi-clip blend, normal-delta lighting follow-on).

import * as THREE from 'three'

// window.__tickAnimTiming / _tickAnimSamples live in app.js (the actual call site) -- this module only
// consumes the resulting bake/renderer, it doesn't own the timing surface.

const VAT_SAMPLE_HZ = 24 // resample rate baked into the texture; independent of the source clip's authored keyframe spacing (same discipline as AnimationClipCache.js's RESAMPLE_HZ)

const _vtmp = new THREE.Vector3()
const _baseVec = new THREE.Vector3()
const _bindPos = new THREE.Vector3()
const _boneMtx = new THREE.Matrix4()
/**
 * Computes the post-skin world-space (mesh-local-space, i.e. relative to the SkinnedMesh's own
 * unmoved transform) position of vertex `vi` on `skinnedMesh` at its CURRENT pose (caller must have
 * already advanced the driving AnimationMixer + called skeleton.update() before calling this).
 * Exactly mirrors THREE.SkinnedMesh.applyBoneTransform's own CPU skin math (see
 * three/src/objects/SkinnedMesh.js): baseVector = bindPos * bindMatrix, accumulate per-bone
 * (bone.matrixWorld * boneInverse) * baseVector weighted, then multiply by bindMatrixInverse -- NOT the
 * skeleton's own precomputed boneMatrices array directly (that buffer already premultiplies bindMatrix
 * differently for GPU upload; reproducing the CPU-path formula verbatim, bone-by-bone, is what keeps
 * this bake bit-identical to what the GPU skinning path would have rendered).
 */
function boneTransformInto(skinnedMesh, vi, target) {
  const geometry = skinnedMesh.geometry
  const skeleton = skinnedMesh.skeleton
  const posAttr = geometry.attributes.position
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight
  // _baseVec is a SEPARATE scratch from `target` -- target is caller-supplied and may alias a module-level
  // scratch (bakeVAT passes _vtmp as target); reusing the same scratch for the internal base-vector AND the
  // output accumulator caused target.set(0,0,0) below to wipe the base vector before it was consumed
  // (found live: every baked frame read back as the raw un-skinned bind pose, a large CONSTANT delta at
  // "frame 0" that should have been ~0 -- traced to exactly this aliasing bug).
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
/**
 * Computes the post-skin (mesh-local-space) NORMAL of vertex `vi` at the CURRENT pose, writing it into
 * `target`. Mirrors three's own GPU `skinnormal_vertex` chunk (see
 * three/src/renderers/shaders/ShaderChunk/skinnormal_vertex.glsl.js) verbatim rather than a generic
 * inverse-transpose normal-matrix recompute: skinMatrix = bindMatrixInverse * (per-bone-weighted sum of
 * boneMatrices) * bindMatrix, then objectNormal = skinMatrix * vec4(objectNormal, 0.0) -- a plain LINEAR
 * transform (w=0, no translation row), NOT a proper inverse-transpose normal-matrix; GPU skinning doesn't
 * correct for non-uniform scale either, so reproducing that exact (non-)correction is what keeps this
 * bake bit-identical to what the GPU skinning path would have rendered, same discipline as
 * boneTransformInto above. Matrix summation IS valid here (not an approximation): matrix multiplication
 * is linear, so sum(w_i * M_i) * v === sum(w_i * (M_i * v)) for any v -- weighting the MATRICES first
 * (like the GPU chunk does) and weighting the TRANSFORMED VECTORS first (like boneTransformInto does for
 * position) are mathematically identical; the position path already accumulates transformed vectors, this
 * one accumulates the matrices per source verbatim to mirror the shader chunk line-for-line for easy
 * cross-reference, both are correct.
 */
function boneTransformNormalInto(skinnedMesh, vi, target) {
  const geometry = skinnedMesh.geometry
  const skeleton = skinnedMesh.skeleton
  const normalAttr = geometry.attributes.normal
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight
  _baseNrm.fromBufferAttribute(normalAttr, vi)
  _accumMtx.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0) // zero matrix accumulator (skinMatrix += ...)
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
  // Deliberately NOT Vector3.transformDirection (it normalizes) -- the GPU skinnormal_vertex chunk this
  // mirrors does a plain un-normalized mat4*vec4(n,0) transform; normalize_vertex/normal_fragment_begin
  // downstream normalize exactly once, after normalMatrix + instancing are also applied, so normalizing
  // here would double-normalize a not-yet-fully-transformed intermediate and desync from what the GPU
  // skinning path (and this bake's own bit-identical-parity goal) actually produces.
  const e = _skinMtx.elements
  target.set(
    e[0] * _baseNrm.x + e[4] * _baseNrm.y + e[8] * _baseNrm.z,
    e[1] * _baseNrm.x + e[5] * _baseNrm.y + e[9] * _baseNrm.z,
    e[2] * _baseNrm.x + e[6] * _baseNrm.y + e[10] * _baseNrm.z
  )
  return target
}

/**
 * Bakes `clip` on `skinnedMesh` (must already be skeleton-bound, i.e. skinnedMesh.skeleton is the real
 * pose skeleton, bindMatrixInverse set) into a VAT DataTexture pair. Returns
 * {texture, normalTexture, frameCount, vertexCount, duration, sampleHz} -- both textures are
 * (vertexCount wide) x (frameCount tall), RGBA32F, same (vertexIndex, frame) texel addressing. `texture`'s
 * rgb = (post-skin - bind-pose) POSITION delta for that vertex at that sampled frame (unchanged from the
 * first slice). `normalTexture`'s rgb = (post-skin - bind-pose) un-normalized NORMAL delta (see
 * boneTransformNormalInto's header for why it's deliberately un-normalized), animation-vat-normal-delta-
 * lighting's follow-on: sampling+adding this alongside the position delta lets REDUCED-tier crowd
 * lighting respond to the animated pose instead of shading against the static bind-pose normal baked into
 * the base geometry. Alpha unused on both (reserved, kept at 1 so non-EXT_color_buffer_float readback
 * tooling still sees a valid alpha channel). normalTexture is null if the source mesh has no `normal`
 * attribute (degrades to the pre-existing bind-pose-normal-only behavior, same as before this follow-on).
 *
 * Runs on a REAL THREE.AnimationMixer bound to the mesh's root (mixer.clipAction(clip).play()),
 * advancing mixer.update(dt) at VAT_SAMPLE_HZ and reading back the real post-skin vertex positions (and
 * normals) each step -- not an approximation, the literal same CPU skin math THREE performs to render a
 * frame, captured once instead of every frame forever. The normal sample piggybacks on the SAME per-frame
 * per-vertex loop the position sample already runs (incremental cost on an already-running pass, not a
 * second bake pass), per the row's explicit guidance.
 */
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

  // Cap texture width at a hardware-safe size; vertexCount for a typical VRM body mesh (a few thousand)
  // comfortably fits one row, so this only matters for an unusually dense source mesh.
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
    mixer.update(0) // 0-dt update after directly setting action.time -- applies the pose for this exact sample time without accumulating drift
    // mixer.update only writes the new LOCAL bone quaternion/position; matrixWorld (what boneTransformInto
    // actually reads) is stale until the hierarchy is re-propagated. skeleton.update() alone is NOT enough
    // -- it recomputes boneMatrices FROM bone.matrixWorld, so a missing updateMatrixWorld here silently
    // bakes every frame at the bind pose (found live: frame-0 delta was a large CONSTANT offset instead of
    // ~0, traced to exactly this missing call).
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

/**
 * Bakes MULTIPLE clips against the same skinnedMesh/mixerRoot into independent VAT textures sharing one
 * vertex-index layout (same skinnedMesh.geometry -> same vatVertexIndex attribute works for all of them).
 * `clipsByName` is a Map/plain-object of name -> THREE.AnimationClip; `names` picks which entries to bake
 * and in what order (defaults to every key). Returns { idle, move, names, ... } -- `idle` and `move` are
 * the first two baked vatData results (the only two createVATCrowdRenderer's blend path consumes today),
 * plus `byName` for direct lookup if more than 2 are ever baked.
 */
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
