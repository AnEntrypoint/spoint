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
  PistolShoot: { loop: false, next: null, duration: 0.3, overlay: true }
}

const q1 = new THREE.Quaternion()
const restInv = new THREE.Quaternion()
const parentRest = new THREE.Quaternion()

function normalizeClips(gltf, vrmVersion) {
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
      const bone = scene.getObjectByName(boneName)
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

export async function loadAnimationLibrary(vrmVersion) {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync('/anim-lib.glb')
  return normalizeClips(gltf, vrmVersion || '1')
}

export function createPlayerAnimator(root, clips) {
  const mixer = new THREE.AnimationMixer(root)
  const actions = new Map()
  for (const [name, clip] of clips) {
    if (!STATES[name]) continue
    const action = mixer.clipAction(clip)
    const cfg = STATES[name]
    if (!cfg.loop) {
      action.loop = THREE.LoopOnce
      action.clampWhenFinished = cfg.clamp || false
    }
    if (name === 'WalkLoop') action.timeScale = 2.0
    actions.set(name, action)
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
    if (prev) prev.fadeOut(FADE_TIME)
    next.reset().fadeIn(FADE_TIME).play()
    current = name
    if (LOCO_STATES.has(name)) locomotionCooldown = LOCO_COOLDOWN
  }

  if (actions.has('IdleLoop')) {
    actions.get('IdleLoop').play()
    current = 'IdleLoop'
  }

  mixer.addEventListener('finished', () => {
    if (oneShot) {
      const cfg = STATES[oneShot]
      oneShot = null
      oneShotTimer = 0
      if (cfg?.next) transitionTo(cfg.next)
    }
  })

  return {
    update(dt, velocity, onGround, health) {
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

      if (!oneShot) {
        const vx = velocity?.[0] || 0, vz = velocity?.[2] || 0
        const rawSpeed = Math.sqrt(vx * vx + vz * vz)
        smoothSpeed += (rawSpeed - smoothSpeed) * Math.min(1, SPEED_SMOOTH * dt)

        if (health <= 0) {
          transitionTo('Death')
          oneShot = 'Death'
        } else if (!effectiveOnGround && !wasOnGround) {
          transitionTo('JumpLoop')
        } else if (!wasOnGround && effectiveOnGround && smoothSpeed < 1.5) {
          transitionTo('JumpLand')
          oneShot = 'JumpLand'
          oneShotTimer = STATES.JumpLand.duration
        } else if (effectiveOnGround) {
          const idle2walk = current === 'IdleLoop' ? 0.8 : 0.3
          const walk2jog = current === 'WalkLoop' ? 4.5 : 3.5
          const jog2sprint = current === 'JogFwdLoop' ? 7.5 : 6.5
          if (smoothSpeed < idle2walk) transitionTo('IdleLoop')
          else if (smoothSpeed < walk2jog) transitionTo('WalkLoop')
          else if (smoothSpeed < jog2sprint) transitionTo('JogFwdLoop')
          else transitionTo('SprintLoop')
        }
      }

      wasOnGround = effectiveOnGround
      mixer.update(dt)
    },
    shoot() {
      const action = actions.get('PistolShoot')
      if (!action) return
      action.reset().fadeIn(0.05).play()
      oneShot = 'PistolShoot'
      oneShotTimer = STATES.PistolShoot.duration
    },
    dispose() {
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    }
  }
}
