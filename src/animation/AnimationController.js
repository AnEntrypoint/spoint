import { defineGameFSM } from '../../apps/_lib/game-fsm.js'

export function createAnimationController(blender, options = {}) {
  const config = {
    idleClip: 'Idle',
    walkClip: 'WalkLoop',
    runClip: 'RunLoop',
    sprintClip: 'SprintLoop',
    jumpClip: 'JumpStart',
    fallClip: 'Fall',
    landClip: 'Land',
    attackClip: 'Attack',
    dieClip: 'Die',
    walkSpeed: 1.5,
    runSpeed: 5,
    sprintSpeed: 10,
    jumpForce: 10,
    fallThreshold: -2,
    ...options,
  }

  const spec = {
    id: 'animation-controller',
    initial: 'idle',
    context: {
      speed: 0,
      direction: new Float32Array([0, 0, 1]),
      isGrounded: true,
      verticalVelocity: 0,
      blendParameter: 0,
      moveBlendX: 0,
      moveBlendY: 0,
    },
    states: {
      idle: {
        enter(appCtx, fsm) {
          blender.playClip(config.idleClip, 0.3)
        },
        tick(appCtx, dt, fsm) {
          const speed = fsm.context.speed
          if (speed > config.runSpeed) {
            fsm.send('RUN')
          } else if (speed > config.walkSpeed) {
            fsm.send('WALK')
          }
          if (!fsm.context.isGrounded) {
            fsm.send('JUMP')
          }
        },
        on: {
          WALK: 'walk',
          RUN: 'run',
          SPRINT: 'sprint',
          JUMP: 'jump',
          ATTACK: 'attack',
          DIE: 'die',
        },
      },
      walk: {
        enter(appCtx, fsm) {
          blender.playClip(config.walkClip, 0.3)
        },
        tick(appCtx, dt, fsm) {
          const speed = fsm.context.speed
          if (speed < 0.1) {
            fsm.send('IDLE')
          } else if (speed > config.runSpeed) {
            fsm.send('RUN')
          }
          if (!fsm.context.isGrounded) {
            fsm.send('JUMP')
          }
        },
        on: {
          IDLE: 'idle',
          RUN: 'run',
          SPRINT: 'sprint',
          JUMP: 'jump',
          ATTACK: 'attack',
          DIE: 'die',
        },
      },
      run: {
        enter(appCtx, fsm) {
          blender.playClip(config.runClip, 0.3)
        },
        tick(appCtx, dt, fsm) {
          const speed = fsm.context.speed
          if (speed < config.walkSpeed) {
            fsm.send('IDLE')
          } else if (speed < config.runSpeed) {
            fsm.send('WALK')
          } else if (speed > config.sprintSpeed) {
            fsm.send('SPRINT')
          }
          if (!fsm.context.isGrounded) {
            fsm.send('JUMP')
          }
        },
        on: {
          IDLE: 'idle',
          WALK: 'walk',
          SPRINT: 'sprint',
          JUMP: 'jump',
          ATTACK: 'attack',
          DIE: 'die',
        },
      },
      sprint: {
        enter(appCtx, fsm) {
          blender.playClip(config.sprintClip, 0.2)
        },
        tick(appCtx, dt, fsm) {
          const speed = fsm.context.speed
          if (speed < config.runSpeed) {
            fsm.send('RUN')
          }
          if (!fsm.context.isGrounded) {
            fsm.send('JUMP')
          }
        },
        on: {
          RUN: 'run',
          IDLE: 'idle',
          JUMP: 'jump',
          ATTACK: 'attack',
          DIE: 'die',
        },
      },
      jump: {
        enter(appCtx, fsm) {
          blender.playClip(config.jumpClip, 0.1)
        },
        tick(appCtx, dt, fsm) {
          if (fsm.context.isGrounded && fsm.context.verticalVelocity <= 0) {
            fsm.send('LAND')
          }
        },
        on: {
          LAND: 'land',
          DIE: 'die',
        },
      },
      land: {
        enter(appCtx, fsm) {
          blender.playClip(config.landClip, 0.15)
        },
        after: {
          500: {
            target: 'idle',
            guard(appCtx, fsm) {
              return fsm.context.speed < 0.5
            },
          },
          500: {
            target: 'walk',
            guard(appCtx, fsm) {
              return fsm.context.speed >= 0.5 && fsm.context.speed <= config.runSpeed
            },
          },
          500: {
            target: 'run',
            guard(appCtx, fsm) {
              return fsm.context.speed > config.runSpeed
            },
          },
        },
        on: {
          IDLE: 'idle',
          WALK: 'walk',
          RUN: 'run',
        },
      },
      attack: {
        enter(appCtx, fsm) {
          blender.playClip(config.attackClip, 0.1)
        },
        tick(appCtx, dt, fsm) {
          const clipDuration = blender.getClipDuration(config.attackClip)
          if (fsm.timeInState > clipDuration) {
            fsm.send('ATTACK_END')
          }
        },
        on: {
          ATTACK_END: {
            target: 'idle',
            guard(appCtx, fsm) {
              return fsm.context.speed < 0.5
            },
          },
          ATTACK_END: {
            target: 'walk',
            guard(appCtx, fsm) {
              return fsm.context.speed >= 0.5 && fsm.context.speed <= config.runSpeed
            },
          },
          ATTACK_END: {
            target: 'run',
            guard(appCtx, fsm) {
              return fsm.context.speed > config.runSpeed
            },
          },
          DIE: 'die',
        },
      },
      die: {
        enter(appCtx, fsm) {
          blender.playClip(config.dieClip, 0.3)
        },
        type: 'final',
      },
    },
  }

  const fsm = defineGameFSM(spec, {})

  return {
    fsm,
    blender,
    config,

    update(dt, motionState = {}) {
      const { speed = 0, direction = [0, 0, 1], isGrounded = true, verticalVelocity = 0 } = motionState

      fsm.context.speed = speed
      if (Array.isArray(direction)) {
        fsm.context.direction[0] = direction[0]
        fsm.context.direction[1] = direction[1]
        fsm.context.direction[2] = direction[2]
      }
      fsm.context.isGrounded = isGrounded
      fsm.context.verticalVelocity = verticalVelocity

      fsm.tick(dt)
      blender.updateBlend(dt)
    },

    setState(state) {
      if (state === 'idle') fsm.send('IDLE')
      else if (state === 'walk') fsm.send('WALK')
      else if (state === 'run') fsm.send('RUN')
      else if (state === 'sprint') fsm.send('SPRINT')
      else if (state === 'jump') fsm.send('JUMP')
      else if (state === 'attack') fsm.send('ATTACK')
      else if (state === 'die') fsm.send('DIE')
      return this
    },

    getState() {
      return fsm.state
    },

    onStateChange(callback) {
      return fsm.onTransition((state) => {
        callback(state)
      })
    },

    dispose() {
      fsm.stop()
      blender.stop()
    },
  }
}

export default createAnimationController
