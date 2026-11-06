
export async function setup(scene, world, appCtx) {
  const { gltfLoader, modelPool } = appCtx
  let animationSystem = null
  let model = null
  let commandedMotion = {}
  let appliedRagdollKey = null

  async function loadCharacter(modelUrl, animationClipsUrl) {
    try {
      const gltf = await gltfLoader.loadAsync(modelUrl)
      model = gltf.scene

      const animGltf = animationClipsUrl ? await gltfLoader.loadAsync(animationClipsUrl) : gltf
      const clips = animGltf.animations || []

      scene.add(model)

      animationSystem = appCtx.createAnimationSystem(model, {
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

    commandedMotion = {
      speed,
      direction,
      isGrounded,
      verticalVelocity,
    }
    animationSystem.update(1 / 60, commandedMotion)
  }

  function setIKTarget(chainName, position, poleVector) {
    if (!animationSystem) return
    animationSystem.setIKTarget(chainName, position, poleVector)
  }

  function syncRagdoll() {
    const plan = appCtx.state?._ragdoll
    if (!plan || !animationSystem) return
    const key = JSON.stringify(plan)
    if (key === appliedRagdollKey) return
    animationSystem.setRagdollPlan(plan)
    appliedRagdollKey = key
  }

  function tick(dt) {
    if (!animationSystem || !Number.isFinite(dt)) return

    syncRagdoll()
    animationSystem.update(dt, commandedMotion)
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
