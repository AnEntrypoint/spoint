import { AnimationSystem } from './AnimationSystem.js'

export function createPlayerAnimatorAdapter(model, gltf, options = {}) {
  const animSystem = new AnimationSystem(model, {
    clips: gltf.animations || [],
    enableIK: options.enableIK !== false,
    enableFootIK: options.enableFootIK !== false,
    raycastCallback: options.raycastCallback,
  })

  animSystem.initializeController(options.controller || {})

  let currentMotionState = {
    speed: 0,
    direction: [0, 0, 1],
    isGrounded: true,
    verticalVelocity: 0,
  }

  return {
    animSystem,

    update(dt, motionState = {}) {
      Object.assign(currentMotionState, motionState)
      animSystem.update(dt, currentMotionState)
    },

    playAnimation(name, fadeTime = 0.3) {
      animSystem.playAnimation(name, fadeTime)
    },

    crossFade(fromName, toName, fadeTime = 0.3) {
      animSystem.crossFade(fromName, toName, fadeTime)
    },

    setState(state) {
      if (animSystem.controller) {
        animSystem.controller.setState(state)
      }
    },

    getState() {
      return animSystem.controller ? animSystem.controller.getState() : 'idle'
    },

    setIKTarget(chainName, position, poleVector = null) {
      animSystem.setIKTarget(chainName, position, poleVector)
    },

    enableIK(chainName) {
      animSystem.enableIK(chainName)
    },

    disableIK(chainName) {
      animSystem.disableIK(chainName)
    },

    getSkeletonBone(boneName) {
      return animSystem.getSkeletonBone(boneName)
    },

    onStateChange(callback) {
      if (animSystem.controller) {
        return animSystem.controller.onStateChange(callback)
      }
      return () => {}
    },

    getAnimationSystem() {
      return animSystem
    },

    dispose() {
      animSystem.dispose()
    },
  }
}

export default createPlayerAnimatorAdapter
