import * as THREE from 'three'
import { ANIM_TO_BLENDER, ANIM_TO_MIXAMO, detectBoneNameMap, remapClip, buildVRM0NormalizedRemap, remapClipToNormalized, filterValidClipTracks, filterUpperBodyTracks, buildValidBoneSet } from './AnimationUtils.js'
import { STATES, FADE_TIME, createAnimationStateMachine } from './AnimationStateMachine.js'

function buildActionsFromClips(mixer, clips, animConfig) {
  const actions = new Map()
  const additiveActions = new Map()
  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]
    const sourceClip = name === 'JogFwdLoop' && clips.has('WalkLoop') ? clips.get('WalkLoop') : clip
    if (cfg.upperBody || cfg.additive) {
      const upperBodyClip = filterUpperBodyTracks(sourceClip)
      const action = mixer.clipAction(upperBodyClip)
      if (cfg.additive) action.blendMode = THREE.AdditiveAnimationBlendMode
      if (!cfg.loop) { action.loop = THREE.LoopOnce; action.clampWhenFinished = cfg.clamp || false }
      cfg.additive ? additiveActions.set(name, action) : actions.set(name, action)
    } else {
      const action = mixer.clipAction(sourceClip)
      if (!cfg.loop) { action.loop = THREE.LoopOnce; action.clampWhenFinished = cfg.clamp || false }
      if (name === 'WalkLoop') action.timeScale = animConfig.walkTimeScale || 16.0
      if (name === 'JogFwdLoop') action.timeScale = animConfig.jogTimeScale || 0.667
      if (name === 'SprintLoop') action.timeScale = animConfig.sprintTimeScale || 0.56
      actions.set(name, action)
    }
  }
  return { actions, additiveActions }
}

export function createPlayerAnimator(vrm, allClips, vrmVersion, animConfig = {}) {
  const root = vrm.scene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3

  const clips = allClips.normalizedClips || allClips.rawClips || allClips
  const vrm0Remap = vrmVersion === '0' ? buildVRM0NormalizedRemap(vrm) : new Map()
  const validBones = buildValidBoneSet(root)

  const remappedClips = new Map()
  for (const [name, clip] of clips) {
    const sourceClip = name === 'JogFwdLoop' && clips.has('WalkLoop') ? clips.get('WalkLoop') : clip
    remappedClips.set(name, filterValidClipTracks(remapClipToNormalized(sourceClip, vrm0Remap), validBones))
  }

  const { actions, additiveActions } = buildActionsFromClips(mixer, remappedClips, animConfig)
  const sm = createAnimationStateMachine(mixer, root, actions, additiveActions, animConfig)

  const _humanoid = vrm.humanoid
  const _getBone = (n) => _humanoid?.getNormalizedBoneNode?.(n) || null
  const _hipBone = _getBone('hips') || (() => {
    const names = new Set(['J_Bip_C_Hips', 'Hips', 'hips', 'pelvis'])
    let found = null; root.traverse(c => { if (!found && names.has(c.name)) found = c }); return found
  })()
  const _spineBones = (() => {
    const bones = []
    for (const n of ['spine', 'chest', 'upperChest']) { const b = _getBone(n); if (b) bones.push(b) }
    if (bones.length === 0) {
      const names = new Set(['J_Bip_C_Spine', 'J_Bip_C_Chest', 'J_Bip_C_UpperChest', 'Spine', 'Spine1', 'Spine2'])
      root.traverse(c => { if (names.has(c.name)) bones.push(c) })
    }
    return bones
  })()
  const _qLook = new THREE.Quaternion()
  const _eLook = new THREE.Euler(0, 0, 0, 'YXZ')
  let _lookPitch = 0, _smoothPitch = 0, _bodyYaw = 0
  let _moveAngle = 0, _smoothMoveAngle = 0
  const PITCH_SMOOTH = 6.0
  const MOVE_ANGLE_SMOOTH = 8.0
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])

  return {
    ...sm,
    update(dt, velocity, onGround, health, aiming, crouching) {
      sm.update(dt, velocity, onGround, health, aiming, crouching)
    },
    applyBoneOverrides(dt) {
      _smoothPitch += (_lookPitch - _smoothPitch) * Math.min(1, PITCH_SMOOTH * dt)
      const state = sm.getState()
      const targetAngle = (state && LOCO_STATES.has(state) && state !== 'IdleLoop') ? _moveAngle : 0
      _smoothMoveAngle += (targetAngle - _smoothMoveAngle) * Math.min(1, MOVE_ANGLE_SMOOTH * dt)

      let hipYaw = 0
      if (_hipBone && state && LOCO_STATES.has(state) && state !== 'IdleLoop' && state !== 'CrouchIdleLoop') {
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
      _lookPitch = pitch
      if (bodyYaw !== undefined) _bodyYaw = bodyYaw
      if (velocity) {
        const vx = velocity[0] || 0, vz = velocity[2] || 0
        const speed = Math.sqrt(vx * vx + vz * vz)
        if (speed > 0.5) {
          const sinY = Math.sin(_bodyYaw), cosY = Math.cos(_bodyYaw)
          const localFwd   = -vx * sinY - vz * cosY
          const localRight =  vx * cosY - vz * sinY
          _moveAngle = Math.atan2(localRight, localFwd)
        } else { _moveAngle = 0 }
      }
    }
  }
}

const GLB_FUZZY = [
  ['idle', 'IdleLoop'], ['walk', 'WalkLoop'], ['jog', 'JogFwdLoop'], ['run', 'JogFwdLoop'],
  ['sprint', 'SprintLoop'], ['jumpstart', 'JumpStart'], ['jumploop', 'JumpLoop'],
  ['jumpland', 'JumpLand'], ['land', 'JumpLand'], ['crouchidle', 'CrouchIdleLoop'],
  ['crouchwalk', 'CrouchFwdLoop'], ['death', 'Death'], ['shoot', 'PistolShoot'],
  ['aim', 'Aim'], ['reload', 'PistolReload']
]

export function createGLBAnimator(gltfScene, gltfAnimations, animAssets, animConfig = {}) {
  const root = gltfScene
  const mixer = new THREE.AnimationMixer(root)
  mixer.timeScale = animConfig.mixerTimeScale || 1.3
  const validBones = buildValidBoneSet(root)

  let clips
  if (gltfAnimations && gltfAnimations.length > 0) {
    clips = new Map()
    for (const anim of gltfAnimations) {
      const key = anim.name.toLowerCase().replace(/[^a-z]/g, '')
      const state = STATES[anim.name] ? anim.name : GLB_FUZZY.find(([pat]) => key.includes(pat))?.[1]
      if (state) clips.set(state, anim)
    }
    console.log(`[anim] GLB has ${gltfAnimations.length} embedded anims, mapped:`, [...clips.keys()])
  } else if (animAssets?.rawClips || animAssets?.normalizedClips) {
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

  const { actions, additiveActions } = buildActionsFromClips(mixer, clips, animConfig)
  return createAnimationStateMachine(mixer, root, actions, additiveActions, { ...animConfig, skipWalk: true })
}
