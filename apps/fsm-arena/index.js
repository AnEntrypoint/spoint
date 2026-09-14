const MATCH = {
  minPlayers: 2,
  countdownMs: 5000,
  roundMs: 60000,
  intermissionMs: 4000,
  roundsPerMatch: 3
}

function buildMatchFSM(ctx) {
  const gm = ctx.defineGameMode({
    id: 'match',
    channel: 'match',
    minPlayers: MATCH.minPlayers,
    countdownMs: MATCH.countdownMs,
    roundMs: MATCH.roundMs,
    intermissionMs: MATCH.intermissionMs,
    roundsPerMatch: MATCH.roundsPerMatch,
    scoring: 'none',
    phaseNames: { lobby: 'waiting', warmup: 'countdown', rounds: 'active', roundEnd: 'roundEnd', end: 'done' },
    messages: {
      lobby: () => ({ type: 'match_phase', phase: 'waiting' }),
      warmup: () => ({ type: 'match_phase', phase: 'countdown', ms: MATCH.countdownMs }),
      countdown: (ctx, fsm, seconds) => ({ type: 'countdown', seconds }),
      roundStart: (ctx, fsm) => ({ type: 'round_start', round: fsm.context.round }),
      roundEnd: (ctx, fsm) => ({ type: 'round_end', round: fsm.context.round }),
      end: (ctx, fsm) => ({ type: 'match_over', rounds: fsm.context.round, kills: fsm.context.kills })
    }
  })
  gm.context.kills = {}
  return gm
}

export default {
  server: {
    setup(ctx) {
      ctx.state.match = buildMatchFSM(ctx)
      ctx.debug?.log?.('[fsm-arena] match FSM in state ' + ctx.state.match.state)
    },
    update(ctx, dt) {
      ctx.state.match?.tick(dt)
    },
    onMessage(ctx, msg) {
      const m = ctx.state.match
      if (!m || !msg) return
      if (msg.type === 'player_join') m.send('START')
      if (msg.type === 'force_round_over') m.send('ROUND_OVER')
    }
  },
  client: {
    setup(engine) { engine._fsmArena = { phase: 'waiting' } },
    onEvent(payload, engine) {
      if (payload?.type === 'match_phase' && engine?._fsmArena) engine._fsmArena.phase = payload.phase
    }
  }
}
