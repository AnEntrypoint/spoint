import * as THREE from 'three'

const _isNode = typeof process !== 'undefined' && process.versions?.node
const { createMachine, createActor } = await import(_isNode ? 'xstate' : '/node_modules/xstate/dist/xstate.esm.js')

export const FADE_TIME = 0.15

export const STATES = {
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
  PistolReload: { loop: false, next: 'IdleLoop', duration: 2.6, upperBody: true }, // duration*timeScale must match the 2000ms server reload
  // Per-weapon upper-body additive aim poses (animation-aim-ik-camera-pitch-layer row): the library
  // ships these as short (4-frame) POSE clips, not animated loops, but `loop:true` still matters --
  // AnimationAction.play() with LoopOnce on a near-zero-duration clip finishes almost immediately and
  // the mixer's 'finished' listener would then treat it like a one-shot (see the `!STATES[oneShot]
  // ?.additive` gate above, which already exists for exactly this reason: additive pose actions are
  // never driven through the oneShot/next state-machine path at all, only through weight). Registered
  // here so buildActionsFromClips (PlayerAnimator.js) builds a real upperBody+additive AnimationAction
  // per pose; PlayerAnimator's applyBoneOverrides owns blending their .weight by camera pitch, this
  // table only needs to make the action exist.
  PistolAimUp: { loop: true, additive: true, upperBody: true },
  PistolAimNeutral: { loop: true, additive: true, upperBody: true },
  PistolAimDown: { loop: true, additive: true, upperBody: true },
  // Second real weapon trio (animation-weapon-2nd-aim-clip-trio-authoring row): baked directly into
  // anim-lib.glb as RifleAimUp/Neutral/Down@4 clips, same 4-frame/2-keyframe static-pose shape as the
  // Pistol trio (built by composing a per-bone local quaternion delta onto the Pistol trio's own
  // baked pose data -- squarer shoulders, both forearms raised/bent further for a two-handed grip,
  // more forward spine lean -- so it is a genuinely distinct rifle stance, not a renamed copy).
  RifleAimUp: { loop: true, additive: true, upperBody: true },
  RifleAimNeutral: { loop: true, additive: true, upperBody: true },
  RifleAimDown: { loop: true, additive: true, upperBody: true }
}

// Per-weapon aim-pose clip trios, keyed by weapon name (matches the row's "a future weapon may ship
// its own Aim* clip trio" spec) -- resolved lazily against whatever additive actions actually exist
// (buildActionsFromClips only builds an action for a clip the library actually shipped), so a weapon
// with no dedicated trio in the library silently falls back to the flat spine-pitch split alone
// instead of throwing. Pistol and Rifle are the two trios anim-lib.glb currently ships.
export const WEAPON_AIM_POSES = {
  Pistol: { down: 'PistolAimDown', neutral: 'PistolAimNeutral', up: 'PistolAimUp' },
  Rifle: { down: 'RifleAimDown', neutral: 'RifleAimNeutral', up: 'RifleAimUp' }
}


const locoMachine = createMachine({
  id: 'loco',
  initial: 'IdleLoop',
  states: {
    IdleLoop: { on: { WALK: 'WalkLoop', JOG: 'JogFwdLoop', SPRINT: 'SprintLoop', CROUCH_IDLE: 'CrouchIdleLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    WalkLoop: { on: { IDLE: 'IdleLoop', JOG: 'JogFwdLoop', SPRINT: 'SprintLoop', CROUCH_FWD: 'CrouchFwdLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    JogFwdLoop: { on: { IDLE: 'IdleLoop', WALK: 'WalkLoop', SPRINT: 'SprintLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    SprintLoop: { on: { IDLE: 'IdleLoop', WALK: 'WalkLoop', JOG: 'JogFwdLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    CrouchIdleLoop: { on: { IDLE: 'IdleLoop', CROUCH_FWD: 'CrouchFwdLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    CrouchFwdLoop: { on: { IDLE: 'IdleLoop', CROUCH_IDLE: 'CrouchIdleLoop', JUMP: 'JumpLoop', DEATH: 'Death' } },
    JumpLoop: { on: { IDLE: 'IdleLoop', WALK: 'WalkLoop', JOG: 'JogFwdLoop', SPRINT: 'SprintLoop', CROUCH_IDLE: 'CrouchIdleLoop', CROUCH_FWD: 'CrouchFwdLoop', LAND: 'JumpLand', DEATH: 'Death' } },
    JumpLand: { on: { IDLE: 'IdleLoop', WALK: 'WalkLoop', JOG: 'JogFwdLoop', SPRINT: 'SprintLoop', CROUCH_IDLE: 'CrouchIdleLoop', CROUCH_FWD: 'CrouchFwdLoop', DEATH: 'Death' } },
    Death: { on: { REVIVE: 'IdleLoop' } }
  }
})

// 2D blend-space locomotion: the forward-speed axis (Idle -> Walk -> Jog -> Sprint) is a continuous
// blend-tree, not a discrete crossfade chain. Each tier below is a 1D anchor point on that axis with a
// reference speed (m/s) the source clip was captured at; `update()` finds the two tiers bracketing the
// current smoothed speed and drives BOTH actions' `.weight` simultaneously (both playing, both summed by
// the mixer -- three's AnimationAction weight model does the actual blend), instead of the old
// fadeOut-one/fadeIn-the-other crossfade which always had exactly one non-zero-weight loco action. Foot
// -phase sync (so blended legs don't cross/double-step) comes from normalizing each action's play time to
// the SAME [0,1) cycle phase every frame -- a real sync-marker match for two cyclic loops, not just a
// shared start time, since the two clips have different real durations/frame counts.
const BLEND_TIERS = [
  { name: 'IdleLoop', speed: 0 },
  { name: 'WalkLoop', speed: 1.4 },
  { name: 'JogFwdLoop', speed: 5.5 },
  { name: 'SprintLoop', speed: 9.5 }
]
// skipWalk (GLB path, no separate Walk clip) blends directly Idle -> Jog -> Sprint.
const BLEND_TIERS_SKIP_WALK = [
  { name: 'IdleLoop', speed: 0 },
  { name: 'JogFwdLoop', speed: 4.0 },
  { name: 'SprintLoop', speed: 9.5 }
]

export function createAnimationStateMachine(mixer, root, actions, additiveActions, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])
  const blendTiers = (animConfig.skipWalk ? BLEND_TIERS_SKIP_WALK : BLEND_TIERS).filter(t => actions.has(t.name))
  // Only enable continuous blending when every anchor clip actually resolved to a real action -- a
  // library missing a tier (e.g. no WalkLoop shipped) falls back to the pre-existing discrete
  // crossfade path below rather than blending across a hole in the speed axis.
  const blendReady = blendTiers.length >= 2
  const BLEND_SMOOTH = 10.0 // weight-smoothing rate, distinct from SPEED_SMOOTH (speed input) so weight settles quickly without the raw-speed jitter
  let blendWeights = new Map()
  // Grace window so a brief terrain-bump onGround=false blip isn't read as airborne.
  const AIR_GRACE = 0.28
  // Requires upward velocity to count as a jump, so a downward terrain step isn't misread as one.
  const JUMP_LAUNCH_VY = 1.0
  const SPEED_SMOOTH = 8.0
  const TIMESCALE_SMOOTH = 10.0
  const LOCO_COOLDOWN = 0.3

  const actor = createActor(locoMachine)
  actor.start()
  let current = null
  let oneShot = null
  let oneShotTimer = 0
  let wasOnGround = true
  let peakRiseSpeed = 0
  let wasJumping = false
  let airTime = 0
  let peakFallSpeed = 0
  let smoothSpeed = 0
  let smoothTimeScale = 1.0
  let locomotionCooldown = 0
  let scaledLocoState = null
  const HARD_LAND_FALL_VY = animConfig.hardLandFallVy ?? -8.0
  const HARD_LAND_AIR_TIME = animConfig.hardLandAirTime ?? 1.2

  // Must check cooldown BEFORE advancing the xstate actor, or actor/current desync permanently (no self-transition to retry).
  const LOCO_EVENT_TARGET = { WALK: 'WalkLoop', JOG: 'JogFwdLoop', SPRINT: 'SprintLoop', CROUCH_FWD: 'CrouchFwdLoop', IDLE: 'IdleLoop', CROUCH_IDLE: 'CrouchIdleLoop' }

  function locoSwapBlocked(name) {
    return name !== 'IdleLoop' && name !== 'CrouchIdleLoop' &&
      LOCO_STATES.has(name) && LOCO_STATES.has(current) && locomotionCooldown > 0
  }

  function transitionTo(name) {
    if (current === name) return
    if (locoSwapBlocked(name)) return
    const prev = actions.get(current)
    const next = actions.get(name)
    if (!next) return
    if (prev) prev.fadeOut(FADE)
    next.reset().fadeIn(FADE).play()
    current = name
    if (LOCO_STATES.has(name) && name !== 'IdleLoop' && name !== 'CrouchIdleLoop') locomotionCooldown = LOCO_COOLDOWN
  }

  function sendLoco(event) {
    const snap = actor.getSnapshot()
    if (!snap.can({ type: event })) return
    const target = LOCO_EVENT_TARGET[event]
    if (target && locoSwapBlocked(target)) return
    actor.send({ type: event })
    transitionTo(actor.getSnapshot().value)
  }

  if (actions.has('IdleLoop')) { actions.get('IdleLoop').play(); current = 'IdleLoop' }

  mixer.addEventListener('finished', () => {
    if (oneShot && !STATES[oneShot]?.additive) {
      const cfg = STATES[oneShot]
      if (cfg?.clamp) return
      oneShot = null; oneShotTimer = 0
      if (cfg?.next) sendLoco(cfg.next === 'IdleLoop' ? 'IDLE' : cfg.next)
    }
  })

  // suppressLegacyAim (animation-aim-ik-camera-pitch-layer row): set by PlayerAnimator.js's
  // createPlayerAnimator when this character resolved a real per-weapon aim-pose trio (WEAPON_AIM_POSES)
  // for its default weapon -- that pose blend owns the additive aim layer instead, and letting this flat
  // single-clip 'Aim' action fade in as well would ADD a second additive contribution on top of it (both
  // target overlapping arm/spine tracks), visibly doubling/fighting the pose. No-op, not a hard error, so
  // a caller with no trio (e.g. createGLBAnimator's raw-GLB path, which never sets the flag) is unaffected.
  function aim(active) {
    if (animConfig.suppressLegacyAim) return
    const action = additiveActions.get('Aim')
    if (!action) return
    if (active) { if (!action.isRunning()) action.fadeIn(FADE).play() }
    else { if (action.isRunning()) action.fadeOut(FADE) }
  }

  // Returns {name: weight} for the (at most two) adjacent tiers bracketing `speed`, weight in [0,1],
  // summing to 1 across the pair -- a real linear 1D blend-space evaluation, not a threshold pick.
  function evalBlendTiers(speed) {
    const out = new Map()
    if (!blendReady) return out
    if (speed <= blendTiers[0].speed) { out.set(blendTiers[0].name, 1); return out }
    const last = blendTiers[blendTiers.length - 1]
    if (speed >= last.speed) { out.set(last.name, 1); return out }
    for (let i = 0; i < blendTiers.length - 1; i++) {
      const a = blendTiers[i], b = blendTiers[i + 1]
      if (speed >= a.speed && speed <= b.speed) {
        const span = b.speed - a.speed
        const t = span > 0 ? (speed - a.speed) / span : 0
        out.set(a.name, 1 - t)
        out.set(b.name, t)
        return out
      }
    }
    return out
  }

  // Phase-locks every blended action to the SAME normalized [0,1) cycle position each frame (sync
  // marker), driven off the fastest currently-weighted action's own advancing time so footfalls in the
  // blended pair stay coincident instead of drifting apart at their native durations/timeScales.
  function syncBlendPhase(weights, dt) {
    let driverName = null, driverWeight = -1
    for (const [name, w] of weights) { if (w > driverWeight) { driverWeight = w; driverName = name } }
    const driver = driverName && actions.get(driverName)
    if (!driver) return
    const driverClip = driver.getClip()
    if (!driverClip || driverClip.duration <= 0) return
    const phase = (driver.time % driverClip.duration + driverClip.duration) % driverClip.duration / driverClip.duration
    for (const name of weights.keys()) {
      if (name === driverName) continue
      const action = actions.get(name)
      const clip = action?.getClip()
      if (!clip || clip.duration <= 0) continue
      action.time = phase * clip.duration
    }
  }

  function resolveLocoEvent(smoothSpeed, crouching, skipWalk) {
    if (crouching) return smoothSpeed < 0.8 ? 'CROUCH_IDLE' : 'CROUCH_FWD'
    if (skipWalk) {
      const idle2jog = current === 'IdleLoop' ? 2.0 : 0.8
      const jog2sprint = current === 'JogFwdLoop' ? 10.5 : 10.0
      if (smoothSpeed < idle2jog) return 'IDLE'
      if (smoothSpeed < jog2sprint) return 'JOG'
      return 'SPRINT'
    }
    const idle2walk = current === 'IdleLoop' ? 0.5 : 0.3
    const walk2jog = current === 'WalkLoop' ? 8.5 : 8.0
    const jog2sprint = current === 'JogFwdLoop' ? 11.0 : 10.5
    if (smoothSpeed < idle2walk) return 'IDLE'
    if (smoothSpeed < walk2jog) return 'WALK'
    if (smoothSpeed < jog2sprint) return 'JOG'
    return 'SPRINT'
  }

  function update(dt, velocity, onGround, health, aiming, crouching, bodyYaw) {
    if (locomotionCooldown > 0) locomotionCooldown -= dt
    if (oneShotTimer > 0) {
      oneShotTimer -= dt
      if (oneShotTimer <= 0) {
        const cfg = STATES[oneShot]
        oneShot = null
        if (cfg?.next) sendLoco(cfg.next === 'IdleLoop' ? 'IDLE' : cfg.next)
      }
    }
    const vyNow = velocity?.[1] || 0
    if (!onGround) { airTime += dt; if (vyNow < peakFallSpeed) peakFallSpeed = vyNow; if (vyNow > peakRiseSpeed) peakRiseSpeed = vyNow }
    else { airTime = 0; peakRiseSpeed = 0 }
    const effectiveOnGround = onGround || airTime < AIR_GRACE
    const launchedUp = peakRiseSpeed >= JUMP_LAUNCH_VY

    if (health <= 0 && current !== 'Death') {
      sendLoco('DEATH'); oneShot = 'Death'
    } else if (health > 0 && (oneShot === 'Death' || current === 'Death')) {
      const deathAction = actions.get('Death')
      if (deathAction) { deathAction.stop(); deathAction.reset() }
      oneShot = null; oneShotTimer = 0; current = null
      sendLoco('REVIVE')
    } else if (!oneShot || STATES[oneShot]?.additive) {
      const vx = velocity?.[0] || 0, vz = velocity?.[2] || 0
      const rawSpeed = Math.sqrt(vx * vx + vz * vz)
      smoothSpeed += (rawSpeed - smoothSpeed) * Math.min(1, SPEED_SMOOTH * dt)
      if (!effectiveOnGround && !wasOnGround && launchedUp) { sendLoco('JUMP'); wasJumping = true }
      else if (!wasOnGround && effectiveOnGround && wasJumping) {
        wasJumping = false
        const hardLand = peakFallSpeed <= HARD_LAND_FALL_VY || airTime >= HARD_LAND_AIR_TIME
        if (hardLand) { sendLoco('LAND'); oneShot = 'JumpLand'; oneShotTimer = STATES.JumpLand.duration }
        else sendLoco(resolveLocoEvent(smoothSpeed, crouching, animConfig.skipWalk))
        peakFallSpeed = 0
      } else if (effectiveOnGround) sendLoco(resolveLocoEvent(smoothSpeed, crouching, animConfig.skipWalk))
    }

    const movingLoco = current && LOCO_STATES.has(current) && current !== 'IdleLoop' && current !== 'CrouchIdleLoop'
    if (movingLoco) {
      const locoAction = actions.get(current)
      if (locoAction) {
        const prevWasMovingLoco = scaledLocoState && LOCO_STATES.has(scaledLocoState) && scaledLocoState !== 'IdleLoop' && scaledLocoState !== 'CrouchIdleLoop'
        const freshEntry = !prevWasMovingLoco
        if (freshEntry) {
          const vx0 = velocity?.[0] || 0, vz0 = velocity?.[2] || 0
          smoothSpeed = Math.sqrt(vx0 * vx0 + vz0 * vz0)
        }
        const baseScale = current === 'WalkLoop' ? (animConfig.walkTimeScale || 1.0) * 0.5
          : current === 'JogFwdLoop' ? (animConfig.jogTimeScale || 1.0)
          : current === 'SprintLoop' ? (animConfig.sprintTimeScale || 1.0) : 1.0
        const stateMin = current === 'WalkLoop' ? 0.3 : current === 'JogFwdLoop' ? 8.0 : current === 'SprintLoop' ? 10.5 : 0.3
        const stateMax = current === 'WalkLoop' ? 8.5 : current === 'JogFwdLoop' ? 11.0 : current === 'SprintLoop' ? 13.0 : 6.0
        const ratio = Math.max(0.5, Math.min(1.5, smoothSpeed / Math.max(1, (stateMin + stateMax) * 0.5)))
        const target = baseScale * ratio
        const vx = velocity?.[0] || 0, vz = velocity?.[2] || 0
        // Reverse cycle only on genuine backpedal, not a lateral strafe.
        const localFwd = bodyYaw != null ? (vx * Math.sin(bodyYaw) + vz * Math.cos(bodyYaw)) : 1
        const localRight = bodyYaw != null ? (vx * Math.cos(bodyYaw) - vz * Math.sin(bodyYaw)) : 0
        const isBackpedal = localFwd < -0.5 && Math.abs(localFwd) >= Math.abs(localRight)
        const signedTarget = target * (isBackpedal ? -1 : 1)
        if (freshEntry) smoothTimeScale = signedTarget
        else smoothTimeScale += (signedTarget - smoothTimeScale) * Math.min(1, TIMESCALE_SMOOTH * dt)
        locoAction.timeScale = smoothTimeScale
        // While the blend-space overlay below has more than one tier action simultaneously weighted
        // (e.g. mid-blend between Jog and Sprint), apply the SAME signed timeScale to every other
        // currently-running blend-tier action too -- otherwise only the xstate-logical `current` tier
        // gets the backpedal-reverse/speed-scale and its blend partner keeps playing forward at its
        // default rate, desyncing the two legs mid-blend (a visible foot-skate/cross artifact).
        if (blendReady) {
          for (const tier of blendTiers) {
            if (tier.name === current) continue
            const other = actions.get(tier.name)
            if (other && other.isRunning()) other.timeScale = smoothTimeScale
          }
        }
      }
    }
    scaledLocoState = movingLoco ? current : (current === 'IdleLoop' || current === 'CrouchIdleLoop' ? current : null)

    // Continuous blend-space overlay: only active while xstate's logical `current` is one of the
    // forward-axis loco tiers (not Crouch*, which has no intermediate speed anchors on this axis, and
    // not while a one-shot/Death/etc is suppressing locomotion entirely -- same gate as the discrete
    // path above). Runs the real 3-way (or 4-way, when Walk is present) weighted blend so the
    // transition between e.g. Jog and Sprint is a smooth continuum keyed on `smoothSpeed`, not a single
    // fadeOut/fadeIn crossfade -- xstate's own transitionTo() crossfade calls above still run and still
    // own play()/stop() lifecycle for every action; this only overrides the resulting .weight per frame
    // for the loco tier set so more than one can be simultaneously audible-in-blend.
    const blendableCurrent = current === 'IdleLoop' || current === 'WalkLoop' || current === 'JogFwdLoop' || current === 'SprintLoop'
    if (blendReady && blendableCurrent && (!oneShot || STATES[oneShot]?.additive)) {
      const targetWeights = evalBlendTiers(smoothSpeed)
      // Ensure every tier action with nonzero target weight (this frame or fading out from last frame) is playing so its .weight actually contributes to the mixer sum.
      for (const tier of blendTiers) {
        const action = actions.get(tier.name)
        if (!action) continue
        const targetW = targetWeights.get(tier.name) || 0
        const prevW = blendWeights.get(tier.name) || 0
        if ((targetW > 0.001 || prevW > 0.001) && !action.isRunning()) { action.reset().play() }
      }
      const nextWeights = new Map()
      for (const tier of blendTiers) {
        const action = actions.get(tier.name)
        if (!action) continue
        const targetW = targetWeights.get(tier.name) || 0
        const prevW = blendWeights.get(tier.name) || 0
        const w = prevW + (targetW - prevW) * Math.min(1, BLEND_SMOOTH * dt)
        action.weight = w
        action.enabled = w > 0.001 || targetW > 0.001
        nextWeights.set(tier.name, w)
        if (w <= 0.001 && targetW <= 0.001 && action.isRunning()) action.stop()
      }
      blendWeights = nextWeights
      syncBlendPhase(targetWeights, dt)
    } else if (blendReady && blendWeights.size > 0) {
      for (const tier of blendTiers) {
        const a = actions.get(tier.name)
        if (!a) continue
        if (tier.name === current) { a.weight = 1 }
        else if (a.isRunning()) { a.weight = 0; a.stop() }
      }
      blendWeights = new Map()
    }

    aim(aiming)
    wasOnGround = effectiveOnGround
    mixer.update(dt)
  }
  // Arbitrary-clip one-shot (emote/gesture wheel; roadmap #78 -- also the real fix for
  // ctx.players.playAnimation's client_anim wire event, whose player_anim handler in client/app.js
  // expects a .play(clip, opts) method on this exact object and previously silently no-op'd since no
  // such method existed here). Unlike the fixed STATES[] table (locomotion + weapon one-shots, each
  // with its own declared duration/next), an emote clip is an arbitrary name not necessarily present
  // in STATES/actions -- looked up directly in the raw `actions` map (built from every clip the
  // animation library shipped, not just the curated locomotion set), so any clip name works without
  // pre-declaring it. Suspends locomotion updates (same oneShot gate the existing PistolShoot/
  // PistolReload/JumpLand one-shots already use) for opts.loop:false clips so the emote fully plays
  // out uninterrupted; opts.loop:true (dance-style) plays indefinitely until a new transitionTo/play/
  // sendLoco call interrupts it -- update()'s existing `!oneShot || STATES[oneShot]?.additive` gate
  // already skips locomotion resolution while oneShot is set, this reuses that gate rather than adding
  // a second parallel suspend mechanism.
  function play(clipName, opts = {}) {
    const action = actions.get(clipName)
    if (!action) return false
    const prev = actions.get(current)
    if (prev && prev !== action) prev.fadeOut(opts.fade ?? FADE)
    action.reset().setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
    action.clampWhenFinished = !opts.loop
    action.fadeIn(opts.fade ?? FADE).play()
    current = clipName
    if (!opts.loop) {
      oneShot = clipName
      oneShotTimer = 0 // driven by the mixer 'finished' listener below (per-clip, not the fixed STATES[]-duration timer path), correct for an arbitrary clip whose real length isn't declared anywhere
      const onFinished = (e) => {
        if (e.action !== action) return
        mixer.removeEventListener('finished', onFinished)
        if (oneShot === clipName) { oneShot = null; sendLoco('IDLE') }
      }
      mixer.addEventListener('finished', onFinished)
    }
    return true
  }
  function shoot() {
    const action = actions.get('PistolShoot')
    if (!action) return
    action.reset().fadeIn(0.05).play()
  }
  function reload() {
    const action = actions.get('PistolReload')
    if (!action) throw new Error('[anim] PistolReload animation not found')
    action.reset().fadeIn(0.1).play()
  }
  function dispose() {
    actor.stop()
    mixer.stopAllAction()
    mixer.uncacheRoot(root)
  }
  function getState() { return current }
  function getDebug() { return { state: current, timeScale: smoothTimeScale, smoothSpeed, blendWeights: Object.fromEntries(blendWeights) } }
  return { transitionTo, play, update, aim, shoot, reload, dispose, getState, getDebug }
}