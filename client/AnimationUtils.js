import * as THREE from 'three'

export const ANIM_TO_BLENDER = {
  root: 'root', hips: 'hips', spine: 'spine', chest: 'chest', upperChest: 'chest',
  neck: 'neck', head: 'head',
  leftShoulder: 'shoulderL', rightShoulder: 'shoulderR',
  leftArm: 'upper_armL', leftUpperArm: 'upper_armL', leftLowerArm: 'lower_armL', leftHand: 'handL',
  rightArm: 'upper_armR', rightUpperArm: 'upper_armR', rightLowerArm: 'lower_armR', rightHand: 'handR',
  leftUpperLeg: 'upper_legL', leftLowerLeg: 'lower_legL', leftFoot: 'footL', leftToes: 'toesL',
  rightUpperLeg: 'upper_legR', rightLowerLeg: 'lower_legR', rightFoot: 'footR', rightToes: 'toesR',
}

export const ANIM_TO_MIXAMO = {
  root: 'root', hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2',
  neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', rightShoulder: 'RightShoulder',
  leftArm: 'LeftArm', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightArm: 'RightArm', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
}

export const LOWER_BODY_BONES = new Set([
  'root', 'hips', 'pelvis',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
  'leftUpLeg', 'leftLeg', 'leftFoot', 'leftToeBase',
  'rightUpLeg', 'rightLeg', 'rightFoot', 'rightToeBase',
  'lUpLeg', 'lLeg', 'lFoot', 'lToe',
  'rUpLeg', 'rLeg', 'rFoot', 'rToe',
  'Normalized_hips', 'Normalized_upper_legL', 'Normalized_upper_legR',
  'Normalized_lower_legL', 'Normalized_lower_legR',
  'Normalized_footL', 'Normalized_footR',
  'Normalized_toesL', 'Normalized_toesR',
  'upper_legL', 'upper_legR', 'lower_legL', 'lower_legR',
  'footL', 'footR', 'toesL', 'toesR'
])

export function extractBoneName(trackName) {
  const m = trackName.match(/\.bones\[([^\]]+)\]/)
  if (m) return m[1]
  return trackName.split('.')[0]
}

export function filterUpperBodyTracks(clip) {
  const tracks = clip.tracks.filter(t => !LOWER_BODY_BONES.has(extractBoneName(t.name)))
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export function buildValidBoneSet(targetObj) {
  const bones = new Set()
  targetObj.traverse(c => { if (c.name) bones.add(c.name) })
  return bones
}

export function filterValidClipTracks(clip, validBones) {
  const valid = clip.tracks.filter(t => validBones.has(extractBoneName(t.name)))
  if (valid.length < clip.tracks.length) return new THREE.AnimationClip(clip.name, clip.duration, valid)
  return clip
}

export function detectBoneNameMap(scene) {
  const boneNames = new Set()
  scene.traverse(c => { if (c.name) boneNames.add(c.name) })
  const blenderMatches = Object.values(ANIM_TO_BLENDER).filter(n => boneNames.has(n)).length
  const mixamoMatches = Object.values(ANIM_TO_MIXAMO).filter(n => boneNames.has(n)).length
  const directMatches = Object.keys(ANIM_TO_BLENDER).filter(n => boneNames.has(n)).length
  if (directMatches >= blenderMatches && directMatches >= mixamoMatches) return null
  if (blenderMatches >= mixamoMatches) return ANIM_TO_BLENDER
  return ANIM_TO_MIXAMO
}

export function remapClip(clip, boneMap, validBones) {
  const tracks = []
  for (const track of clip.tracks) {
    const dot = track.name.indexOf('.')
    const boneName = dot >= 0 ? track.name.slice(0, dot) : track.name
    const prop = dot >= 0 ? track.name.slice(dot) : ''
    const mapped = boneMap[boneName] ?? boneName
    if (!validBones.has(mapped)) continue
    const newTrack = track.clone()
    newTrack.name = mapped + prop
    tracks.push(newTrack)
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

export function buildVRM0NormalizedRemap(vrm) {
  const remap = new Map()
  if (!vrm.humanoid) return remap
  const humanBones = vrm.humanoid.humanBones || {}
  for (const boneName of Object.keys(humanBones)) {
    const rawNode = vrm.humanoid.getRawBoneNode?.(boneName)
    const normNode = vrm.humanoid.getNormalizedBoneNode?.(boneName)
    if (rawNode && normNode && rawNode !== normNode) {
      remap.set(rawNode.name, normNode.name)
      remap.set(boneName, normNode.name)
    }
  }
  return remap
}

export function remapClipToNormalized(clip, remap) {
  if (!remap.size) return clip
  const tracks = clip.tracks.map(track => {
    const dot = track.name.indexOf('.')
    const boneName = dot >= 0 ? track.name.slice(0, dot) : track.name
    const prop = dot >= 0 ? track.name.slice(dot) : ''
    const mapped = remap.get(boneName)
    if (!mapped) return track
    const newTrack = track.clone()
    newTrack.name = mapped + prop
    return newTrack
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}
