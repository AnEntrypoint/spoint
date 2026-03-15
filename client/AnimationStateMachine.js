import * as THREE from 'three'

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
  PistolReload: { loop: false, next: 'IdleLoop', duration: 2.0, upperBody: true }
}

export const LOWER_BODY_BONES = new Set([
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

export function createAnimationStateMachine(mixer, root, actions, additiveActions, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])
  const AIR_GRACE = 0.15
  const SPEED_SMOOTH = 8.0
  const TIMESCALE_SMOOTH = 10.0
  const LOCO_COOLDOWN = 0.3

  let current = null
  let oneShot = null
  let oneShotTimer = 0
  let wasOnGround = true
  let airTime = 0
  let smoothSpeed = 0
  let smoothTimeScale = 1.0
  let locomotionCooldown = 0

  function transitionTo(name) {
    if (current === name) return
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

  function aim(active) {
    const action = additiveActions.get('Aim')
    if (!action) return
    if (active) { if (!action.isRunning()) action.fadeIn(FADE).play() }
    else { if (action.isRunning()) action.fadeOut(FADE) }
  }

  function update(dt, velocity, onGround, health, aiming, crouching) {
    if (locomotionCooldown > 0) locomotionCooldown -= dt
    if (oneShotTimer > 0) {
      oneShotTimer -= dt
      if (oneShotTimer <= 0) {
        const cfg = STATES[oneShot]
        oneShot = null
        if (cfg?.next) transitionTo(cfg.next)
      }
    }
    if (!onGround) airTime += dt; else airTime = 0
    const effectiveOnGround = onGround || airTime < AIR_GRACE

    if (health <= 0 && current !== 'Death') {
      transitionTo('Death')
      oneShot = 'Death'
    } else if (health > 0 && (oneShot === 'Death' || current === 'Death')) {
      const deathAction = actions.get('Death')
      if (deathAction) { deathAction.stop(); deathAction.reset() }
      oneShot = null; oneShotTimer = 0; current = null
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
          if (smoothSpeed < 0.8) transitionTo('CrouchIdleLoop'); else transitionTo('CrouchFwdLoop')
        } else {
          const idle2walk  = current === 'IdleLoop'   ? 0.5 : 0.3
          const walk2jog   = current === 'WalkLoop'   ? 4.0 : 3.5
          const jog2sprint = current === 'JogFwdLoop' ? 15.5 : 15.0
          if (smoothSpeed < idle2walk) transitionTo('IdleLoop')
          else if (smoothSpeed < walk2jog) transitionTo('WalkLoop')
          else if (smoothSpeed < jog2sprint) transitionTo('JogFwdLoop')
          else transitionTo('SprintLoop')
        }
      }
    }

    if (current && LOCO_STATES.has(current) && current !== 'IdleLoop' && current !== 'CrouchIdleLoop') {
      const locoAction = actions.get(current)
      if (locoAction) {
        const baseScale = current === 'WalkLoop' ? (animConfig.walkTimeScale || 16.0)
          : current === 'JogFwdLoop' ? (animConfig.jogTimeScale || 0.667)
          : current === 'SprintLoop' ? (animConfig.sprintTimeScale || 0.56) : 1.0
        const stateMin = current === 'WalkLoop' ? 0.3 : current === 'JogFwdLoop' ? 3.5 : current === 'SprintLoop' ? 12.0 : 0.3
        const stateMax = current === 'WalkLoop' ? 4.0 : current === 'JogFwdLoop' ? 15.5 : current === 'SprintLoop' ? 24.0 : 6.0
        const ratio = Math.max(0.5, Math.min(1.5, smoothSpeed / Math.max(1, (stateMin + stateMax) * 0.5)))
        const target = baseScale * ratio
        smoothTimeScale += (target - smoothTimeScale) * Math.min(1, TIMESCALE_SMOOTH * dt)
        locoAction.timeScale = smoothTimeScale
      }
    }

    aim(aiming)
    wasOnGround = effectiveOnGround
    mixer.update(dt)
  }

  function shoot() {
    const action = actions.get('PistolShoot')
    if (!action) return
    action.reset().fadeIn(0.05).play()
  }

  function reload() {
    const action = actions.get('PistolReload')
    if (!action) { console.log('[anim] PistolReload animation not found'); return }
    console.log('[anim] Playing reload animation')
    action.reset().fadeIn(0.1).play()
  }

  function dispose() {
    mixer.stopAllAction()
    mixer.uncacheRoot(root)
  }

  function getState() { return current }

  return { transitionTo, update, aim, shoot, reload, dispose, getState }
}
