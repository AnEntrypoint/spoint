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

  const teams = spec.teams ? appCtx.defineTeams(spec.teams) : null

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
