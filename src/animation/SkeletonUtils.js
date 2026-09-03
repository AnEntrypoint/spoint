import * as THREE from 'three'

const _q0 = new THREE.Quaternion()
const _q1 = new THREE.Quaternion()
const _v0 = new THREE.Vector3()
const _v1 = new THREE.Vector3()

export class SkeletonUtils {
  static findBoneByName(skeleton, boneName) {
    if (!skeleton || !skeleton.bones) return null
    for (const bone of skeleton.bones) {
      if (bone.name === boneName) return bone
    }
    return null
  }

  static findBoneByHumanoidName(skeleton, humanoidName) {
    if (!skeleton || !skeleton.bones) return null
    const nameMap = {
      'hips': ['Hips', 'hips', 'armature|hips', 'root'],
      'spine': ['Spine', 'spine', 'armature|spine'],
      'chest': ['Chest', 'chest', 'armature|chest'],
      'neck': ['Neck', 'neck', 'armature|neck'],
      'head': ['Head', 'head', 'armature|head'],
      'leftShoulder': ['LeftShoulder', 'shoulder.l', 'armature|shoulder.l'],
      'rightShoulder': ['RightShoulder', 'shoulder.r', 'armature|shoulder.r'],
      'leftUpperArm': ['LeftArm', 'upper_armL', 'armature|upper_arm.l'],
      'rightUpperArm': ['RightArm', 'upper_armR', 'armature|upper_arm.r'],
      'leftLowerArm': ['LeftForeArm', 'lower_armL', 'armature|forearm.l'],
      'rightLowerArm': ['RightForeArm', 'lower_armR', 'armature|forearm.r'],
      'leftHand': ['LeftHand', 'handL', 'armature|hand.l'],
      'rightHand': ['RightHand', 'handR', 'armature|hand.r'],
      'leftUpperLeg': ['LeftUpLeg', 'upper_legL', 'armature|upper_leg.l'],
      'rightUpperLeg': ['RightUpLeg', 'upper_legR', 'armature|upper_leg.r'],
      'leftLowerLeg': ['LeftLeg', 'lower_legL', 'armature|lower_leg.l'],
      'rightLowerLeg': ['RightLeg', 'lower_legR', 'armature|lower_leg.r'],
      'leftFoot': ['LeftFoot', 'footL', 'armature|foot.l'],
      'rightFoot': ['RightFoot', 'footR', 'armature|foot.r'],
    }
    const candidates = nameMap[humanoidName] || [humanoidName]
    for (const bone of skeleton.bones) {
      if (candidates.includes(bone.name)) return bone
    }
    return null
  }

  static getRootBone(skeleton) {
    const hips = this.findBoneByHumanoidName(skeleton, 'hips')
    if (hips) return hips
    if (skeleton.bones && skeleton.bones.length > 0) return skeleton.bones[0]
    return null
  }

  static buildBoneMap(skeleton) {
    const map = new Map()
    if (!skeleton || !skeleton.bones) return map
    for (const bone of skeleton.bones) {
      map.set(bone.name, bone)
    }
    return map
  }

  static getLocalPosition(bone) {
    const v = bone.position.clone()
    return v
  }

  static setLocalPosition(bone, position) {
    bone.position.copy(position)
  }

  static getLocalQuaternion(bone) {
    return bone.quaternion.clone()
  }

  static setLocalQuaternion(bone, quaternion) {
    bone.quaternion.copy(quaternion)
  }

  static interpolateQuaternion(q1, q2, t) {
    const result = new THREE.Quaternion()
    THREE.Quaternion.slerpFlat(result, 0, q1, 0, q2, 0, t)
    return result
  }

  static interpolateVector3(v1, v2, t) {
    const result = v1.clone()
    result.lerp(v2, t)
    return result
  }

  static packQuaternion(quat, buffer, offset = 0) {
    const n = quat.length()
    const nx = quat.x / Math.max(n, 0.001)
    const ny = quat.y / Math.max(n, 0.001)
    const nz = quat.z / Math.max(n, 0.001)
    const nw = quat.w / Math.max(n, 0.001)
    buffer[offset] = Math.round(nx * 32767)
    buffer[offset + 1] = Math.round(ny * 32767)
    buffer[offset + 2] = Math.round(nz * 32767)
    buffer[offset + 3] = Math.round(nw * 32767)
  }

  static unpackQuaternion(buffer, offset = 0) {
    const q = new THREE.Quaternion()
    q.x = buffer[offset] / 32767
    q.y = buffer[offset + 1] / 32767
    q.z = buffer[offset + 2] / 32767
    q.w = buffer[offset + 3] / 32767
    return q.normalize()
  }

  static packSkeletonState(skeleton, buffer, offset = 0) {
    if (!skeleton || !skeleton.bones) return offset
    const stride = 4
    for (const bone of skeleton.bones) {
      this.packQuaternion(bone.quaternion, buffer, offset)
      offset += stride
    }
    return offset
  }

  static unpackSkeletonState(skeleton, buffer, offset = 0) {
    if (!skeleton || !skeleton.bones) return offset
    const stride = 4
    for (const bone of skeleton.bones) {
      this.unpackQuaternion(buffer, offset)
      bone.quaternion.copy(this.unpackQuaternion(buffer, offset))
      offset += stride
    }
    return offset
  }
}

export default SkeletonUtils
