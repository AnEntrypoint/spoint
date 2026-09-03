const COYOTE_BUFFER_MS = 30
const DEFAULT_HEIGHT = 1.8
const DEFAULT_SPEED = 5.0
const DEFAULT_JUMP_POWER = 8.0
const DEFAULT_AIR_CONTROL = 0.5
const GRAVITY = 9.8
const FALL_DAMAGE_THRESHOLD = 15.0
const FALL_DAMAGE_SCALE = 1.0

export default {
  description: 'Smooth FPS/TPS character controller with spring-damped camera, WASD movement, jumping with coyote buffer, physics capsule, and animation state.',

  server: {
    editorProps: [
      { key: 'cameraMode', label: 'Camera Mode', type: 'select', options: ['fps', 'tps'], default: 'fps' },
      { key: 'height', label: 'Height (m)', type: 'range', min: 1.2, max: 2.5, step: 0.1, default: DEFAULT_HEIGHT },
      { key: 'speed', label: 'Speed (m/s)', type: 'range', min: 2, max: 15, step: 0.5, default: DEFAULT_SPEED },
      { key: 'jumpPower', label: 'Jump Power (m/s)', type: 'range', min: 2, max: 20, step: 0.5, default: DEFAULT_JUMP_POWER },
      { key: 'airControl', label: 'Air Control', type: 'range', min: 0, max: 1, step: 0.1, default: DEFAULT_AIR_CONTROL }
    ],

    setup(ctx) {
      const height = ctx.config?.height ?? DEFAULT_HEIGHT
      const speed = ctx.config?.speed ?? DEFAULT_SPEED
      const jumpPower = ctx.config?.jumpPower ?? DEFAULT_JUMP_POWER
      const airControl = ctx.config?.airControl ?? DEFAULT_AIR_CONTROL
      const cameraMode = ctx.config?.cameraMode ?? 'fps'

      ctx.physics.addColliderFromConfig({ type: 'capsule', height, dynamic: true })

      if (!ctx.entity.custom) ctx.entity.custom = {}
      ctx.entity.custom._charCtl = {
        cameraMode,
        height,
        speed,
        jumpPower,
        airControl,
        velocityY: 0,
        isGrounded: false,
        lastGroundedTime: 0,
        jumpQueued: false,
        fallStartHeight: 0,
        fallStartTime: 0
      }
    },

    update(ctx, dt) {
      const ctl = ctx.entity.custom?._charCtl
      if (!ctl) return

      const player = ctx.players.getById(ctx.entity.playerId)
      if (!player) return

      const pos = ctx.entity.state?.position || [0, 0, 0]
      const vel = ctx.entity.state?.velocity || [0, 0, 0]
      const input = player.input || {}

      const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0)
      const moveZ = (input.forward ? 1 : 0) - (input.backward ? 1 : 0)
      const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ)

      ctl.isGrounded = ctx.physics.raycastDown(pos, 0.2)
      if (ctl.isGrounded) {
        ctl.lastGroundedTime = ctx.time.elapsed
        if (ctl.fallStartTime) {
          const fallDist = ctl.fallStartHeight - pos[1]
          if (fallDist > FALL_DAMAGE_THRESHOLD) {
            const damage = (fallDist - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_SCALE
            player.health = Math.max(0, (player.health || 100) - damage)
            if (player.health <= 0) {
              ctx.players.respawn(player.id)
            }
          }
          ctl.fallStartTime = 0
        }
      } else if (!ctl.fallStartTime) {
        ctl.fallStartHeight = pos[1]
        ctl.fallStartTime = ctx.time.elapsed
      }

      const canJump = (ctx.time.elapsed - ctl.lastGroundedTime) <= (COYOTE_BUFFER_MS / 1000)
      if (input.jump && canJump && !ctl.jumpQueued) {
        ctl.jumpQueued = true
        ctl.velocityY = ctl.jumpPower
        ctl.isGrounded = false
        ctx.bus.emit('player:jump', { playerId: ctx.entity.playerId, pos })
      }
      if (!input.jump) {
        ctl.jumpQueued = false
      }

      ctl.velocityY = Math.max(ctl.velocityY - GRAVITY * dt, -100)

      let moveForce = ctl.speed
      if (!ctl.isGrounded) {
        moveForce *= ctl.airControl
      }

      let targetVelX = 0, targetVelZ = 0
      if (moveLen > 0) {
        const norm = moveForce / moveLen
        targetVelX = moveX * norm
        targetVelZ = moveZ * norm
      }

      const moveAccel = 20.0
      vel[0] += (targetVelX - vel[0]) * Math.min(1, moveAccel * dt)
      vel[2] += (targetVelZ - vel[2]) * Math.min(1, moveAccel * dt)
      vel[1] = ctl.velocityY

      const speed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2])
      const direction = moveLen > 0 ? [moveX / moveLen, 0, moveZ / moveLen] : [0, 0, 0]
      const locoState = ctl.isGrounded ? (speed > 0.5 ? 'walk' : 'idle') : 'jump'

      ctx.bus.emit('player:loco', { playerId: ctx.entity.playerId, speed, direction, state: locoState })
    },

    onMessage(ctx, msg) {
      if (msg?.type === 'footstep') {
        ctx.bus.emit('player:footstep', { playerId: ctx.entity.playerId, position: ctx.entity.state?.position })
      }
    }
  },

  client: {
    setup(engine) {
      engine._charCtl = {
        cameraMode: 'fps',
        pitchVel: 0,
        yawVel: 0,
        targetPitch: 0,
        targetYaw: 0,
        dampingPitch: 0.08,
        dampingYaw: 0.08,
        springStiffness: 1.2,
        lastFrameTime: Date.now()
      }
    },

    onInput(input, engine) {
      const ctl = engine._charCtl
      if (!ctl) return

      const player = engine.client?.state?.players?.find(p => p.id === engine.playerId)
      if (!player?.custom?._charCtl) return

      ctl.cameraMode = player.custom._charCtl.cameraMode

      const mouseDeltaX = input.mouseDelta?.x || 0
      const mouseDeltaY = input.mouseDelta?.y || 0

      const sensitivity = 0.002
      ctl.targetYaw += mouseDeltaX * sensitivity
      ctl.targetPitch -= mouseDeltaY * sensitivity
      ctl.targetPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, ctl.targetPitch))

      const now = Date.now()
      const dt = Math.min(0.033, (now - ctl.lastFrameTime) / 1000)
      ctl.lastFrameTime = now

      const pitchDiff = ctl.targetPitch - ctl.pitchVel
      ctl.pitchVel += pitchDiff * ctl.springStiffness * dt
      ctl.pitchVel *= (1 - ctl.dampingPitch)

      const yawDiff = ctl.targetYaw - ctl.yawVel
      ctl.yawVel += yawDiff * ctl.springStiffness * dt
      ctl.yawVel *= (1 - ctl.dampingYaw)

      const worldUp = [0, 1, 0]
      const forward = [
        Math.sin(ctl.yawVel) * Math.cos(ctl.pitchVel),
        Math.sin(ctl.pitchVel),
        Math.cos(ctl.yawVel) * Math.cos(ctl.pitchVel)
      ]
      const right = engine.THREE.MathUtils.normalize3(
        engine.THREE.MathUtils.cross3(forward, worldUp)
      )
      const actualUp = engine.THREE.MathUtils.cross3(right, forward)

      if (ctl.cameraMode === 'fps') {
        const eyeHeight = player.custom._charCtl.height - 0.15
        const eyePos = [
          player.state?.position?.[0] || 0,
          (player.state?.position?.[1] || 0) + eyeHeight,
          player.state?.position?.[2] || 0
        ]
        const targetPos = [
          eyePos[0] + forward[0],
          eyePos[1] + forward[1],
          eyePos[2] + forward[2]
        ]
        engine.cam?.setPosition?.(eyePos)
        engine.cam?.lookAt?.(targetPos)
      } else {
        const distance = 2.0
        const height = 1.0
        const playerPos = player.state?.position || [0, 0, 0]
        const camPos = [
          playerPos[0] - forward[0] * distance,
          playerPos[1] + height,
          playerPos[2] - forward[2] * distance
        ]
        engine.cam?.setPosition?.(camPos)
        engine.cam?.lookAt?.([playerPos[0], playerPos[1] + 0.5, playerPos[2]])
      }
    },

    onEvent(payload, engine) {
      if (payload?.type === 'player:jump') {
        if (engine.audio) {
          const freq = 800 + Math.random() * 200
          engine.audio.playTone?.(freq, 0.08, 0.15)
        }
      }
      if (payload?.type === 'player:footstep') {
        if (engine.audio) {
          const freq = 400 + Math.random() * 100
          engine.audio.playTone?.(freq, 0.05, 0.08)
        }
      }
    }
  }
}
