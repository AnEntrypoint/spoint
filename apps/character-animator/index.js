import * as THREE from 'three'
import { AnimationSystem } from '../../src/animation/AnimationSystem.js'

export async function setup(scene, world, appCtx) {
  const { gltfLoader, modelPool } = appCtx
  let animationSystem = null
  let model = null

  async function loadCharacter(modelUrl, animationClipsUrl) {
    try {
      const gltf = await gltfLoader.loadAsync(modelUrl)
      model = gltf.scene

      const animGltf = animationClipsUrl ? await gltfLoader.loadAsync(animationClipsUrl) : gltf
      const clips = animGltf.animations || []

      scene.add(model)

      animationSystem = new AnimationSystem(model, {
        clips,
        enableIK: true,
        enableFootIK: true,
      })

      animationSystem.initializeController({
        walkSpeed: 1.5,
        runSpeed: 5,
        sprintSpeed: 10,
      })

      console.log('[character-animator] Character loaded with', clips.length, 'animation clips')
      return model
    } catch (error) {
      console.error('[character-animator] Failed to load character:', error)
      throw error
    }
  }

  async function playAnimation(clipName, fadeTime = 0.3) {
    if (!animationSystem) {
      console.warn('[character-animator] No animation system initialized')
      return
    }
    animationSystem.playAnimation(clipName, fadeTime)
  }

  function setMotion(speed, direction = [0, 0, 1], isGrounded = true, verticalVelocity = 0) {
    if (!animationSystem) return

    animationSystem.update(1 / 60, {
      speed,
      direction,
      isGrounded,
      verticalVelocity,
    })
  }

  function setIKTarget(chainName, position, poleVector) {
    if (!animationSystem) return
    animationSystem.setIKTarget(chainName, position, poleVector)
  }

  let lastFrameTime = Date.now()

  function tick(dt) {
    if (!animationSystem) return

    const now = Date.now()
    const elapsed = (now - lastFrameTime) / 1000
    lastFrameTime = now

    animationSystem.update(elapsed)
  }

  function dispose() {
    if (animationSystem) {
      animationSystem.dispose()
    }
    if (model && scene) {
      scene.remove(model)
    }
  }

  world.onBeforeUnload.push(dispose)

  return {
    loadCharacter,
    playAnimation,
    setMotion,
    setIKTarget,
    tick,
    dispose,
    getAnimationSystem() { return animationSystem },
    getModel() { return model },
  }
}

export default { setup }
