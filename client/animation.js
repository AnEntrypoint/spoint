import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

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

function extractBoneName(trackName) {
  const m = trackName.match(/\.bones\[([^\]]+)\]/)
  if (m) return m[1]
  return trackName.split('.')[0]
}

function filterUpperBodyTracks(clip) {
  const filteredTracks = clip.tracks.filter(track => {
    return !LOWER_BODY_BONES.has(extractBoneName(track.name))
  })
  return new THREE.AnimationClip(clip.name, clip.duration, filteredTracks)
}

function filterValidClipTracks(clip, targetObj) {
  // Get all bone/mesh names that exist in target
  const validBones = new Set()
  targetObj.traverse(child => {
    if (child.isBone || child.isSkinnedMesh) {
      validBones.add(child.name)
    }
  })

  const validTracks = clip.tracks.filter(track => {
    const boneName = extractBoneName(track.name)
    if (!validBones.has(boneName)) {
      console.warn(`[anim] Filtering out track for missing bone: ${boneName}`)
      return false
    }
    return true
  })

  if (validTracks.length < clip.tracks.length) {
    console.log(`[anim] Filtered clip ${clip.name}: ${clip.tracks.length} → ${validTracks.length} tracks`)
    return new THREE.AnimationClip(clip.name, clip.duration, validTracks)
  }

  return clip
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
  const normalizedClips = normalizeClips(gltf, vrmVersion || '1', vrmHumanoid)
  console.log(`[anim] Loaded animation library (${normalizedClips.size} clips)`)
  return { normalizedClips }
}

export function createPlayerAnimator(vrm, allClips, vrmVersion, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const root = vrm.scene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3
  const actions = new Map()
  const additiveActions = new Map()

  const clips = allClips.normalizedClips || allClips.rawClips || allClips

  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]

    let playClip = filterValidClipTracks(clip, root)

    if (cfg.additive) {
      const upperBodyClip = filterUpperBodyTracks(playClip)
      const action = mixer.clipAction(upperBodyClip)
      action.blendMode = THREE.AdditiveAnimationBlendMode
      if (!cfg.loop) {
        action.loop = THREE.LoopOnce
        action.clampWhenFinished = cfg.clamp || false
      }
      additiveActions.set(name, action)
    } else {
      const action = mixer.clipAction(playClip)
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
