// defineGameMode(spec, appCtx) -> the extracted, reusable "match loop" shape shared by every
// lobby -> warmup -> rounds -> end game today. This is a THIN composition over the two primitives
// that already carry the real logic (never a reimplementation of either):
//   - apps/_lib/game-fsm.js's defineGameFSM(spec, appCtx): the phase machine itself (xstate5), reused
//     verbatim -- defineGameMode builds a game-fsm `states` object internally with the exact same
//     enter/exit/tick/on/after per-state shape, same guard/action normalization, same dual-import
//     server+client (defineGameFSM does the actual `await import('xstate' | '.../xstate.esm.js')`).
//   - apps/_lib/teams.js's defineTeams(spec, appCtx): team assignment + scoreboard + broadcast + onWin,
//     reused verbatim when spec.teams is present.
//
// Extracted from the real common shape already present in this repo (not invented speculatively):
// apps/fsm-arena/index.js's buildMatchFSM is a 5-state game-fsm spec (waiting/countdown/active/
// roundEnd/done) that broadcasts a phase-change message on every enter() and tracks a per-match round
// counter + a free-form scoring bag (fsm.context.kills) in its xstate context, with a roundsPerMatch
// win-condition checked as an `after` guard on the roundEnd->done edge. defineGameMode generalizes
// exactly that shape into 4 canonical phases (lobby/warmup/rounds/end -- fsm-arena's waiting/countdown/
// active/done under different names) plus a repeating rounds<->roundEnd sub-loop, driven entirely by
// game-fsm underneath. apps/_lib/shrinking-zone.js was read and confirmed to have NO phase-FSM/lobby/
// rounds shape of its own (a pure BR-ring damage/push tick() primitive, never uses defineGameFSM) --
// nothing to extract from it for this interface.
//
// spec = {
//   id?: string,                    // forwarded to defineGameFSM's machine id (default 'game-mode')
//   teams?: object,                 // forwarded verbatim to ctx.defineTeams(spec.teams) when present;
//                                    // the resulting teams object is exposed as gamemode.teams
//   minPlayers?: number,            // players required for lobby -> warmup (default 2)
//   countdownMs?: number,           // warmup phase duration before rounds start (default 5000)
//   roundMs?: number,               // max duration of a single round before it force-ends (default 60000)
//   intermissionMs?: number,        // pause between rounds, also gates the roundEnd -> end/rounds fork (default 4000)
//   roundsPerMatch?: number,        // rounds.roundEnd -> end once fsm.context.round reaches this (default 3)
//   winCondition?: (ctx, fsm) => boolean,  // checked at roundEnd; true => transition to 'end' instead of
//                                    // looping back to 'rounds'. Default: fsm.context.round >= roundsPerMatch.
//   scoring?: 'teams' | 'players' | 'none', // which addScore(id, delta) target the id resolves against
//                                    // (default: 'teams' when spec.teams is set, else 'players')
//
//   // --- wire-message customization (defaults reproduce a plain generic contract; a migration off a
//   // hand-rolled FSM that must keep its exact existing message types/phase names passes these) ---
//   phaseNames?: { lobby?, warmup?, rounds?, roundEnd?, end? },  // override the 5 internal xstate state
//                                    // names (also the default `phase` string broadcast on entry).
//                                    // Each may collide with another as long as game-fsm's own
//                                    // uniqueness validation (distinct declared state names) still
//                                    // passes -- i.e. all 5 must resolve to distinct final names.
//   channel?: string,               // message-type prefix used by the DEFAULT (unoverridden) message
//                                    // builders below (default 'match'): `${channel}_phase`,
//                                    // `${channel}_round_start`, `${channel}_round_end`, `${channel}_over`.
//                                    // `countdown` itself is never prefixed (matches fsm-arena precedent).
//   messages?: {                    // fully override any of the 5 broadcast payloads/types; each fn
//                                    // receives (ctx, fsm) [or (ctx, fsm, seconds) for countdown] and
//                                    // returns the object passed to ctx.network.broadcast, or null/
//                                    // undefined to suppress that broadcast entirely.
//     lobby?(ctx, fsm), warmup?(ctx, fsm), countdown?(ctx, fsm, seconds),
//     roundStart?(ctx, fsm), roundEnd?(ctx, fsm), end?(ctx, fsm, scores),
//   },
//
//   // Per-phase override hooks -- each receives (ctx, fsm) like any game-fsm hook, and (ctx, dt, fsm)
//   // for tick. These compose with (run alongside, not instead of) the canonical broadcast/counter
//   // logic above -- called AFTER the built-in broadcast on enter, so a caller can rely on
//   // fsm.context.round/gamemode.getScores() already being current.
//   onLobbyEnter?, onLobbyTick?,
//   onWarmupEnter?, onWarmupTick?,
//   onRoundStart?, onRoundTick?, onRoundEnd?,
//   onEnd?,
// }
// Returns a gamemode runtime: the underlying game-fsm `runtime` object (state/context/is/send/tick/...),
// PLUS:
//   gamemode.teams               -- the defineTeams instance, or null when spec.teams was not set
//   gamemode.addScore(id, delta=1)  -- routes to teams.addScore when scoring==='teams', else a plain
//                                      per-id Map (gamemode.getScore(id) / gamemode.getScores())
//   gamemode.getScore(id)
//   gamemode.getScores()         -- teams.getScores() shape when team-scored, else [{id,score}] array
//   gamemode.round               -- current round number (fsm.context.round)
export function defineGameMode(spec = {}, appCtx = null) {
  if (!appCtx) throw new TypeError('[gamemode] appCtx is required')
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[gamemode] spec must be an object')
  if (spec.winCondition != null && typeof spec.winCondition !== 'function') throw new TypeError('[gamemode] winCondition must be a function')
  if (spec.scoring != null && !['teams', 'players', 'none'].includes(spec.scoring)) throw new TypeError('[gamemode] scoring must be "teams", "players", or "none"')
  if (spec.phaseNames != null && (typeof spec.phaseNames !== 'object' || Array.isArray(spec.phaseNames))) throw new TypeError('[gamemode] phaseNames must be an object')
  if (spec.messages != null && (typeof spec.messages !== 'object' || Array.isArray(spec.messages))) throw new TypeError('[gamemode] messages must be an object')

  const minPlayers = spec.minPlayers ?? 2
  const countdownMs = spec.countdownMs ?? 5000
  const roundMs = spec.roundMs ?? 60000
  const intermissionMs = spec.intermissionMs ?? 4000
  const roundsPerMatch = spec.roundsPerMatch ?? 3
  const channel = spec.channel || 'match'
  const winCondition = typeof spec.winCondition === 'function' ? spec.winCondition : (ctx, fsm) => fsm.context.round >= roundsPerMatch
  const scoringMode = spec.scoring ?? (spec.teams ? 'teams' : 'players')

  const N = {
    lobby: spec.phaseNames?.lobby || 'lobby',
    warmup: spec.phaseNames?.warmup || 'warmup',
    rounds: spec.phaseNames?.rounds || 'rounds',
    roundEnd: spec.phaseNames?.roundEnd || 'roundEnd',
    end: spec.phaseNames?.end || 'end'
  }
  {
    const seen = new Set(Object.values(N))
    if (seen.size !== 5) throw new TypeError('[gamemode] phaseNames must resolve to 5 distinct state names')
  }

  const M = spec.messages || {}
  const _defaultLobbyMsg = () => ({ type: channel + '_phase', phase: N.lobby })
  const _defaultWarmupMsg = () => ({ type: channel + '_phase', phase: N.warmup, ms: countdownMs })
  const _defaultCountdownMsg = (ctx, fsm, seconds) => ({ type: 'countdown', seconds })
  const _defaultRoundStartMsg = (ctx, fsm) => ({ type: channel + '_round_start', round: fsm.context.round })
  const _defaultRoundEndMsg = (ctx, fsm) => ({ type: channel + '_round_end', round: fsm.context.round })
  const _defaultEndMsg = (ctx, fsm, scores) => ({ type: channel + '_over', rounds: fsm.context.round, scores })

  function _broadcast(ctx, builder, fallback, ...extra) {
    const fn = typeof builder === 'function' ? builder : fallback
    const msg = fn(ctx, fsmRef, ...extra)
    if (msg) ctx.network?.broadcast?.(msg)
  }

  // Team assignment (apps/_lib/teams.js), reused verbatim -- built before the FSM so phase hooks can
  // reference it via the closure below.
  const teams = spec.teams ? appCtx.defineTeams(spec.teams) : null

  // Plain per-player-id scoreboard, used only when scoringMode === 'players' (no teams instance to
  // delegate to). Mirrors fsm-arena's own fsm.context.kills bag shape but generalized with
  // addScore/getScore/getScores accessors instead of hand-rolled mutation.
  const _playerScores = new Map()

  function _callHook(fn, ctx, fsm) { if (typeof fn === 'function') fn(ctx, fsm) }
  function _callTick(fn, ctx, dt, fsm) { if (typeof fn === 'function') fn(ctx, dt, fsm) }

  let fsmRef = null

  const fsm = appCtx.defineGameFSM({
    id: spec.id || 'game-mode',
    initial: N.lobby,
    context: { round: 0 },
    states: {
      [N.lobby]: {
        enter: (ctx, fsm) => {
          _broadcast(ctx, M.lobby, _defaultLobbyMsg)
          _callHook(spec.onLobbyEnter, ctx, fsm)
        },
        tick: (ctx, dt, fsm) => _callTick(spec.onLobbyTick, ctx, dt, fsm),
        on: {
          START: { target: N.warmup, guard: (ctx) => (ctx.players?.getAll?.().length || 0) >= minPlayers }
        }
      },
      [N.warmup]: {
        enter: (ctx, fsm) => {
          fsm.context.lastSecond = -1
          _broadcast(ctx, M.warmup, _defaultWarmupMsg)
          _callHook(spec.onWarmupEnter, ctx, fsm)
        },
        tick: (ctx, dt, fsm) => {
          const remain = Math.ceil((countdownMs - fsm.timeInState) / 1000)
          if (remain !== fsm.context.lastSecond) {
            fsm.context.lastSecond = remain
            _broadcast(ctx, M.countdown, _defaultCountdownMsg, Math.max(0, remain))
          }
          _callTick(spec.onWarmupTick, ctx, dt, fsm)
        },
        after: { [countdownMs]: N.rounds }
      },
      [N.rounds]: {
        enter: (ctx, fsm) => {
          fsm.context.round++
          _broadcast(ctx, M.roundStart, _defaultRoundStartMsg)
          _callHook(spec.onRoundStart, ctx, fsm)
        },
        tick: (ctx, dt, fsm) => _callTick(spec.onRoundTick, ctx, dt, fsm),
        on: { ROUND_OVER: N.roundEnd },
        after: { [roundMs]: N.roundEnd }
      },
      [N.roundEnd]: {
        enter: (ctx, fsm) => {
          _broadcast(ctx, M.roundEnd, _defaultRoundEndMsg)
          _callHook(spec.onRoundEnd, ctx, fsm)
        },
        after: {
          [intermissionMs]: [
            { target: N.end, guard: (ctx, fsm) => winCondition(ctx, fsm) },
            { target: N.rounds }
          ]
        }
      },
      [N.end]: {
        final: true,
        enter: (ctx, fsm) => {
          _broadcast(ctx, M.end, _defaultEndMsg, gamemode.getScores())
          _callHook(spec.onEnd, ctx, fsm)
        }
      }
    }
  })

  fsmRef = fsm
  const gamemode = fsm
  gamemode.teams = teams

  gamemode.addScore = (id, delta = 1) => {
    if (scoringMode === 'none') return 0
    if (scoringMode === 'teams') {
      if (!teams) throw new TypeError('[gamemode] addScore in "teams" scoring mode requires spec.teams')
      return teams.addScore(id, delta)
    }
    const key = String(id)
    const next = (_playerScores.get(key) || 0) + (typeof delta === 'number' && Number.isFinite(delta) ? delta : 0)
    _playerScores.set(key, next)
    return next
  }
  gamemode.getScore = (id) => {
    if (scoringMode === 'teams') return teams ? teams.getScore(id) : 0
    if (scoringMode === 'none') return 0
    return _playerScores.get(String(id)) ?? 0
  }
  gamemode.getScores = () => {
    if (scoringMode === 'teams') return teams ? teams.getScores() : []
    if (scoringMode === 'none') return []
    return [..._playerScores.entries()].map(([id, score]) => ({ id, score }))
  }
  Object.defineProperty(gamemode, 'round', { get: () => fsm.context.round })

  return gamemode
}

export default defineGameMode
