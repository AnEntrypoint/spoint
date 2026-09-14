import * as THREE from 'three'
import { ANIM_TO_BLENDER, ANIM_TO_MIXAMO, detectBoneNameMap, remapMixamoClip, buildVRM0NormalizedRemap, remapClipToNormalized, filterValidClipTracks, filterUpperBodyTracks, buildValidBoneSet } from './AnimationUtils.js'
import { STATES, FADE_TIME, WEAPON_AIM_POSES, createAnimationStateMachine } from './AnimationStateMachine.js'

function buildActionsFromClips(mixer, clips, animConfig) {
  const actions = new Map()
  const additiveActions = new Map()
  const walkFallbacks = new Set(['JogFwdLoop', 'SprintLoop'])
  const synthClips = new Map(clips)
  if (clips.has('WalkLoop')) {
    for (const name of walkFallbacks) if (!clips.has(name)) synthClips.set(name, clips.get('WalkLoop'))
  }
  for (const [name, clip] of synthClips) {
    if (!STATES[name]) continue
    const cfg = STATES[name]
    const sourceClip = clip
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
      if (name === 'JogFwdLoop') action.timeScale = animConfig.jogTimeScale || 4.5
      if (name === 'SprintLoop') action.timeScale = animConfig.sprintTimeScale || 7.0
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
  const mixamoBoneMap = detectBoneNameMap(root)
  const remappedClips = new Map()
  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const sourceClip = clip
    const normalized = remapClipToNormalized(sourceClip, vrm0Remap)
    let retargeted = mixamoBoneMap ? remapMixamoClip(normalized, mixamoBoneMap, validBones) : normalized
    retargeted = new THREE.AnimationClip(retargeted.name, retargeted.duration, retargeted.tracks.map(t => {
      const dot = t.name.indexOf('.')
      const boneName = dot >= 0 ? t.name.slice(0, dot) : t.name
      const prop = dot >= 0 ? t.name.slice(dot) : ''
      const normName = 'Normalized_' + boneName
      if (!validBones.has(normName)) return t
      const nt = t.clone()
      nt.name = normName + prop
      return nt
    }))
    remappedClips.set(name, filterValidClipTracks(retargeted, validBones))
  }

  const { actions, additiveActions } = buildActionsFromClips(mixer, remappedClips, animConfig)
  const smAnimConfig = additiveActions.has('PistolAimDown') || additiveActions.has('PistolAimNeutral') || additiveActions.has('PistolAimUp')
    ? { ...animConfig, suppressLegacyAim: true }
    : animConfig
  const sm = createAnimationStateMachine(mixer, root, actions, additiveActions, smAnimConfig)

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
  const _headBones = (() => {
    const bones = []
    for (const n of ['neck', 'head']) { const b = _getBone(n); if (b) bones.push(b) }
    if (bones.length === 0) {
      const names = new Set(['J_Bip_C_Neck', 'J_Bip_C_Head', 'Neck', 'Head'])
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

  let _weaponName = 'Pistol'
  const _resolveAimTrio = (weaponName) => {
    const spec = WEAPON_AIM_POSES[weaponName]
    if (!spec) return null
    const down = additiveActions.get(spec.down) || null
    const neutral = additiveActions.get(spec.neutral) || null
    const up = additiveActions.get(spec.up) || null
    if (!down && !neutral && !up) return null
    return { down, neutral, up }
  }
  let _aimTrio = _resolveAimTrio(_weaponName)
  const legacyAim = additiveActions.get('Aim') || null
  const AIM_PITCH_DOWN = -Math.PI / 3, AIM_PITCH_UP = Math.PI / 4
  let _aimWeight = 0
  const AIM_WEIGHT_SMOOTH = 10.0

  let _lastAiming = false

  function applyAimPoseBlend(dt) {
    if (!_aimTrio) return
    const targetWeight = _lastAiming ? 1 : 0
    _aimWeight += (targetWeight - _aimWeight) * Math.min(1, AIM_WEIGHT_SMOOTH * dt)
    const p = THREE.MathUtils.clamp(_smoothPitch, AIM_PITCH_DOWN, AIM_PITCH_UP)
    let wDown = 0, wNeutral = 0, wUp = 0
    if (p <= 0) {
      const t = AIM_PITCH_DOWN < 0 ? THREE.MathUtils.clamp(p / AIM_PITCH_DOWN, 0, 1) : 0
      wDown = t; wNeutral = 1 - t
    } else {
      const t = AIM_PITCH_UP > 0 ? THREE.MathUtils.clamp(p / AIM_PITCH_UP, 0, 1) : 0
      wUp = t; wNeutral = 1 - t
    }
    _applyAimPose(_aimTrio.down, wDown)
    _applyAimPose(_aimTrio.neutral, wNeutral)
    _applyAimPose(_aimTrio.up, wUp)
  }
  function _applyAimPose(action, w) {
    if (!action) return
    const weight = w * _aimWeight
    if (weight > 0.001) { if (!action.isRunning()) action.reset().play(); action.weight = weight; action.enabled = true }
    else if (action.isRunning()) { action.weight = 0; action.stop() }
  }

  return {
    ...sm,
    aim(active) {
      _lastAiming = !!active
      if (_aimTrio) return
      sm.aim(active)
    },
    setWeapon(weaponName) {
      if (!weaponName || weaponName === _weaponName) return
      _weaponName = weaponName
      _aimTrio = _resolveAimTrio(_weaponName)
    },
    getDebug() {
      const base = sm.getDebug ? sm.getDebug() : {}
      return {
        ...base,
        weaponName: _weaponName,
        aimWeight: _aimWeight,
        aiming: _lastAiming,
        aimPoses: _aimTrio ? {
          down: _aimTrio.down ? { weight: _aimTrio.down.weight, running: _aimTrio.down.isRunning() } : null,
          neutral: _aimTrio.neutral ? { weight: _aimTrio.neutral.weight, running: _aimTrio.neutral.isRunning() } : null,
          up: _aimTrio.up ? { weight: _aimTrio.up.weight, running: _aimTrio.up.isRunning() } : null
        } : null,
        legacyAimRunning: legacyAim ? legacyAim.isRunning() : null
      }
    },
    update(dt, velocity, onGround, health, aiming, crouching, bodyYaw) {
      sm.update(dt, velocity, onGround, health, aiming, crouching, bodyYaw)
      _lastAiming = !!aiming
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
      const clampedPitch = Math.max(AIM_PITCH_DOWN, Math.min(AIM_PITCH_UP, _smoothPitch))
      const HEAD_SHARE = _headBones.length > 0 ? 0.5 : 0
      const headPitch = _headBones.length > 0 ? (clampedPitch * HEAD_SHARE) / _headBones.length : 0
      const spinePitchTotal = clampedPitch * (1 - HEAD_SHARE)
      if (_spineBones.length > 0) {
        const n = _spineBones.length
        const spineYawShare = -hipYaw / n
        const pitchShare = spinePitchTotal / n
        for (let i = 0; i < n; i++) {
          _eLook.setFromQuaternion(_spineBones[i].quaternion, 'YXZ')
          _eLook.y = spineYawShare
          _eLook.x = pitchShare
          _spineBones[i].quaternion.setFromEuler(_eLook)
        }
      }
      if (_headBones.length > 0) {
        for (let i = 0; i < _headBones.length; i++) {
          _eLook.setFromQuaternion(_headBones[i].quaternion, 'YXZ')
          _eLook.x = headPitch
          _headBones[i].quaternion.setFromEuler(_eLook)
        }
      }

      applyAimPoseBlend(dt)
    },
    setLookDirection(yaw, pitch, bodyYaw, velocity, dt) {
      _lookPitch = pitch
      if (bodyYaw !== undefined) _bodyYaw = bodyYaw
      if (velocity) {
        const vx = velocity[0] || 0, vz = velocity[2] || 0
        const speed2 = vx * vx + vz * vz
        if (speed2 > 0.25) {
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
      if (!STATES[name]) continue
      const remapped = boneMap ? remapMixamoClip(clip, boneMap, validBones) : filterValidClipTracks(clip, validBones)
      if (remapped.tracks.length > 0) clips.set(name, remapped)
    }
    console.log(`[anim] GLB using ${animAssets.rawClips ? 'raw' : 'normalized'} library clips (${clips.size} state clips valid, convention: ${boneMap === ANIM_TO_BLENDER ? 'Blender' : boneMap === ANIM_TO_MIXAMO ? 'Mixamo' : 'direct'})`)
  } else {
    clips = new Map()
  }

  const { actions, additiveActions } = buildActionsFromClips(mixer, clips, animConfig)
  return createAnimationStateMachine(mixer, root, actions, additiveActions, { ...animConfig, skipWalk: !clips.has('WalkLoop') })
}
