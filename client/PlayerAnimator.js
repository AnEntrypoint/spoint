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
  // The animation library ships Mixamo bone naming (mixamorigLeftArm etc); the VRM humanoid skeleton
  // uses its own normalized bone names (upper_armL etc, or Mixamo-convention names on some VRMs).
  // buildVRM0NormalizedRemap only bridges VRM0's raw<->normalized bone DUPLICATES within the same rig
  // (a v0-only quirk) -- it does nothing for the separate Mixamo-source-rig-vs-VRM-target-rig mismatch,
  // which affects VRM1 (and any VRM whose humanoid bones aren't literally named "mixamorig...") every
  // time. Witnessed live: with no cross-rig remap, filterValidClipTracks silently drops every arm/leg/
  // hand track whose Mixamo name doesn't lexically match a VRM bone name, leaving a "valid" clip that
  // only moves the handful of bones (root/hips/spine) that happen to coincide -- state machine and
  // mixer.update() both run fine, but the character sits in a near-bind-pose. createGLBAnimator (the
  // non-VRM raw-GLB path below) already solves this exact problem via detectBoneNameMap/remapMixamoClip;
  // the VRM path needs the identical bridge.
  const mixamoBoneMap = detectBoneNameMap(root)
  // three-vrm's VRMHumanoid re-derives every RAW bone from its NORMALIZED counterpart (a sibling
  // VRMHumanoidRig hierarchy, named Normalized_<bone>) on each vrm.update(dt) -- called AFTER the mixer
  // in app.js's tickPlayerAnimators -- unconditionally overwriting whatever the mixer wrote to the raw
  // bone that same frame. Witnessed live: a mixer.clipAction with correct nonzero tracks targeting raw
  // bone names (isRunning, weight 1, advancing time, real per-instant quaternion reads inside the tick)
  // still reads back as bind-pose identity one frame later, because vrm.update() stomps it. The
  // Normalized_ hierarchy IS reachable from vrm.scene (same root, sibling of the raw skeleton) so the
  // mixer can bind to it directly -- retarget onto Normalized_<targetBoneName> whenever it exists.
  // AUDIT (animation-clip-compression-shared-buffer row): this remap loop clones every track's
  // Float32Array keyframe data (THREE.KeyframeTrack.clone() deep-copies times+values) PER
  // CHARACTER, once per createPlayerAnimator call -- the SOURCE clip Map from AnimationLibrary.js
  // is a shared module-level singleton (_normalizedCache), but each on-screen VRM character still
  // ends up holding its own independent post-retarget copy, since each character's skeleton has
  // different bone names needing different remap targets.
  // Real live-measured cost (Playwright + real createPlayerAnimator calls against the actual
  // 108-clip anim-lib.glb, performance.memory before/after with window.gc()): ~76.7 KB/character.
  // At this game's 8-32 concurrent player range that's ~0.6-2.4 MB total duplicated across all
  // on-screen characters, against a ~2.3 MB single shared-buffer floor -- roughly 1-2x overhead,
  // not 10-100x. DECISION: not worth building a shared-buffer retarget scheme (e.g. bone-index
  // remapping applied at the AnimationAction/binding level instead of cloning whole clips) for
  // this measured magnitude -- a few MB is noise next to this game's actual GPU-texture/GLB asset
  // budget, and the retarget-at-binding-level design would need three.js's PropertyBinding/
  // PropertyMixer internals reworked to accept an external bone-index table per mixer, a
  // materially more complex + fragile change for a sub-2.5MB win. Revisit only if a future
  // profiling pass finds this is actually a measured bottleneck (heap pressure/GC pauses) at a
  // real target player count, not from this static estimate.
  const remappedClips = new Map()
  for (const [name, clip] of clips) {
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
  // Suppress AnimationStateMachine's own internal aim() (the flat single 'Aim' additive clip) whenever
  // this character resolves a real per-weapon pose trio for its DEFAULT weapon ('Pistol', the only
  // WEAPON_AIM_POSES entry today) -- update() below calls sm.update() which drives aim() internally
  // (not through the returned wrapper, so overriding the return value alone can't intercept it). A
  // later setWeapon() call to a weapon with no trio re-enables the legacy clip automatically (the flag
  // is read once at construction, matching the fact that the legacy 'Aim' action itself is also
  // resolved once here -- see the animConfig.suppressLegacyAim consumer in createAnimationStateMachine).
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
  // Head/neck look-at chain, separate from _spineBones: a real aim-IK layer gives the HEAD most of the
  // pitch (it's what visibly tracks the camera target) with the spine bones contributing a smaller
  // secondary lean, rather than the old flat pitch/n even split across every torso bone (which reads as
  // the whole spine bending in lockstep, not a head-led look). Falls back to an empty chain (head-only
  // via _spineBones' existing split) if neither semantic name nor a literal-name scan finds a neck/head.
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

  // Per-weapon upper-body additive aim poses (animation-aim-ik-camera-pitch-layer row). Resolved once
  // against whichever additive actions buildActionsFromClips actually built for the currently-equipped
  // weapon's trio (WEAPON_AIM_POSES) -- `null` entries mean the library didn't ship that pose, and the
  // blend below degrades gracefully (any missing pose is just never weighted above 0). Distinct from
  // (and REPLACES, not doubles with) the flat single 'Aim' additive action: sm.aim() below is
  // overridden to a no-op for any weapon that resolves a real pose trio, so the old single-clip aim
  // additive and this 3-pose pitch blend never apply on the same frame -- see applyAimPoseBlend.
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
  // Pitch band the pose blend spans, matching the spine-pitch clamp below (Math.PI/3 down, Math.PI/4
  // up) so the pose reaches full weight exactly at the same look-extreme the spine IK also maxes out at.
  const AIM_PITCH_DOWN = -Math.PI / 3, AIM_PITCH_UP = Math.PI / 4
  let _aimWeight = 0
  const AIM_WEIGHT_SMOOTH = 10.0

  let _lastAiming = false

  // Blends the resolved weapon's 3-pose additive trio by smoothed camera pitch (down/neutral/up), gated
  // to 0 while not aiming or with no trio resolved for the current weapon -- runs INSTEAD OF the legacy
  // single 'Aim' additive action (sm.aim() below no-ops whenever a real trio exists) so the two additive
  // layers never sum on the same bones in the same frame. Mirrors evalBlendTiers' 2-anchor linear blend
  // shape (AnimationStateMachine.js) but over 3 fixed pitch anchors (down/neutral/up) instead of N
  // dynamic speed tiers.
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
    const apply = (action, w) => {
      if (!action) return
      const weight = w * _aimWeight
      if (weight > 0.001) { if (!action.isRunning()) action.reset().play(); action.weight = weight; action.enabled = true }
      else if (action.isRunning()) { action.weight = 0; action.stop() }
    }
    apply(_aimTrio.down, wDown)
    apply(_aimTrio.neutral, wNeutral)
    apply(_aimTrio.up, wUp)
  }

  return {
    ...sm,
    // Direct-call path (mirrors the auto-driven path in update() below, which is what app.js actually
    // exercises every frame via ps._aiming): while a per-weapon pose trio is resolved, this row's
    // pitch-driven 3-pose blend (applyAimPoseBlend, from applyBoneOverrides) owns the additive aim
    // layer entirely, so this does NOT also call sm.aim() -- doing so would fade in the flat single
    // 'Aim' clip ADDITIVELY ON TOP of the pose blend, doubling the additive contribution on the same
    // spine/arm bones (createAnimationStateMachine's own internal aim() is separately no-op'd for this
    // case via the `suppressLegacyAim` animConfig flag set at construction, above). Falls back to the
    // original flat-clip behavior for any weapon with no resolved trio (e.g. a future weapon that
    // hasn't shipped Aim* clips yet), so aiming still reads as SOMETHING rather than nothing.
    aim(active) {
      _lastAiming = !!active
      if (_aimTrio) return
      sm.aim(active)
    },
    // Lets the caller (app.js, once a client-visible equipped-weapon signal exists) pick which
    // WEAPON_AIM_POSES trio drives the pitch blend; re-resolves against this character's own built
    // additiveActions (per-instance, not the shared library) each call. No-op-safe default: every
    // character starts on 'Pistol' (WEAPON_AIM_POSES' only current entry) even if never called.
    setWeapon(weaponName) {
      if (!weaponName || weaponName === _weaponName) return
      _weaponName = weaponName
      _aimTrio = _resolveAimTrio(_weaponName)
    },
    // Extends sm.getDebug() (spread via ...sm above, overridden here) with this row's aim-pose-blend
    // state -- live introspection surface for the same window.__animProbe consumer app.js already wires
    // up (tickPlayerAnimators), and the only way to directly witness action.weight/isRunning from
    // outside this closure (additiveActions itself is never returned).
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
      // sm.update() drives AnimationStateMachine's OWN internal aim() call directly (module-local
      // function, not through the returned wrapper below) -- mirror the same `aiming` flag here so
      // applyAimPoseBlend (driven from applyBoneOverrides, called separately by app.js right after
      // update()) sees the current aim state regardless of whether anything ever calls the wrapper.
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
      // Weighted look-at IK, not a flat pitch/n split: HEAD_SHARE of the clamped pitch goes to the
      // head/neck chain (what visibly tracks the aim target) and the remainder splits across the spine
      // bones -- replaces the old scheme where every torso bone (spine+chest+upperChest, no separate
      // head contribution) got an identical 1/n share, which read as the whole torso bending in
      // lockstep rather than a head-led look. Yaw (hip-counter-lean) share is unchanged.
      const clampedPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 4, _smoothPitch))
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
      // remapMixamoClip: the animation library's tracks carry raw Mixamo rig bone names
      // (mixamorig:LeftArm etc), not semantic keys -- see its own comment in AnimationUtils.js for
      // the full witnessed failure mode (silently-empty arm/leg tracks, mixer/state-machine both
      // reporting healthy while the actual clip carries zero moving bones).
      const remapped = boneMap ? remapMixamoClip(clip, boneMap, validBones) : filterValidClipTracks(clip, validBones)
      if (remapped.tracks.length > 0) clips.set(name, remapped)
    }
    console.log(`[anim] GLB using ${animAssets.rawClips ? 'raw' : 'normalized'} library clips (${clips.size} valid, convention: ${boneMap === ANIM_TO_BLENDER ? 'Blender' : boneMap === ANIM_TO_MIXAMO ? 'Mixamo' : 'direct'})`)
  } else {
    clips = new Map()
  }

  const { actions, additiveActions } = buildActionsFromClips(mixer, clips, animConfig)
  return createAnimationStateMachine(mixer, root, actions, additiveActions, { ...animConfig, skipWalk: !clips.has('WalkLoop') })
}
