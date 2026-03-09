import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { getCachedClips, cacheClips } from './AnimationClipCache.js'

// anim-lib bone name → Blender default humanoid bone name (post Three.js sanitizeNodeName — dots stripped)
const ANIM_TO_BLENDER = {
  root: 'root', hips: 'hips', spine: 'spine', chest: 'chest', upperChest: 'chest',
  neck: 'neck', head: 'head',
  leftShoulder: 'shoulderL', rightShoulder: 'shoulderR',
  leftArm: 'upper_armL', leftUpperArm: 'upper_armL', leftLowerArm: 'lower_armL', leftHand: 'handL',
  rightArm: 'upper_armR', rightUpperArm: 'upper_armR', rightLowerArm: 'lower_armR', rightHand: 'handR',
  leftUpperLeg: 'upper_legL', leftLowerLeg: 'lower_legL', leftFoot: 'footL', leftToes: 'toesL',
  rightUpperLeg: 'upper_legR', rightLowerLeg: 'lower_legR', rightFoot: 'footR', rightToes: 'toesR',
}

// anim-lib bone name → Mixamo bone name
const ANIM_TO_MIXAMO = {
  root: 'root', hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2',
  neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', rightShoulder: 'RightShoulder',
  leftArm: 'LeftArm', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightArm: 'RightArm', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
}

/**
 * Detect which bone naming convention a scene uses and return
 * an anim-lib-bone-name → actual-bone-name map, or null if no remap needed.
 */
function detectBoneNameMap(scene) {
  const boneNames = new Set()
  scene.traverse(c => { if (c.name) boneNames.add(c.name) })

  const blenderMatches = Object.values(ANIM_TO_BLENDER).filter(n => boneNames.has(n)).length
  const mixamoMatches = Object.values(ANIM_TO_MIXAMO).filter(n => boneNames.has(n)).length
  const directMatches = Object.keys(ANIM_TO_BLENDER).filter(n => boneNames.has(n)).length

  if (directMatches >= blenderMatches && directMatches >= mixamoMatches) return null // anim-lib names already match
  if (blenderMatches >= mixamoMatches) return ANIM_TO_BLENDER
  return ANIM_TO_MIXAMO
}

/**
 * Clone a clip, remapping bone names in track names using the provided map.
 * Tracks with no matching bone in the scene are dropped.
 */
function remapClip(clip, boneMap, validBones) {
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

const FADE_TIME = 0.15
const STATES = {
  IdleLoop: { loop: true },
  WalkLoop: { loop: true },
  JogFwdLoop: { loop: true },
  SprintLoop: { loop: true },
  JumpStart: { loop: false, next: 'JumpLoop' },
  JumpLoop: { loop: true },
  JumpLand: { loop: false, next: 'IdleLoop', duration: 0.4 },
  CrouchIdleLoop: { loop: true },
  CrouchFwdLoop: { loop: true },
  Death: { loop: false, clamp: true },
  PistolShoot: { loop: false, next: null, duration: 0.3, upperBody: true },
  Aim: { loop: true, additive: true },
  PistolReload: { loop: false, next: 'IdleLoop', duration: 2.0, upperBody: true }
}

const LOWER_BODY_BONES = new Set([
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

function buildValidBoneSet(targetObj) {
  const validBones = new Set()
  targetObj.traverse(child => {
    if (child.name) validBones.add(child.name)
  })
  return validBones
}

function filterValidClipTracks(clip, validBones) {
  const validTracks = clip.tracks.filter(track => validBones.has(extractBoneName(track.name)))
  if (validTracks.length < clip.tracks.length) {
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

let _gltfPromise = null
let _normalizedCache = null

export function preloadAnimationLibrary(loader) {
  if (_gltfPromise) return _gltfPromise
  const l = loader || new GLTFLoader()
  _gltfPromise = l.loadAsync('/anim-lib.glb')
  return _gltfPromise
}

export async function loadAnimationLibrary(vrmVersion, vrmHumanoid) {
  if (_normalizedCache) return _normalizedCache
  const cacheKey = `anim-lib-v${vrmVersion || '1'}`
  const cached = await getCachedClips(cacheKey)
  if (cached) {
    console.log(`[anim] Loaded ${cached.size} clips from cache`)
    _normalizedCache = { normalizedClips: cached, rawClips: cached }
    return _normalizedCache
  }
  const gltf = await preloadAnimationLibrary()
  if (_normalizedCache) return _normalizedCache
  const normalizedClips = normalizeClips(gltf, vrmVersion || '1', vrmHumanoid)
  const rawClips = new Map()
  for (const clip of gltf.animations) {
    const name = clip.name.replace(/^VRM\|/, '').replace(/@\d+$/, '')
    rawClips.set(name, clip)
  }
  console.log(`[anim] Loaded animation library (${normalizedClips.size} clips):`, [...normalizedClips.keys()])
  _normalizedCache = { normalizedClips, rawClips }
  cacheClips(cacheKey, normalizedClips)
  return _normalizedCache
}

function buildVRM0NormalizedRemap(vrm) {
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

function remapClipToNormalized(clip, remap) {
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

export function createPlayerAnimator(vrm, allClips, vrmVersion, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const root = vrm.scene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3
  const actions = new Map()
  const additiveActions = new Map()

  const clips = allClips.normalizedClips || allClips.rawClips || allClips
  const vrm0Remap = vrmVersion === '0' ? buildVRM0NormalizedRemap(vrm) : new Map()
  const validBones = buildValidBoneSet(root)

  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]

    if (cfg.upperBody) {
    }

    let playClip = filterValidClipTracks(remapClipToNormalized(clip, vrm0Remap), validBones)

    if (cfg.upperBody) {
      const upperBodyClip = filterUpperBodyTracks(playClip)
      const action = mixer.clipAction(upperBodyClip)
      if (!cfg.loop) {
        action.loop = THREE.LoopOnce
        action.clampWhenFinished = cfg.clamp || false
      }
      actions.set(name, action)
    } else if (cfg.additive) {
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
  let smoothTimeScale = 1.0
  let locomotionCooldown = 0
  const AIR_GRACE = 0.15
  const SPEED_SMOOTH = 8.0
  const TIMESCALE_SMOOTH = 10.0
  const LOCO_COOLDOWN = 0.3
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])

  const _humanoid = vrm.humanoid
  const _getBone = (name) => _humanoid?.getNormalizedBoneNode?.(name) || null
  const _hipBone = _getBone('hips') || (() => {
    const names = new Set(['J_Bip_C_Hips', 'Hips', 'hips', 'pelvis'])
    let found = null; root.traverse(c => { if (!found && names.has(c.name)) found = c }); return found
  })()
  const _spineBones = (() => {
    const bones = []
    for (const n of ['spine', 'chest', 'upperChest']) {
      const b = _getBone(n)
      if (b) bones.push(b)
    }
    if (bones.length === 0) {
      const names = new Set(['J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_UpperChest', 'Spine', 'Spine1', 'Spine2'])
      root.traverse(c => { if (names.has(c.name)) bones.push(c) })
    }
    return bones
  })()
  const _qLook = new THREE.Quaternion()
  const _eLook = new THREE.Euler(0, 0, 0, 'YXZ')
  let _lookYaw = 0, _lookPitch = 0, _smoothPitch = 0, _bodyYaw = 0
  let _moveAngle = 0, _smoothMoveAngle = 0 // angle of movement relative to body facing
  let _prevLookYaw = 0, _leanYaw = 0
  const PITCH_SMOOTH = 6.0  // lookPitch is 4-bit (16 steps) — slow smooth to hide quantization
  const MOVE_ANGLE_SMOOTH = 8.0

  function transitionTo(name) {
    if (current === name) return
    // Cooldown only blocks loco-to-loco transitions (not stopping to idle)
    if (name !== 'IdleLoop' && name !== 'CrouchIdleLoop' && LOCO_STATES.has(name) && LOCO_STATES.has(current) && locomotionCooldown > 0) return
    const prev = actions.get(current)
    const next = actions.get(name)
    if (!next) return
    if (prev) prev.fadeOut(FADE)
    next.reset().fadeIn(FADE).play()
    current = name
    if (LOCO_STATES.has(name) && name !== 'IdleLoop' && name !== 'CrouchIdleLoop') locomotionCooldown = LOCO_COOLDOWN
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
    update(dt, velocity, onGround, health, aiming, crouching) {
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
          if (crouching) {
            if (smoothSpeed < 0.8) transitionTo('CrouchIdleLoop')
            else transitionTo('CrouchFwdLoop')
          } else {
            const idle2walk  = current === 'IdleLoop' ? 2.0 : 0.8
            const walk2jog   = current === 'WalkLoop' ? 13.5 : 13.0
            const jog2sprint = current === 'JogFwdLoop' ? 99.0 : 99.0
            // Skip walk only on the way down (jog/sprint → idle, no walk flash)
            const skipWalk = current === 'JogFwdLoop' || current === 'SprintLoop'
            if (smoothSpeed < idle2walk) transitionTo('IdleLoop')
            else if (!skipWalk && smoothSpeed < walk2jog) transitionTo('WalkLoop')
            else if (smoothSpeed < jog2sprint) transitionTo('JogFwdLoop')
            else transitionTo('SprintLoop')
          }
        }
      }

      // Apply movement direction + speed-proportional timeScale to loco animation
      if (current && LOCO_STATES.has(current) && current !== 'IdleLoop' && current !== 'CrouchIdleLoop') {
        const locoAction = actions.get(current)
        if (locoAction) {
          const baseScale = current === 'WalkLoop' ? (animConfig.walkTimeScale || 2.0) : current === 'SprintLoop' ? (animConfig.sprintTimeScale || 0.56) : 1.0
          const stateMin = current === 'WalkLoop' ? 0.3 : current === 'JogFwdLoop' ? 5.5 : current === 'SprintLoop' ? 12.0 : 0.3
          const stateMax = current === 'WalkLoop' ? 6.0 : current === 'JogFwdLoop' ? 13.0 : current === 'SprintLoop' ? 24.0 : 6.0
          const ratio = Math.max(0.5, Math.min(1.5, smoothSpeed / Math.max(1, (stateMin + stateMax) * 0.5)))
          const dir = Math.abs(_moveAngle) > Math.PI * 0.75 ? -1 : 1
          const target = baseScale * ratio * dir
          smoothTimeScale += (target - smoothTimeScale) * Math.min(1, TIMESCALE_SMOOTH * dt)
          locoAction.timeScale = smoothTimeScale
        }
      }
      this.aim(aiming)
      wasOnGround = effectiveOnGround
      mixer.update(dt)
    },
    applyBoneOverrides(dt) {
      // Smooth pitch (quantized input → smooth spine tilt)
      _smoothPitch += (_lookPitch - _smoothPitch) * Math.min(1, PITCH_SMOOTH * dt)
      // Smooth moveAngle (body-relative velocity angle)
      const targetAngle = (current && LOCO_STATES.has(current) && current !== 'IdleLoop') ? _moveAngle : 0
      _smoothMoveAngle += (targetAngle - _smoothMoveAngle) * Math.min(1, MOVE_ANGLE_SMOOTH * dt)

      let hipYaw = 0
      if (_hipBone && current && LOCO_STATES.has(current) && current !== 'IdleLoop' && current !== 'CrouchIdleLoop') {
        if (Math.abs(_smoothMoveAngle) < Math.PI * 0.75) {
          hipYaw = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, -_smoothMoveAngle))
          _eLook.setFromQuaternion(_hipBone.quaternion, 'YXZ')
          _eLook.y = hipYaw
          _hipBone.quaternion.setFromEuler(_eLook)
        }
      }
      if (_spineBones.length > 0) {
        const n = _spineBones.length
        const spineYawShare = -hipYaw / n
        const pitchShare = Math.max(-Math.PI / 3, Math.min(Math.PI / 4, _smoothPitch)) / n
        for (let i = 0; i < n; i++) {
          _eLook.setFromQuaternion(_spineBones[i].quaternion, 'YXZ')
          _eLook.y = spineYawShare
          _eLook.x = pitchShare
          _spineBones[i].quaternion.setFromEuler(_eLook)
        }
      }
    },
    setLookDirection(yaw, pitch, bodyYaw, velocity, dt) {
      _lookYaw = yaw; _lookPitch = pitch
      if (bodyYaw !== undefined) _bodyYaw = bodyYaw
      if (velocity) {
        const vx = velocity[0] || 0, vz = velocity[2] || 0
        const speed = Math.sqrt(vx * vx + vz * vz)
        if (speed > 0.5) {
          // Project world velocity into body-local space.
          // bodyYaw = mesh.rotation.y + PI (passed from app.js).
          const sinY = Math.sin(_bodyYaw), cosY = Math.cos(_bodyYaw)
          const localFwd   = -vx * sinY - vz * cosY
          const localRight =  vx * cosY - vz * sinY
          _moveAngle = Math.atan2(localRight, localFwd)
        } else { _moveAngle = 0 }
      }
    },
    shoot() {
      const action = actions.get('PistolShoot')
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
    reload() {
      const action = actions.get('PistolReload')
      if (!action) {
        console.log('[anim] PistolReload animation not found')
        return
      }
      console.log('[anim] Playing reload animation')
      action.reset().fadeIn(0.1).play()
    },
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    }
  }
}

/**
 * Create an animator for a plain GLB player model (no VRM metadata).
 *
 * If the GLB has its own embedded animations, those are used and mapped to
 * STATES by name (case-insensitive prefix match: "idle" → IdleLoop, etc.)
 *
 * If the GLB has no animations, the normalized VRM animation library clips
 * are remapped to the GLB's bone naming convention (Blender/Mixamo/VRM) and
 * played directly on the GLB's AnimationMixer.
 */
export function createGLBAnimator(gltfScene, gltfAnimations, animAssets, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const root = gltfScene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3
  const actions = new Map()
  const additiveActions = new Map()

  // Include all named nodes — plain GLBs without skin have Object3D not THREE.Bone
  const validBones = new Set()
  root.traverse(c => { if (c.name) validBones.add(c.name) })

  // Determine source clips: embedded GLB animations or VRM library clips
  let clips
  if (gltfAnimations && gltfAnimations.length > 0) {
    // Map embedded animation names to STATES keys
    const nameMap = new Map()
    const FUZZY = [
      ['idle', 'IdleLoop'], ['walk', 'WalkLoop'], ['jog', 'JogFwdLoop'], ['run', 'JogFwdLoop'],
      ['sprint', 'SprintLoop'], ['jumpstart', 'JumpStart'], ['jumploop', 'JumpLoop'],
      ['jumpland', 'JumpLand'], ['land', 'JumpLand'], ['crouchidle', 'CrouchIdleLoop'],
      ['crouchwalk', 'CrouchFwdLoop'], ['death', 'Death'], ['shoot', 'PistolShoot'],
      ['aim', 'Aim'], ['reload', 'PistolReload']
    ]
    clips = new Map()
    for (const anim of gltfAnimations) {
      const key = anim.name.toLowerCase().replace(/[^a-z]/g, '')
      const state = STATES[anim.name] ? anim.name
        : FUZZY.find(([pat]) => key.includes(pat))?.[1]
      if (state) clips.set(state, anim)
    }
    console.log(`[anim] GLB has ${gltfAnimations.length} embedded anims, mapped:`, [...clips.keys()])
  } else if (animAssets?.rawClips || animAssets?.normalizedClips) {
    // Use raw (non-retargeted) clips for GLB — retargeted clips assume VRM rest poses
    const sourceClips = animAssets.rawClips || animAssets.normalizedClips
    const boneMap = detectBoneNameMap(root)
    clips = new Map()
    for (const [name, clip] of sourceClips) {
      const remapped = boneMap ? remapClip(clip, boneMap, validBones) : filterValidClipTracks(clip, validBones)
      if (remapped.tracks.length > 0) clips.set(name, remapped)
    }
    console.log(`[anim] GLB using ${animAssets.rawClips ? 'raw' : 'normalized'} library clips (${clips.size} valid, convention: ${boneMap === ANIM_TO_BLENDER ? 'Blender' : boneMap === ANIM_TO_MIXAMO ? 'Mixamo' : 'direct'})`)
  } else {
    clips = new Map()
  }

  // Build mixer actions using same logic as createPlayerAnimator
  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]
    const playClip = clip instanceof THREE.AnimationClip
      ? clip : new THREE.AnimationClip(clip.name, clip.duration, clip.tracks)

    if (cfg.upperBody || cfg.additive) {
      const upperBodyClip = filterUpperBodyTracks(playClip)
      const action = mixer.clipAction(upperBodyClip)
      if (cfg.additive) action.blendMode = THREE.AdditiveAnimationBlendMode
      if (!cfg.loop) { action.loop = THREE.LoopOnce; action.clampWhenFinished = cfg.clamp || false }
      cfg.additive ? additiveActions.set(name, action) : actions.set(name, action)
    } else {
      const action = mixer.clipAction(playClip)
      if (!cfg.loop) { action.loop = THREE.LoopOnce; action.clampWhenFinished = cfg.clamp || false }
      if (name === 'WalkLoop') action.timeScale = animConfig.walkTimeScale || 2.0
      if (name === 'SprintLoop') action.timeScale = animConfig.sprintTimeScale || 0.56
      actions.set(name, action)
    }
  }

  // --- identical state machine to createPlayerAnimator below ---
  let current = null, oneShot = null, oneShotTimer = 0, wasOnGround = true
  let airTime = 0, smoothSpeed = 0, locomotionCooldown = 0
  const AIR_GRACE = 0.15, SPEED_SMOOTH = 8.0, LOCO_COOLDOWN = 0.3
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])

  function transitionTo(name) {
    if (current === name) return
    // Cooldown only blocks loco-to-loco transitions (not stopping to idle)
    if (name !== 'IdleLoop' && name !== 'CrouchIdleLoop' && LOCO_STATES.has(name) && LOCO_STATES.has(current) && locomotionCooldown > 0) return
    const prev = actions.get(current)
    const next = actions.get(name)
    if (!next) return
    if (prev) prev.fadeOut(FADE)
    next.reset().fadeIn(FADE).play()
    current = name
    if (LOCO_STATES.has(name) && name !== 'IdleLoop' && name !== 'CrouchIdleLoop') locomotionCooldown = LOCO_COOLDOWN
  }

  if (actions.has('IdleLoop')) { actions.get('IdleLoop').play(); current = 'IdleLoop' }

  mixer.addEventListener('finished', () => {
    if (oneShot && !STATES[oneShot]?.additive) {
      const cfg = STATES[oneShot]
      if (cfg?.clamp) return
      oneShot = null; oneShotTimer = 0
      if (cfg?.next) transitionTo(cfg.next)
    }
  })

  return {
    update(dt, velocity, onGround, health, aiming, crouching) {
      if (locomotionCooldown > 0) locomotionCooldown -= dt
      if (oneShotTimer > 0) { oneShotTimer -= dt; if (oneShotTimer <= 0) { const cfg = STATES[oneShot]; oneShot = null; if (cfg?.next) transitionTo(cfg.next) } }
      if (!onGround) airTime += dt; else airTime = 0
      const effectiveOnGround = onGround || airTime < AIR_GRACE
      if (health <= 0 && current !== 'Death') {
        transitionTo('Death'); oneShot = 'Death'
      } else if (health > 0 && (oneShot === 'Death' || current === 'Death')) {
        const deathAction = actions.get('Death')
        if (deathAction) { deathAction.stop(); deathAction.reset() }
        oneShot = null; oneShotTimer = 0; current = null; transitionTo('IdleLoop')
      } else if (!oneShot || STATES[oneShot]?.additive) {
        const vx = velocity?.[0] || 0, vz = velocity?.[2] || 0
        const rawSpeed = Math.sqrt(vx * vx + vz * vz)
        smoothSpeed += (rawSpeed - smoothSpeed) * Math.min(1, SPEED_SMOOTH * dt)
        if (!effectiveOnGround && !wasOnGround) {
          transitionTo('JumpLoop')
        } else if (!wasOnGround && effectiveOnGround && smoothSpeed < 1.5) {
          transitionTo('JumpLand'); oneShot = 'JumpLand'; oneShotTimer = STATES.JumpLand.duration
        } else if (effectiveOnGround) {
          if (crouching) {
            if (smoothSpeed < 0.8) transitionTo('CrouchIdleLoop'); else transitionTo('CrouchFwdLoop')
          } else {
            const idle2walk  = current === 'IdleLoop' ? 2.0 : 0.8
            const walk2jog   = current === 'WalkLoop' ? 13.5 : 13.0
            const jog2sprint = current === 'JogFwdLoop' ? 99.0 : 99.0
            // Skip walk only on the way down (jog/sprint → idle, no walk flash)
            const skipWalk = current === 'JogFwdLoop' || current === 'SprintLoop'
            if (smoothSpeed < idle2walk) transitionTo('IdleLoop')
            else if (!skipWalk && smoothSpeed < walk2jog) transitionTo('WalkLoop')
            else if (smoothSpeed < jog2sprint) transitionTo('JogFwdLoop')
            else transitionTo('SprintLoop')
          }
        }
      }
      this.aim(aiming)
      wasOnGround = effectiveOnGround
      mixer.update(dt)
    },
    shoot() { const a = actions.get('PistolShoot'); if (a) a.reset().fadeIn(0.05).play() },
    aim(active) {
      const a = additiveActions.get('Aim'); if (!a) return
      if (active) { if (!a.isRunning()) a.fadeIn(FADE).play() }
      else { if (a.isRunning()) a.fadeOut(FADE) }
    },
    reload() { const a = actions.get('PistolReload'); if (a) a.reset().fadeIn(0.1).play() },
    dispose() { mixer.stopAllAction(); mixer.uncacheRoot(root) }
  }
}
