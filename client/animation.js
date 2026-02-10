import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { retargetClip } from 'three/addons/utils/SkeletonUtils.js'

const FADE_TIME = 0.15
const STATES = {
  IdleLoop: { loop: true },
  WalkLoop: { loop: true },
  JogFwdLoop: { loop: true },
  SprintLoop: { loop: true },
  JumpStart: { loop: false, next: 'JumpLoop' },
  JumpLoop: { loop: true },
  JumpLand: { loop: false, next: 'IdleLoop', duration: 0.4 },
  Death: { loop: false, clamp: true },
  PistolShoot: { loop: false, next: null, duration: 0.3, additive: true },
  Aim: { loop: true, additive: true }
}

const LOWER_BODY_BONES = new Set([
  'root', 'hips', 'pelvis',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'
])

function filterUpperBodyTracks(clip) {
  const filteredTracks = clip.tracks.filter(track => {
    const boneName = track.name.split('.')[0]
    return !LOWER_BODY_BONES.has(boneName)
  })
  return new THREE.AnimationClip(clip.name, clip.duration, filteredTracks)
}

function getBonesInClip(clip) {
  const bones = new Set()
  for (const track of clip.tracks) {
    const boneName = track.name.split('.')[0]
    bones.add(boneName)
  }
  return Array.from(bones).sort()
}

function getSkeletonBones(obj) {
  const bones = new Set()
  obj.traverse(child => {
    if (child.isBone || child.isSkinnedMesh) {
      bones.add(child.name)
    }
  })
  return Array.from(bones).sort()
}

function findElbowBones(bones) {
  const elbowPatterns = /[Ee]lbow|[Ff]ore[Aa]rm|[Uu]pper[Aa]rm|[Aa]rm[1-3]/
  return bones.filter(b => elbowPatterns.test(b))
}

function findSkinnedMesh(obj) {
  let skinnedMesh = null
  obj.traverse(child => {
    if (child.isSkinnedMesh && !skinnedMesh) {
      skinnedMesh = child
    }
  })
  return skinnedMesh
}

const q1 = new THREE.Quaternion()
const restInv = new THREE.Quaternion()
const parentRest = new THREE.Quaternion()

function normalizeClips(gltf, vrmVersion, vrmHumanoid) {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const clips = new Map()
  for (const clip of gltf.animations) {
    const name = clip.name.replace(/^VRM\|/, '').replace(/@\d+$/, '')
    const tracks = []
    for (const track of clip.tracks) {
      const [boneName, property] = track.name.split('.')
      if (property === 'scale') continue
      if (property === 'position') {
        if (boneName !== 'root' && boneName !== 'hips') continue
        if (vrmVersion === '0') {
          const newTrack = track.clone()
          for (let i = 0; i < newTrack.values.length; i += 3) {
            newTrack.values[i] = -newTrack.values[i]
            newTrack.values[i + 2] = -newTrack.values[i + 2]
          }
          tracks.push(newTrack)
        } else {
          tracks.push(track)
        }
        continue
      }
      let bone = scene.getObjectByName(boneName)
      if (!bone && vrmHumanoid) bone = vrmHumanoid.getNormalizedBoneNode(boneName)
      if (!bone || !bone.parent) { tracks.push(track); continue }
      if (property === 'quaternion') {
        bone.getWorldQuaternion(restInv).invert()
        bone.parent.getWorldQuaternion(parentRest)
        const newTrack = track.clone()
        for (let i = 0; i < newTrack.values.length; i += 4) {
          q1.fromArray(newTrack.values, i)
          q1.premultiply(parentRest).multiply(restInv)
          if (vrmVersion === '0') { q1.x = -q1.x; q1.z = -q1.z }
          q1.toArray(newTrack.values, i)
        }
        tracks.push(newTrack)
      } else {
        tracks.push(track)
      }
    }
    clips.set(name, new THREE.AnimationClip(clip.name, clip.duration, tracks))
  }
  return clips
}

export async function loadAnimationLibrary(vrmVersion, vrmHumanoid) {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync('/anim-lib.glb')

  // Return raw animations and normalized version for fallback
  const rawClips = new Map()
  for (const clip of gltf.animations) {
    const name = clip.name.replace(/^VRM\|/, '').replace(/@\d+$/, '')
    rawClips.set(name, clip)
  }

  const normalizedClips = normalizeClips(gltf, vrmVersion || '1', vrmHumanoid)

  // Store source rig object directly for retargeting
  const sourceRig = gltf.scene

  // Log source skeleton structure
  const sourceBones = getSkeletonBones(sourceRig)
  console.log('[anim] Loaded animation library')
  console.log(`[anim] Source skeleton has ${sourceBones.length} bones: ${sourceBones.join(', ').slice(0, 100)}...`)

  // Log first clip bones for reference
  const firstClip = Array.from(rawClips.values())[0]
  if (firstClip) {
    const clipBones = getBonesInClip(firstClip)
    console.log(`[anim] First clip (${firstClip.name}) animates ${clipBones.length} bones: ${clipBones.join(', ').slice(0, 100)}...`)
  }

  return { rawClips, normalizedClips, sourceRig }
}

export function createPlayerAnimator(vrm, allClips, vrmVersion, animConfig = {}, sourceRig = null) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const root = vrm.scene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3
  const actions = new Map()
  const additiveActions = new Map()

  // Use rawClips if available for retargeting, otherwise use normalized/regular clips
  const clips = allClips.rawClips || allClips

  // Debug: Store retargeting status for inspection
  const retargetingStatus = new Map()

  // Extract SkinnedMesh for retargeting (retargetClip needs the actual mesh with skeleton)
  const targetSkinnedMesh = findSkinnedMesh(root)
  const sourceSkinnedMesh = sourceRig ? findSkinnedMesh(sourceRig) : null

  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]

    // Attempt to retarget the clip to the VRM's skeleton, fall back to pre-normalized version
    let targetClip = allClips.normalizedClips?.get(name) || clip
    let retargetingUsed = false
    let retargetingError = null

    // Check for elbow bones in clip
    const clipBones = getBonesInClip(clip)
    const elbowsInClip = findElbowBones(clipBones)

    if (sourceSkinnedMesh && targetSkinnedMesh) {
      try {
        // Attempt per-VRM retargeting for better skeleton compatibility
        // retargetClip signature: retargetClip(target, source, clip, options)
        const retargeted = retargetClip(targetSkinnedMesh, sourceSkinnedMesh, clip)
        if (retargeted) {
          targetClip = retargeted
          retargetingUsed = true
          const retargetedBones = getBonesInClip(retargeted)
          const elbowsInRetargeted = findElbowBones(retargetedBones)
          console.log(`[anim] ${name}: RETARGETED (${clip.tracks.length} → ${retargeted.tracks.length} tracks) | Elbows: ${elbowsInClip.join(',')} → ${elbowsInRetargeted.join(',')}`)
        } else {
          console.warn(`[anim] ${name}: retargetClip returned null/undefined, using fallback (elbows in source: ${elbowsInClip.join(',')})`)
          retargetingError = 'retargetClip returned null'
        }
      } catch (e) {
        console.error(`[anim] ${name}: retargetClip failed: ${e.message} (elbows in source: ${elbowsInClip.join(',')})`)
        retargetingError = e.message
        // Fall back to normalized clip - these work across all VRM models
      }
    } else {
      console.warn(`[anim] ${name}: skipping retargeting - sourceMesh=${!!sourceSkinnedMesh}, targetMesh=${!!targetSkinnedMesh} (elbows in source: ${elbowsInClip.join(',')})`)
      retargetingError = 'sourceSkinnedMesh or targetSkinnedMesh missing'
    }

    retargetingStatus.set(name, { used: retargetingUsed, error: retargetingError, trackCount: targetClip.tracks.length, hasProblemElbows: elbowsInClip.length > 0 })

    if (cfg.additive) {
      const upperBodyClip = filterUpperBodyTracks(targetClip)
      const action = mixer.clipAction(upperBodyClip)
      action.blendMode = THREE.AdditiveAnimationBlendMode
      if (!cfg.loop) {
        action.loop = THREE.LoopOnce
        action.clampWhenFinished = cfg.clamp || false
      }
      additiveActions.set(name, action)
    } else {
      const action = mixer.clipAction(targetClip)
      if (!cfg.loop) {
        action.loop = THREE.LoopOnce
        action.clampWhenFinished = cfg.clamp || false
      }
      if (name === 'WalkLoop') action.timeScale = animConfig.walkTimeScale || 2.0
      if (name === 'SprintLoop') action.timeScale = animConfig.sprintTimeScale || 0.56
      actions.set(name, action)
    }
  }
  let current = null
  let oneShot = null
  let oneShotTimer = 0
  let wasOnGround = true
  let airTime = 0
  let smoothSpeed = 0
  let locomotionCooldown = 0
  const AIR_GRACE = 0.15
  const SPEED_SMOOTH = 8.0
  const LOCO_COOLDOWN = 0.3
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop'])

  function transitionTo(name) {
    if (current === name) return
    if (LOCO_STATES.has(name) && LOCO_STATES.has(current) && locomotionCooldown > 0) return
    const prev = actions.get(current)
    const next = actions.get(name)
    if (!next) return
    if (prev) prev.fadeOut(FADE)
    next.reset().fadeIn(FADE).play()
    current = name
    if (LOCO_STATES.has(name)) locomotionCooldown = LOCO_COOLDOWN
  }

  if (actions.has('IdleLoop')) {
    actions.get('IdleLoop').play()
    current = 'IdleLoop'
  }

  mixer.addEventListener('finished', () => {
    if (oneShot && !STATES[oneShot]?.additive) {
      const cfg = STATES[oneShot]
      if (cfg?.clamp) return
      oneShot = null
      oneShotTimer = 0
      if (cfg?.next) transitionTo(cfg.next)
    }
  })

  return {
    getRetargetingStatus() { return new Map(retargetingStatus) },
    update(dt, velocity, onGround, health, aiming) {
      if (locomotionCooldown > 0) locomotionCooldown -= dt
      if (oneShotTimer > 0) {
        oneShotTimer -= dt
        if (oneShotTimer <= 0) {
          const cfg = STATES[oneShot]
          oneShot = null
          if (cfg?.next) transitionTo(cfg.next)
        }
      }

      if (!onGround) airTime += dt
      else airTime = 0
      const effectiveOnGround = onGround || airTime < AIR_GRACE

      if (health <= 0 && current !== 'Death') {
        transitionTo('Death')
        oneShot = 'Death'
      } else if (health > 0 && (oneShot === 'Death' || current === 'Death')) {
        const deathAction = actions.get('Death')
        if (deathAction) { deathAction.stop(); deathAction.reset() }
        oneShot = null
        oneShotTimer = 0
        current = null
        transitionTo('IdleLoop')
      } else if (!oneShot || STATES[oneShot]?.additive) {
        const vx = velocity?.[0] || 0, vz = velocity?.[2] || 0
        const rawSpeed = Math.sqrt(vx * vx + vz * vz)
        smoothSpeed += (rawSpeed - smoothSpeed) * Math.min(1, SPEED_SMOOTH * dt)

        if (!effectiveOnGround && !wasOnGround) {
          transitionTo('JumpLoop')
        } else if (!wasOnGround && effectiveOnGround && smoothSpeed < 1.5) {
          transitionTo('JumpLand')
          oneShot = 'JumpLand'
          oneShotTimer = STATES.JumpLand.duration
        } else if (effectiveOnGround) {
          const idle2walk = current === 'IdleLoop' ? 0.8 : 0.3
          const walk2jog = current === 'WalkLoop' ? 5.0 : 4.5
          const jog2sprint = current === 'JogFwdLoop' ? 6.0 : 5.5
          if (smoothSpeed < idle2walk) transitionTo('IdleLoop')
          else if (smoothSpeed < walk2jog) transitionTo('WalkLoop')
          else if (smoothSpeed < jog2sprint) transitionTo('JogFwdLoop')
          else transitionTo('SprintLoop')
        }
      }

      this.aim(aiming)
      wasOnGround = effectiveOnGround
      mixer.update(dt)
    },
    shoot() {
      const action = additiveActions.get('PistolShoot')
      if (!action) return
      action.reset().fadeIn(0.05).play()
    },
    aim(active) {
      const action = additiveActions.get('Aim')
      if (!action) return
      if (active) {
        if (!action.isRunning()) action.fadeIn(FADE).play()
      } else {
        if (action.isRunning()) action.fadeOut(FADE)
      }
    },
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    }
  }
}
