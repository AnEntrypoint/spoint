import * as THREE from 'three'
import { SkeletonUtils } from './SkeletonUtils.js'
import { AnimationBlender, BlendTree1D, BlendTree2D } from './BlendTree.js'
import { IKRig, TwoBoneIKSolver, FootIKSolver } from './IKSolver.js'
import createAnimationController from './AnimationController.js'

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
      const leftFoot = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'leftFoot')
      if (leftFoot) {
        const leftFootIK = new FootIKSolver(leftFoot, this.options.raycastCallback)
        const leftFootChain = this.ikRig.createChain('leftFoot')
        leftFootChain.addSolver(leftFootIK)
      }

      const rightFoot = SkeletonUtils.findBoneByHumanoidName(this.skeleton, 'rightFoot')
      if (rightFoot) {
        const rightFootIK = new FootIKSolver(rightFoot, this.options.raycastCallback)
        const rightFootChain = this.ikRig.createChain('rightFoot')
        rightFootChain.addSolver(rightFootIK)
      }
    }
  }

  initializeController(options = {}) {
    if (!this.controller) {
      this.controller = createAnimationController(this.blender, {
        ...this.options,
        ...options,
      })
    }
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
    this.mixer.update(dt)

    if (this.controller) {
      this.controller.update(dt, motionState)
    }

    if (this.options.enableIK) {
      this.ikRig.update()
    }

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

  dispose() {
    if (this.controller) {
      this.controller.dispose()
    }
    this.mixer.stopAllAction()
  }
}

export default AnimationSystem
