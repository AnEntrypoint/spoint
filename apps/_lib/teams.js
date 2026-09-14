import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'

export const COLORBLIND_SAFE_PALETTE = [
  0x0072B2,
  0xE69F00,
  0x009E73,
  0xCC79A7,
  0xF0E442,
  0x56B4E9,
  0xD55E00,
  0x000000,
]

export function buildTeamsSchema(teamIds, registerAs) {
  const ids = (Array.isArray(teamIds) ? teamIds : []).map(t => (t && typeof t === 'object') ? String(t.id) : String(t))
  const schema = defineComponentSchema({ teamId: { type: 'enum', enum: ids, tier: 'full' } })
  if (registerAs) registerComponentSchema(registerAs, schema)
  return schema
}

export function defineTeams(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[teams] appCtx is required')
  const rawTeams = Array.isArray(spec.teams) ? spec.teams : null
  if (!rawTeams || rawTeams.length === 0) throw new TypeError('[teams] spec.teams must be a non-empty array')
  if (spec.scoreLimit != null && (typeof spec.scoreLimit !== 'number' || !Number.isFinite(spec.scoreLimit) || spec.scoreLimit <= 0)) {
    throw new TypeError('[teams] scoreLimit must be a positive finite number')
  }

  const _teams = []
  const _ids = new Set()
  let _paletteIdx = 0
  for (const t of rawTeams) {
    const def = (t && typeof t === 'object') ? t : { id: String(t) }
    const id = String(def.id)
    if (!id) throw new TypeError('[teams] every team needs a non-empty id')
    if (_ids.has(id)) throw new TypeError('[teams] duplicate team id: ' + id)
    _ids.add(id)
    let color = def.color ?? null
    if (color == null && spec.colorblindSafe) {
      color = COLORBLIND_SAFE_PALETTE[_paletteIdx % COLORBLIND_SAFE_PALETTE.length]
      _paletteIdx++
    }
    _teams.push({ id, label: def.label != null ? String(def.label) : id, color })
  }

  const _scores = new Map(_teams.map(t => [t.id, 0]))
  const _teamIdByPlayer = new Map()
  const _teamsThatFiredWin = new Set()
  const doBroadcast = spec.broadcast !== false
  const channel = spec.channel || 'scoreboard'

  const _has = (team) => _ids.has(String(team))
  const _fire = (name, arg) => { const fn = spec[name]; if (typeof fn === 'function') { try { fn(appCtx, arg) } catch (e) { appCtx.debug?.warn?.('[teams] ' + name + ' threw: ' + e.message) } } }

  const teams = {
    assignPlayer(playerId, team) {
      const pid = String(playerId)
      let tid = team != null ? String(team) : null
      if (tid == null) {
        if (spec.autoBalance === false) throw new TypeError('[teams] assignPlayer needs a team when autoBalance is off')
        tid = teams.smallestTeam()
      }
      if (!_has(tid)) throw new TypeError('[teams] unknown team: ' + tid)
      _teamIdByPlayer.set(pid, tid)
      _fire('onAssign', { playerId: pid, team: tid })
      if (doBroadcast) teams.broadcast()
      return tid
    },
    removePlayer(playerId) {
      const changed = _teamIdByPlayer.delete(String(playerId))
      if (changed && doBroadcast) teams.broadcast()
      return changed
    },
    getTeam(playerId) { return _teamIdByPlayer.get(String(playerId)) ?? null },
    getMembers(team) {
      const tid = String(team)
      const out = []
      for (const [pid, t] of _teamIdByPlayer) if (t === tid) out.push(pid)
      return out
    },
    addScore(team, delta = 1) {
      const tid = String(team)
      if (!_has(tid)) throw new TypeError('[teams] unknown team: ' + tid)
      if (!(typeof delta === 'number' && Number.isFinite(delta))) return _scores.get(tid)
      const next = (_scores.get(tid) || 0) + delta
      _scores.set(tid, next)
      _fire('onScore', { team: tid, score: next, delta })
      if (spec.scoreLimit != null && next >= spec.scoreLimit && !_teamsThatFiredWin.has(tid)) { _teamsThatFiredWin.add(tid); _fire('onWin', { team: tid, score: next }) }
      if (doBroadcast) teams.broadcast()
      return next
    },
    setScore(team, n) {
      const tid = String(team)
      if (!_has(tid)) throw new TypeError('[teams] unknown team: ' + tid)
      _scores.set(tid, (typeof n === 'number' && Number.isFinite(n)) ? n : 0)
      if (doBroadcast) teams.broadcast()
      return _scores.get(tid)
    },
    getScore(team) { return _scores.get(String(team)) ?? 0 },
    getScores() {
      return _teams.map(t => ({ id: t.id, label: t.label, color: t.color, score: _scores.get(t.id) || 0, members: teams.getMembers(t.id) }))
    },
    getTeams() { return _teams.map(t => ({ ...t })) },
    smallestTeam() {
      let best = _teams[0].id, bestN = Infinity
      for (const t of _teams) { const n = teams.getMembers(t.id).length; if (n < bestN) { bestN = n; best = t.id } }
      return best
    },
    leader() {
      const s = teams.getScores()
      let top = null, topScore = -Infinity, tie = false
      for (const t of s) { if (t.score > topScore) { topScore = t.score; top = t.id; tie = false } else if (t.score === topScore) tie = true }
      return tie ? null : top
    },
    reset() {
      for (const t of _teams) _scores.set(t.id, 0)
      _teamsThatFiredWin.clear()
      if (doBroadcast) teams.broadcast()
    },
    broadcast() {
      appCtx.players?.broadcast?.({ type: channel, scores: teams.getScores() })
    },
  }
  teams.teamOf = teams.getTeam
  return teams
}

export default defineTeams
