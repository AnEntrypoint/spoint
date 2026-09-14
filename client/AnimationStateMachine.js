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
  PistolReload: { loop: false, next: 'IdleLoop', duration: 2.6, upperBody: true },
  PistolAimUp: { loop: true, additive: true, upperBody: true },
  PistolAimNeutral: { loop: true, additive: true, upperBody: true },
  PistolAimDown: { loop: true, additive: true, upperBody: true },
  RifleAimUp: { loop: true, additive: true, upperBody: true },
  RifleAimNeutral: { loop: true, additive: true, upperBody: true },
  RifleAimDown: { loop: true, additive: true, upperBody: true }
}

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

const BLEND_TIERS = [
  { name: 'IdleLoop', speed: 0 },
  { name: 'WalkLoop', speed: 1.4 },
  { name: 'JogFwdLoop', speed: 5.5 },
  { name: 'SprintLoop', speed: 9.5 }
]
const BLEND_TIERS_SKIP_WALK = [
  { name: 'IdleLoop', speed: 0 },
  { name: 'JogFwdLoop', speed: 4.0 },
  { name: 'SprintLoop', speed: 9.5 }
]

export function createAnimationStateMachine(mixer, root, actions, additiveActions, animConfig = {}) {
  const FADE = animConfig.fadeTime || FADE_TIME
  const LOCO_STATES = new Set(['IdleLoop', 'WalkLoop', 'JogFwdLoop', 'SprintLoop', 'CrouchIdleLoop', 'CrouchFwdLoop'])
  const blendTiers = (animConfig.skipWalk ? BLEND_TIERS_SKIP_WALK : BLEND_TIERS).filter(t => actions.has(t.name))
  const blendReady = blendTiers.length >= 2
  const BLEND_WEIGHT_SMOOTH_RATE = 10.0
  let blendWeights = new Map()
  let _weightsSpare = new Map()
  const AIR_GRACE = 0.28
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

  let _lastSentLoco = null, _lastSentLocoValue = null
  function sendLoco(event) {
    const target = LOCO_EVENT_TARGET[event]
    if (target && locoSwapBlocked(target)) return
    const snap = actor.getSnapshot()
    if (target && snap.value === target) return
    if (!snap.can({ type: event })) return
    actor.send({ type: event })
    const after = actor.getSnapshot().value
    _lastSentLoco = event; _lastSentLocoValue = after
    transitionTo(after)
  }
  const _locoEvt = { type: '' }

  if (actions.has('IdleLoop')) { actions.get('IdleLoop').play(); current = 'IdleLoop' }

  mixer.addEventListener('finished', () => {
    if (oneShot && !STATES[oneShot]?.additive) {
      const cfg = STATES[oneShot]
      if (cfg?.clamp) return
      oneShot = null; oneShotTimer = 0
      if (cfg?.next) sendLoco(cfg.next === 'IdleLoop' ? 'IDLE' : cfg.next)
    }
  })

  function aim(active) {
    if (animConfig.suppressLegacyAim) return
    const action = additiveActions.get('Aim')
    if (!action) return
    if (active) { if (!action.isRunning()) action.fadeIn(FADE).play() }
    else { if (action.isRunning()) action.fadeOut(FADE) }
  }

  const _blendOut = new Map()
  function evalBlendTiers(speed) {
    const out = _blendOut
    out.clear()
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
        const localFwd = bodyYaw != null ? (vx * Math.sin(bodyYaw) + vz * Math.cos(bodyYaw)) : 1
        const localRight = bodyYaw != null ? (vx * Math.cos(bodyYaw) - vz * Math.sin(bodyYaw)) : 0
        const isBackpedal = localFwd < -0.5 && Math.abs(localFwd) >= Math.abs(localRight)
        const signedTarget = target * (isBackpedal ? -1 : 1)
        if (freshEntry) smoothTimeScale = signedTarget
        else smoothTimeScale += (signedTarget - smoothTimeScale) * Math.min(1, TIMESCALE_SMOOTH * dt)
        locoAction.timeScale = smoothTimeScale
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

    const blendableCurrent = current === 'IdleLoop' || current === 'WalkLoop' || current === 'JogFwdLoop' || current === 'SprintLoop'
    if (blendReady && blendableCurrent && (!oneShot || STATES[oneShot]?.additive)) {
      const targetWeights = evalBlendTiers(smoothSpeed)
      for (const tier of blendTiers) {
        const action = actions.get(tier.name)
        if (!action) continue
        const targetW = targetWeights.get(tier.name) || 0
        const prevW = blendWeights.get(tier.name) || 0
        if ((targetW > 0.001 || prevW > 0.001) && !action.isRunning()) { action.reset().play() }
      }
      const nextWeights = _weightsSpare; nextWeights.clear()
      for (const tier of blendTiers) {
        const action = actions.get(tier.name)
        if (!action) continue
        const targetW = targetWeights.get(tier.name) || 0
        const prevW = blendWeights.get(tier.name) || 0
        const w = prevW + (targetW - prevW) * Math.min(1, BLEND_WEIGHT_SMOOTH_RATE * dt)
        action.weight = w
        action.enabled = w > 0.001 || targetW > 0.001
        nextWeights.set(tier.name, w)
        if (w <= 0.001 && targetW <= 0.001 && action.isRunning()) action.stop()
      }
      _weightsSpare = blendWeights; blendWeights = nextWeights
      syncBlendPhase(targetWeights, dt)
    } else if (blendReady && blendWeights.size > 0) {
      for (const tier of blendTiers) {
        const a = actions.get(tier.name)
        if (!a) continue
        if (tier.name === current) { a.weight = 1 }
        else if (a.isRunning()) { a.weight = 0; a.stop() }
      }
      blendWeights.clear()
    }

    aim(aiming)
    wasOnGround = effectiveOnGround
    mixer.update(dt)
  }
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
      oneShotTimer = 0
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