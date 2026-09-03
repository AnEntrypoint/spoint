export function getTemplateContent(templateType) {
  const templates = {
    simple: `export default {
  description: 'A simple static entity with basic setup.',
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0x00ff00,
        sx: 1,
        sy: 1,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.5, 0.5, 0.5] })
    },

    update(ctx, dt) {
      ctx.debug?.log?.('TODO: Add your update logic here')
    },

    teardown(ctx) {
      ctx.debug?.log?.('TODO: Cleanup resources if needed')
    }
  },

  client: {
    setup(engine) {
      this.data = { rotation: 0 }
    },

    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`,

    physics: `export default {
  description: 'A dynamic physics body with collision handling.',
  server: {
    editorProps: [
      { key: 'mass', label: 'Mass (kg)', type: 'number', default: 10 },
      { key: 'color', label: 'Color', type: 'color', default: '#ff8800' }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        mesh: 'box',
        color: c.color ?? '#ff8800',
        sx: 1,
        sy: 1,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({
        type: 'box',
        size: [0.5, 0.5, 0.5],
        mass: c.mass ?? 10,
        dynamic: true
      })
      ctx.state.velocity = [0, 0, 0]
      ctx.state.collisions = 0
    },

    update(ctx, dt) {
      ctx.state.velocity = ctx.entity.linearVelocity || [0, 0, 0]
      ctx.debug?.log?.(\`TODO: Implement collision responses or custom physics behavior. Current velocity: \${JSON.stringify(ctx.state.velocity)}\`)
    },

    onCollide(ctx, other, manifold) {
      ctx.state.collisions++
      ctx.debug?.log?.(\`Collision with \${other.id}: total collisions = \${ctx.state.collisions}\`)
    },

    teardown(ctx) {
      ctx.debug?.log?.(\`Entity destroyed after \${ctx.state.collisions} collisions\`)
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`,

    interactive: `export default {
  description: 'An entity that players can interact with using the E key.',
  server: {
    editorProps: [
      { key: 'prompt', label: 'Interaction prompt', type: 'text', default: 'Press E' },
      { key: 'radius', label: 'Interact radius', type: 'range', min: 0.5, max: 10, step: 0.5, default: 3 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        mesh: 'box',
        color: '#00ff88',
        sx: 1,
        sy: 0.5,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.5, 0.25, 0.5] })
      ctx.interactable?.({ prompt: c.prompt ?? 'Press E', radius: c.radius ?? 3 })
      ctx.state.interactionCount = 0
      ctx.state.lastInteractors = new Map()
      ctx.onConfigChange?.((cfg) => {
        ctx.interactable?.({ prompt: cfg.prompt ?? 'Press E', radius: cfg.radius ?? 3 })
      })
    },

    update(ctx, dt) {
      ctx.debug?.log?.(\`TODO: Add timed interactions or distance-based logic. Interactions so far: \${ctx.state.interactionCount}\`)
    },

    onInteract(ctx, player) {
      ctx.state.interactionCount++
      ctx.state.lastInteractors.set(player.id, Date.now())
      ctx.debug?.log?.(\`Player \${player.id} interacted. Total: \${ctx.state.interactionCount}\`)
      ctx.bus?.emit?.('interact.triggered', { entity: ctx.entity.id, player: player.id })
    },

    teardown(ctx) {
      ctx.state.lastInteractors?.clear?.()
    }
  },

  client: {
    setup(engine) {
      this.data = { canInteract: false, lastPrompt: null }
    },

    render(ctx) {
      const custom = { ...ctx.entity.custom }
      if (this.data.canInteract) {
        custom.glow = true
        custom.glowColor = 0x00ff88
      }
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom
      }
    }
  }
}`,

    spawner: `export default {
  description: 'Spawns and despawns entities on a timer.',
  server: {
    editorProps: [
      { key: 'spawnInterval', label: 'Spawn interval (sec)', type: 'number', default: 5 },
      { key: 'maxEntities', label: 'Max entities', type: 'number', default: 10 },
      { key: 'entityApp', label: 'Entity app to spawn', type: 'text', default: 'box-dynamic' }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.state.entities = new Set()
      ctx.state.nextId = 0
      ctx.state.spawnCount = 0

      ctx.entity.custom = {
        mesh: 'box',
        color: '#4488ff',
        sx: 1.5,
        sy: 1.5,
        sz: 1.5
      }

      const interval = (c.spawnInterval ?? 5) * 1000
      const maxEntities = c.maxEntities ?? 10
      const entityApp = c.entityApp ?? 'box-dynamic'

      ctx.time?.every?.(interval / 1000, () => {
        if (ctx.state.entities.size >= maxEntities) return

        const id = \`spawned_\${ctx.state.nextId++}\`
        const offset = 3
        const pos = [
          ctx.entity.position[0] + (Math.random() - 0.5) * offset * 2,
          ctx.entity.position[1] + offset,
          ctx.entity.position[2] + (Math.random() - 0.5) * offset * 2
        ]

        ctx.world?.spawn?.(id, { position: pos, app: entityApp })
        ctx.state.entities.add(id)
        ctx.state.spawnCount++
        ctx.debug?.log?.(\`Spawned \${id} (total: \${ctx.state.spawnCount})\`)
      })
    },

    update(ctx, dt) {
      ctx.debug?.log?.(\`Active entities: \${ctx.state.entities.size}; Spawned: \${ctx.state.spawnCount}\`)
    },

    onMessage(ctx, msg) {
      if (msg.type === 'entity_destroyed' && ctx.state.entities.has(msg.entityId)) {
        ctx.state.entities.delete(msg.entityId)
        ctx.debug?.log?.(\`Entity \${msg.entityId} despawned\`)
      }
    },

    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world?.destroy?.(id))
      ctx.state.entities.clear()
      ctx.debug?.log?.(\`Spawner destroyed; cleaned up \${ctx.state.spawnCount} spawned entities\`)
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}`,

    'fsm-game': `export default {
  description: 'A game state machine with phases: waiting, countdown, active, roundEnd, done.',
  server: {
    setup(ctx) {
      ctx.state.fsm = ctx.defineGameFSM?.({
        id: 'game',
        initial: 'waiting',
        context: { round: 0, players: 0 },
        states: {
          waiting: {
            on: {
              START: {
                target: 'countdown',
                guard: (ctx) => (ctx.players?.getAll?.()?.length || 0) >= 1
              }
            },
            entry: () => ctx.debug?.log?.('FSM: waiting for players')
          },
          countdown: {
            after: { 5000: 'active' },
            entry: () => ctx.debug?.log?.('FSM: countdown starting')
          },
          active: {
            entry: (ctx, fsm) => {
              fsm.context.round++
              ctx.debug?.log?.(\`FSM: round \${fsm.context.round} active\`)
            },
            after: { 60000: 'roundEnd' }
          },
          roundEnd: {
            after: {
              4000: [
                { target: 'done', guard: (ctx, fsm) => fsm.context.round >= 3 },
                { target: 'active' }
              ]
            },
            entry: () => ctx.debug?.log?.('FSM: round ended')
          },
          done: {
            type: 'final',
            entry: () => ctx.debug?.log?.('FSM: game complete')
          }
        }
      })

      ctx.state.maxRounds = 3
      ctx.state.roundDurationMs = 60000
    },

    update(ctx, dt) {
      ctx.state.fsm?.tick?.(dt)
      ctx.debug?.log?.(\`FSM state: \${ctx.state.fsm?.state}\`)
    },

    onMessage(ctx, msg) {
      if (msg?.type === 'player_join') {
        ctx.debug?.log?.('Player joined, attempting to start FSM')
        ctx.state.fsm?.send?.('START')
      }
      ctx.debug?.log?.('TODO: Handle other FSM transitions (e.g., ROUND_OVER, RESTART)')
    },

    teardown(ctx) {
      ctx.debug?.log?.(\`FSM game ended at round \${ctx.state.fsm?.context?.round}\`)
    }
  },

  client: {
    setup(engine) {
      const appName = 'fsmGame'
      engine[\`_\${appName}\`] = { phase: 'waiting', round: 0 }
    },

    onEvent(payload, engine) {
      const app = engine._fsmGame
      if (!app || !payload) return

      if (payload.type === 'match_phase' || payload.phase) {
        app.phase = payload.phase ?? payload.type
        engine.client?.debug?.log?.(\`Client FSM phase: \${app.phase}\`)
      }
      if (payload.round !== undefined) {
        app.round = payload.round
      }
    }
  }
}`
  }

  return templates[templateType] || templates.simple
}
