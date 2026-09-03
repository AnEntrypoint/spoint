export default {
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
              ctx.debug?.log?.(`FSM: round ${fsm.context.round} active`)
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
      ctx.debug?.log?.(`FSM state: ${ctx.state.fsm?.state}`)
    },

    onMessage(ctx, msg) {
      if (msg?.type === 'player_join') {
        ctx.debug?.log?.('Player joined, attempting to start FSM')
        ctx.state.fsm?.send?.('START')
      }
      ctx.debug?.log?.('TODO: Handle other FSM transitions (e.g., ROUND_OVER, RESTART)')
    },

    teardown(ctx) {
      ctx.debug?.log?.(`FSM game ended at round ${ctx.state.fsm?.context?.round}`)
    }
  },

  client: {
    setup(engine) {
      const appName = 'fsmGame'
      engine[`_${appName}`] = { phase: 'waiting', round: 0 }
    },

    onEvent(payload, engine) {
      const app = engine._fsmGame
      if (!app || !payload) return

      if (payload.type === 'match_phase' || payload.phase) {
        app.phase = payload.phase ?? payload.type
        engine.client?.debug?.log?.(`Client FSM phase: ${app.phase}`)
      }
      if (payload.round !== undefined) {
        app.round = payload.round
      }
    }
  }
}