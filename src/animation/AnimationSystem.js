import * as THREE from 'three'
import { SkeletonUtils } from './SkeletonUtils.js'
import { AnimationBlender, BlendTree1D, BlendTree2D } from './BlendTree.js'
import { IKRig, TwoBoneIKSolver } from './IKSolver.js'
import createAnimationController from './AnimationController.js'
import { RagdollPose } from './RagdollPose.js'
import { createShapeKeyDriver } from './ShapeKeys.js'

export class AnimationSystem {
  constructor(model, options = {}) {
    this.model = model
    this.skeleton = model.skeleton || this._extractSkeleton(model)
    this.mixer = new THREE.AnimationMixer(model)
    this.ikRig = new IKRig(this.skeleton)

    this.blender = new AnimationBlender(this.mixer, options.clips || [])
    this.controller = null

    this.options = {
      enableIK: options.enableIK !== false,
      enableFootIK: options.enableFootIK !== false,
      blendMode: options.blendMode || '1d',
      raycastCallback: options.raycastCallback || null,
      ...options,
    }

    if (this.options.enableIK) {
      this._setupIK()
    }
  }

  _extractSkeleton(model) {
    if (model.skeleton) return model.skeleton
    if (model instanceof THREE.SkinnedMesh && model.skeleton) return model.skeleton

    let skeleton = null
    model.traverse((node) => {
      if (!skeleton && node instanceof THREE.SkinnedMesh && node.skeleton) {
        skeleton = node.skeleton
      }
    })

    if (!skeleton) {
      const bones = []
      const boneSet = new Set()
      model.traverse((node) => {
        if ((node instanceof THREE.Bone || node.isBone) && !boneSet.has(node)) {
          bones.push(node)
          boneSet.add(node)
        }
      })
      if (bones.length > 0) {
        skeleton = new THREE.Skeleton(bones)
      }
    }

    return skeleton
  }

  _setupIK() {
    if (!this.skeleton || !this.skeleton.bones) return

    const boneMap = SkeletonUtils.buildBoneMap(this.skeleton)

    const leftUpperArm = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'leftUpperArm')
    const leftLowerArm = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'leftLowerArm')
    const leftHand = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'leftHand')

    if (leftUpperArm && leftLowerArm && leftHand) {
      const leftArmIK = new TwoBoneIKSolver(leftUpperArm, leftLowerArm, leftHand)
      const leftChain = this.ikRig.createChain('leftArm')
      leftChain.addSolver(leftArmIK)
    }

    const rightUpperArm = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'rightUpperArm')
    const rightLowerArm = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'rightLowerArm')
    const rightHand = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'rightHand')

    if (rightUpperArm && rightLowerArm && rightHand) {
      const rightArmIK = new TwoBoneIKSolver(rightUpperArm, rightLowerArm, rightHand)
      const rightChain = this.ikRig.createChain('rightArm')
      rightChain.addSolver(rightArmIK)
    }

    if (this.options.enableFootIK && this.options.raycastCallback) {
      this._setupFootGrounding()
    }
  }

  _setupFootGrounding() {
    const hips = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'hips')
    const legs = []
    for (const side of ['left', 'right']) {
      const upper = SkeletonUtils.findBoneByHumanoidName(this.skeleton, `${side}UpperLeg`)
      const lower = SkeletonUtils.findBoneByHumanoidName(this.skeleton, `${side}LowerLeg`)
      const foot = SkeletonUtils.findBoneByHumanoidName(this.skeleton, `${side}Foot`)
      if (!upper || !lower || !foot) continue
      const ik = new TwoBoneIKSolver(upper, lower, foot, { useWorldSpace: true })
      ik.enabled = false
      if (this.options.kneePole) ik.setPoleVector(this.options.kneePole)
      const chain = this.ikRig.createChain(`${side}Leg`)
      chain.addSolver(ik)
      legs.push({ foot, ik, targetY: null })
    }
    if (legs.length === 0) return
    this._grounding = {
      hips: hips || null,
      legs,
      hipOffset: 0,
      rayDistance: this.options.footRayDistance > 0 ? this.options.footRayDistance : 2,
      maxDrop: this.options.footMaxDrop > 0 ? this.options.footMaxDrop : 0.6,
      ankleHeight: Number.isFinite(this.options.footAnkleHeight) ? this.options.footAnkleHeight : 0,
    }
  }

  _groundFeet() {
    const g = this._grounding
    if (!g) return
    const raycast = this.options.raycastCallback
    const foot = new THREE.Vector3()
    const origin = new THREE.Vector3()
    const down = new THREE.Vector3(0, -1, 0)

    let drop = 0
    for (const leg of g.legs) {
      leg.foot.getWorldPosition(foot)
      origin.set(foot.x, foot.y + g.rayDistance / 2, foot.z)
      const hit = raycast(origin, down, g.rayDistance)
      if (!hit || !Number.isFinite(hit.y)) {
        leg.targetY = null
        continue
      }
      leg.targetY = hit.y + g.ankleHeight
      drop = Math.min(drop, Math.max(leg.targetY - foot.y, -g.maxDrop))
    }

    if (g.hips) {
      const delta = drop - g.hipOffset
      if (delta !== 0) {
        const parent = g.hips.parent
        const from = parent ? parent.worldToLocal(new THREE.Vector3()) : new THREE.Vector3()
        const to = parent ? parent.worldToLocal(new THREE.Vector3(0, delta, 0)) : new THREE.Vector3(0, delta, 0)
        g.hips.position.add(to.sub(from))
        g.hipOffset = drop
      }
    }

    for (const leg of g.legs) {
      if (leg.targetY === null) {
        leg.ik.enabled = false
        continue
      }
      leg.foot.getWorldPosition(foot)
      leg.ik.enabled = true
      leg.ik.setTarget({ x: foot.x, y: leg.targetY, z: foot.z })
    }
  }

  initializeController(options = {}) {
    if (this.controller) {
      if (Object.keys(options).length > 0) {
        throw new Error('[AnimationSystem] controller already initialized; options apply only to the first initializeController call')
      }
      return this.controller
    }
    this.controller = createAnimationController(this.blender, {
      ...this.options,
      ...options,
    })
    return this.controller
  }

  addClip(name, clip) {
    this.blender.registerClip(name, clip)
    return this
  }

  playAnimation(name, fadeTime = 0.3) {
    this.blender.playClip(name, fadeTime)
    return this
  }

  crossFade(fromName, toName, fadeTime = 0.3) {
    this.blender.crossFade(fromName, toName, fadeTime)
    return this
  }

  setBlendTree(tree) {
    this.blender.setBlendTree(tree)
    return this
  }

  update(dt, motionState = {}) {
    if (this.controller) {
      this.controller.update(dt, motionState)
    } else {
      this.blender.updateBlend(dt)
    }

    if (this.options.enableIK) {
      this._groundFeet()
      this.ikRig.update()
    }

    if (this.ragdoll) {
      this.ragdoll.apply(dt)
    }

    return this
  }

  createRagdoll(options = {}) {
    this.ragdoll = new RagdollPose(this.skeleton, options)
    return this.ragdoll
  }

  removeRagdoll() {
    this.ragdoll = null
    return this
  }

  setIKTarget(chainName, position, poleVector = null) {
    const chain = this.ikRig.getChain(chainName)
    if (!chain || !chain.solvers[0]) return this

    const solver = chain.solvers[0]
    if (solver.setTarget) solver.setTarget(position)
    if (poleVector && solver.setPoleVector) solver.setPoleVector(poleVector)

    return this
  }

  enableIK(chainName) {
    if (!this.options.enableIK) {
      throw new Error('[AnimationSystem] enableIK(chain) needs IK: construct the system with enableIK: true')
    }
    const chain = this.ikRig.getChain(chainName)
    if (chain) chain.enable()
    return this
  }

  disableIK(chainName) {
    const chain = this.ikRig.getChain(chainName)
    if (chain) chain.disable()
    return this
  }

  getSkeletonBone(boneName) {
    return SkeletonUtils.findBoneByName(this.skeleton, boneName) ||
           SkeletonUtils.findBoneByHumanoidName(this.skeleton, boneName)
  }

  packSkeletonState(buffer, offset = 0) {
    return SkeletonUtils.packSkeletonState(this.skeleton, buffer, offset)
  }

  unpackSkeletonState(buffer, offset = 0) {
    return SkeletonUtils.unpackSkeletonState(this.skeleton, buffer, offset)
  }

  shapeKeys() {
    if (!this._shapeKeys) this._shapeKeys = createShapeKeyDriver(this.model)
    return this._shapeKeys
  }

  dispose() {
    if (this.controller) {
      this.controller.dispose()
    }
    this.mixer.stopAllAction()
  }
}

export default AnimationSystem
