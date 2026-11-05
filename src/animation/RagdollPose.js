import { SkeletonUtils } from './SkeletonUtils.js'

export const RAGDOLL_JOINTS = Object.freeze([
  'spine', 'chest', 'neck', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
])

export class RagdollPoseError extends Error {
  constructor(code, message) {
    super(`[RagdollPose] ${message}`)
    this.name = 'RagdollPoseError'
    this.code = code
  }
}

const unitStrength = (name, value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RagdollPoseError('bad-strength', `strength for "${name}" must be a finite number in [0, 1], got ${value}`)
  }
  return value
}

export class RagdollPose {
  constructor(skeleton, options = {}) {
    if (!skeleton || !skeleton.bones) {
      throw new RagdollPoseError('no-skeleton', 'a skeleton with bones is required')
    }
    this.stiffness = options.stiffness ?? 40
    this.limpRate = options.limpRate ?? 3
    if (!(this.stiffness > 0) || !(this.limpRate > 0)) {
      throw new RagdollPoseError('bad-rate', 'stiffness and limpRate must be positive')
    }
    this.anchor = SkeletonUtils.findBoneByHumanoidName(skeleton, options.anchor ?? 'hips')
    if (!this.anchor) {
      throw new RagdollPoseError('no-anchor', 'the kinematic anchor bone was not found')
    }
    this.joints = []
    this.byName = new Map()
    const strengths = options.strengths ?? {}
    for (const name of RAGDOLL_JOINTS) {
      const bone = SkeletonUtils.findBoneByHumanoidName(skeleton, name)
      if (!bone || bone === this.anchor) continue
      const joint = {
        name,
        bone,
        strength: unitStrength(name, strengths[name] ?? 1),
        rest: bone.quaternion.clone(),
        state: bone.quaternion.clone(),
      }
      this.joints.push(joint)
      this.byName.set(name, joint)
    }
    for (const name of Object.keys(strengths)) {
      if (!this.byName.has(name)) {
        throw new RagdollPoseError('unknown-joint', `no ragdoll joint named "${name}" on this skeleton`)
      }
    }
  }

  setStrength(name, value) {
    const joint = this.byName.get(name)
    if (!joint) {
      throw new RagdollPoseError('unknown-joint', `no ragdoll joint named "${name}" on this skeleton`)
    }
    joint.strength = unitStrength(name, value)
    return this
  }

  getStrength(name) {
    const joint = this.byName.get(name)
    if (!joint) {
      throw new RagdollPoseError('unknown-joint', `no ragdoll joint named "${name}" on this skeleton`)
    }
    return joint.strength
  }

  setAll(value) {
    unitStrength('*', value)
    for (const joint of this.joints) joint.strength = value
    return this
  }

  snapToAnimated() {
    for (const joint of this.joints) joint.state.copy(joint.bone.quaternion)
    return this
  }

  apply(dt) {
    for (const joint of this.joints) {
      const { bone, state, rest, strength } = joint
      const target = strength > 0 ? bone.quaternion : rest
      const rate = strength > 0 ? this.stiffness * strength : this.limpRate
      const alpha = 1 - Math.exp(-rate * dt)
      state.slerp(target, alpha)
      bone.quaternion.copy(state)
    }
    return this
  }
}

export default RagdollPose
