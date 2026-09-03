// defineTeams(spec, appCtx) -> a server-authoritative team-membership + shared-scoreboard primitive.
// The single most-reimplemented game-mode mechanic: CTF / TDM / KotH / domination / payload / relay /
// prop-hunt all need "which team is this player on" + "what is each team's score" + "push the scoreboard
// to every client for its HUD". This wraps that once. Pure server state + a broadcast; nothing here
// touches physics. The caller decides when to assignPlayer / addScore and reads getTeam / getScores.
//
// spec = {
//   teams: string[] | { id, label?, color? }[],   // required, >= 1 team. Bare string => id===label.
//   autoBalance?: boolean,                          // assignPlayer(pid) with no team picks the smallest (default true)
//   scoreLimit?: number,                            // if set, onWin fires when a team reaches it
//   onAssign?(ctx, { playerId, team }),             // fired when a player joins/switches a team
//   onScore?(ctx, { team, score, delta }),          // fired after addScore
//   onWin?(ctx, { team, score }),                   // fired once a team hits scoreLimit
//   broadcast?: boolean,                            // auto-broadcast the scoreboard on every change (default true)
//   channel?: string,                               // client message type for the scoreboard (default 'scoreboard')
//   colorblindSafe?: boolean,                        // when true, any team missing an explicit `color` gets
//                                                     // assigned from COLORBLIND_SAFE_PALETTE (by declaration
//                                                     // order) instead of being left null; see below.
// }
// Returns {
//   assignPlayer(pid, team?), removePlayer(pid), getTeam(pid), getMembers(team),
//   addScore(team, delta=1), setScore(team, n), getScore(team), getScores(), getTeams(),
//   smallestTeam(), leader(), reset(), broadcast(), teamOf === getTeam
// }

import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'

// Colorblind-safe team palette (Okabe-Ito, widely cited as distinguishable under deuteranopia,
// protanopia, and tritanopia -- unlike a naive red/green split, which is the single most common
// team-color mistake and is indistinguishable for the ~8% of men with red-green color deficiency).
// Ordered so the first two entries (blue/orange) already cover the common 2-team case safely.
export const COLORBLIND_SAFE_PALETTE = [
  0x0072B2, // blue
  0xE69F00, // orange
  0x009E73, // bluish green
  0xCC79A7, // reddish purple
  0xF0E442, // yellow
  0x56B4E9, // sky blue
  0xD55E00, // vermillion
  0x000000, // black
]

// buildTeamsSchema(teamIds) -> the declarative replicated-field schema for a per-player teamId (see
// apps/_lib/ComponentSchema.js). Unlike health.js's HEALTH_SCHEMA (a fixed shape known at module load),
// a teams schema depends on the actual declared team ids for THIS instance -- the wire-cheapest
// encoding of "which team" is a 1-byte enum index into the instance's own team list, not a string, so
// the schema must be built per-instance from spec.teams (same normalization defineTeams itself does:
// bare-string entries become their own id). Call this with the SAME spec.teams array passed to
// defineTeams to get a schema whose enum matches the instance the caller is about to replicate. A
// caller mirrors one player's team into e.g. entity.custom.playerTeam = { teamId: teams.getTeam(pid) }.
// registerAs: optional name to also register the built schema under (ComponentSchema.js's registry),
// since -- unlike health/inventory's fixed module-level schema -- a teams schema's enum is per-instance
// and has no single static name to register at module load; the caller registers it once it knows its
// concrete team list (e.g. right after defineTeams(spec, ctx), buildTeamsSchema(spec.teams, 'teams')).
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

  // Normalize to a stable ordered list of {id,label,color}. A duplicate id is a spec error, not a silent merge.
  // colorblindSafe: a team without an explicit `color` gets the next COLORBLIND_SAFE_PALETTE entry (by
  // declaration order) instead of null, so a caller that never set per-team colors still gets a safe
  // default palette rather than silently falling back to an app-chosen (possibly red/green) scheme.
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
  const _members = new Map()          // playerId -> teamId
  const _won = new Set()              // teamIds that already fired onWin (fire-once)
  const doBroadcast = spec.broadcast !== false
  const channel = spec.channel || 'scoreboard'

  const _has = (team) => _ids.has(String(team))
  const _fire = (name, arg) => { const fn = spec[name]; if (typeof fn === 'function') { try { fn(appCtx, arg) } catch (e) { appCtx.debug?.warn?.('[teams] ' + name + ' threw: ' + e.message) } } }

  const teams = {
    // Assign (or switch) a player. With no team + autoBalance (default), picks the smallest team.
    assignPlayer(playerId, team) {
      const pid = String(playerId)
      let tid = team != null ? String(team) : null
      if (tid == null) {
        if (spec.autoBalance === false) throw new TypeError('[teams] assignPlayer needs a team when autoBalance is off')
        tid = teams.smallestTeam()
      }
      if (!_has(tid)) throw new TypeError('[teams] unknown team: ' + tid)
      _members.set(pid, tid)
      _fire('onAssign', { playerId: pid, team: tid })
      if (doBroadcast) teams.broadcast()
      return tid
    },
    removePlayer(playerId) {
      const changed = _members.delete(String(playerId))
      if (changed && doBroadcast) teams.broadcast()
      return changed
    },
    getTeam(playerId) { return _members.get(String(playerId)) ?? null },
    getMembers(team) {
      const tid = String(team)
      const out = []
      for (const [pid, t] of _members) if (t === tid) out.push(pid)
      return out
    },
    // Add to a team's score (delta may be negative). Fires onScore, and onWin once at scoreLimit.
    addScore(team, delta = 1) {
      const tid = String(team)
      if (!_has(tid)) throw new TypeError('[teams] unknown team: ' + tid)
      if (!(typeof delta === 'number' && Number.isFinite(delta))) return _scores.get(tid)
      const next = (_scores.get(tid) || 0) + delta
      _scores.set(tid, next)
      _fire('onScore', { team: tid, score: next, delta })
      if (spec.scoreLimit != null && next >= spec.scoreLimit && !_won.has(tid)) { _won.add(tid); _fire('onWin', { team: tid, score: next }) }
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
    // Full scoreboard snapshot: [{ id, label, color, score, members }], ordered by declaration.
    getScores() {
      return _teams.map(t => ({ id: t.id, label: t.label, color: t.color, score: _scores.get(t.id) || 0, members: teams.getMembers(t.id) }))
    },
    getTeams() { return _teams.map(t => ({ ...t })) },
    smallestTeam() {
      let best = _teams[0].id, bestN = Infinity
      for (const t of _teams) { const n = teams.getMembers(t.id).length; if (n < bestN) { bestN = n; best = t.id } }
      return best
    },
    // Highest score, or null on a tie (so a caller can distinguish a clear leader from a draw).
    leader() {
      const s = teams.getScores()
      let top = null, topScore = -Infinity, tie = false
      for (const t of s) { if (t.score > topScore) { topScore = t.score; top = t.id; tie = false } else if (t.score === topScore) tie = true }
      return tie ? null : top
    },
    reset() {
      for (const t of _teams) _scores.set(t.id, 0)
      _won.clear()
      if (doBroadcast) teams.broadcast()
    },
    // Push the scoreboard to every client (their app onEvent gets { type: channel, scores }).
    broadcast() {
      appCtx.players?.broadcast?.({ type: channel, scores: teams.getScores() })
    },
  }
  teams.teamOf = teams.getTeam
  return teams
}

export default defineTeams
