const MATCH = {
  minPlayers: 2,
  countdownMs: 5000,
  roundMs: 60000,
  intermissionMs: 4000,
  roundsPerMatch: 3
}

// Migrated to apps/_lib/gamemode.js's ctx.defineGameMode -- was a hand-rolled ctx.defineGameFSM spec
// (buildMatchFSM, see git history), now the extracted lobby/warmup/rounds/end skeleton. phaseNames maps
// the canonical 5 internal states back onto fsm-arena's original waiting/countdown/active/roundEnd/done
// names, and `messages` reproduces the exact original wire contract byte-for-byte (unprefixed
// round_start/round_end/countdown, a match_over payload that still carries the free-form `kills` bag in
// fsm.context.kills) so this migration is behavior-preserving, not just interface-preserving.
function buildMatchFSM(ctx) {
  const gm = ctx.defineGameMode({
    id: 'match',
    channel: 'match',
    minPlayers: MATCH.minPlayers,
    countdownMs: MATCH.countdownMs,
    roundMs: MATCH.roundMs,
    intermissionMs: MATCH.intermissionMs,
    roundsPerMatch: MATCH.roundsPerMatch,
    scoring: 'none', // fsm-arena tracks kills itself via fsm.context.kills, not gamemode.addScore
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
    // Client-side app state lives namespaced on the shared engineCtx (engine._<appName>), matching
    // every other app's own client.setup (see apps/tps-game/index.js's engine._tps, apps/deathrun's
    // engine._deathrun) -- engineCtx has no generic `.state` bucket (client/app.js's engineCtx object
    // literal carries scene/camera/client/players/etc, never a `state` property), so the previous
    // `ctx.state.phase = 'waiting'` threw "Cannot set properties of undefined" on every load, silently
    // aborting client.setup before the emote/round-phase wiring ran. Dormant until this session's
    // arena-fps scaffold template (scaffold-game-mode-templates) placed fsm-arena in a real world-def
    // for the first time -- no existing world-def references this app, so the bug never fired before.
    setup(engine) { engine._fsmArena = { phase: 'waiting' } },
    onEvent(payload, engine) {
      if (payload?.type === 'match_phase' && engine?._fsmArena) engine._fsmArena.phase = payload.phase
    }
  }
}
