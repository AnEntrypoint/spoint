import { buildLiveIndex } from '../../src/netcode/RewindSpatialIndex.js'
import { recordHit } from '../../src/netcode/OutlierDetector.js'

// Scoreboard persistence: cumulative per-player kills/deaths/damage survive a disconnect/reconnect
// AND a full server restart, on top of the existing in-memory ctx.state.playerStats (keyed by the
// ephemeral numeric playerId, reset every connection). Durable storage is keyed by player NAME --
// PlayerManager.js's own `.name` field is documented there as the intended save-game key (server-
// authoritative, client-proposed at join, defaults 'Player <id>') since this codebase has no
// account/auth system to key by instead. Policy: last-write-wins-by-name (a name collision between
// two concurrently-connected players is accepted as a v1 tradeoff, same as any name-keyed save file).
// Uses ctx.storage (src/apps/AppContext.js), the existing generic namespaced FSAdapter-backed
// key/value store apps already have -- writes to data/tps-game_scoreboard.json (FSAdapter._path
// sanitizes the "<appName>/<key>" namespaced key into a single filename, replacing '/' with '_',
// so this does NOT create a data/tps-game/ subdirectory), not a bespoke second persistence
// closure -- same atomic temp-file+rename write FSAdapter.set already does.
const SCOREBOARD_KEY = 'scoreboard'
const SCOREBOARD_PERSIST_DEBOUNCE_MS = 500

// Loads the durable by-name scoreboard into ctx.state.scoreboardByName (plain object: name -> {kills,deaths,damage}).
// Called once from setup(ctx), awaited before any player can join, so a rejoining player's stats are
// available the instant player_join looks them up.
export async function loadScoreboard(ctx) {
  let byName = null
  try { byName = await ctx.storage?.get(SCOREBOARD_KEY) } catch (e) { console.error('[scoreboard] load error:', e.message) }
  ctx.state.scoreboardByName = (byName && typeof byName === 'object') ? byName : {}
  ctx.state._scoreboardPersistTimer = null
  console.log(`[scoreboard] loaded ${Object.keys(ctx.state.scoreboardByName).length} saved player record(s)`)
}

// Debounced (trailing, 500ms) persist -- mirrors the exact ctx.placedModelStorage.persist pattern
// (src/sdk/server.js) so a burst of kills in the same fight collapses into one write of the latest
// state, not one write per kill. ctx.storage.set is already atomic (FSAdapter: temp-file + rename).
function scheduleScoreboardPersist(ctx) {
  if (ctx.state._scoreboardPersistTimer) clearTimeout(ctx.state._scoreboardPersistTimer)
  ctx.state._scoreboardPersistTimer = setTimeout(() => {
    ctx.state._scoreboardPersistTimer = null
    ctx.storage?.set(SCOREBOARD_KEY, ctx.state.scoreboardByName).catch(e => console.error('[scoreboard] persist error:', e.message))
  }, SCOREBOARD_PERSIST_DEBOUNCE_MS)
}

// Forces the pending debounced write (if any) to happen immediately -- used on graceful shutdown so
// the last burst of stat changes before exit isn't lost waiting on a timer that never fires. Mirrors
// ctx.placedModelStorage.flush().
export async function flushScoreboard(ctx) {
  if (ctx.state._scoreboardPersistTimer) { clearTimeout(ctx.state._scoreboardPersistTimer); ctx.state._scoreboardPersistTimer = null }
  if (ctx.state.scoreboardByName) { try { await ctx.storage?.set(SCOREBOARD_KEY, ctx.state.scoreboardByName) } catch (e) { console.error('[scoreboard] persist error:', e.message) } }
}

// Mirrors a live ctx.state.playerStats entry (kills/deaths/damage, keyed by ephemeral playerId) into
// the durable by-name store and schedules a persist. Called at every mutation site alongside the
// existing playerStats.set() -- never replaces the in-memory Map, only shadows it durably.
export function persistPlayerStat(ctx, playerId) {
  const stat = ctx.state.playerStats.get(playerId)
  if (!stat) return
  const player = ctx.players.getById(playerId)
  const name = player?.name || `Player ${playerId}`
  ctx.state.scoreboardByName[name] = { kills: stat.kills, deaths: stat.deaths, damage: stat.damage }
  scheduleScoreboardPersist(ctx)
}

export function findSpawnPoints(ctx) {
  const valid = []
  // exclude terrain from the raycast so it validates only arena geometry, not surrounding hills
  const excludeTerrain = ctx.terrainBodyId
  // ground = max(arena raycast, planet terrain height) + margin -- else a spawn can land under terrain when it's higher than the arena there
  const SPAWN_MARGIN = 3
  const terrainY = (x, z) => (typeof ctx.terrainHeightAt === 'function' ? ctx.terrainHeightAt(x, z) : -Infinity)
  for (let x = -850; x <= 1050; x += 180) {
    for (let z = -80; z <= 960; z += 160) {
      const hit = ctx.raycast([x, 20, z], [0, -1, 0], 30, excludeTerrain)
      const arenaY = (hit.hit && hit.position[1] > -3) ? hit.position[1] : -Infinity
      const tY = terrainY(x, z)
      const groundY = Math.max(arenaY, Number.isFinite(tY) ? tY : -Infinity)
      if (Number.isFinite(groundY)) valid.push([x, groundY + SPAWN_MARGIN, z])
    }
  }
  if (valid.length < 4) { const ty = terrainY(0, 0); const y0 = (Number.isFinite(ty) ? ty : 3) + 5; valid.push([0, y0, 0], [100, y0, 200], [-100, y0, -100], [200, y0, 500]) }
  return valid
}

export function getAvailableSpawnPoint(ctx, spawnPoints) {
  const MIN_SAFE_DISTANCE = 25
  const activePlayers = ctx.players.getAll().filter(p => p.state && !ctx.state.respawning.has(p.id))
  const candidates = activePlayers.length === 0 ? spawnPoints : (() => {
    const scored = spawnPoints.map(sp => {
      let minDist = Infinity
      for (const player of activePlayers) {
        const dist = Math.hypot(sp[0] - player.state.position[0], sp[2] - player.state.position[2])
        if (dist < minDist) minDist = dist
      }
      return { sp, minDist }
    })
    const safe = scored.filter(s => s.minDist >= MIN_SAFE_DISTANCE)
    if (safe.length > 0) return safe.map(s => s.sp)
    scored.sort((a, b) => b.minDist - a.minDist)
    return scored.map(s => s.sp)
  })()
  for (const sp of [...candidates, [0, 15, 0]]) {
    const hit = ctx.raycast([sp[0], sp[1] + 10, sp[2]], [0, -1, 0], 15)
    if (hit.hit && hit.position[1] > -3) return [sp[0], hit.position[1] + 2, sp[2]]
  }
  return candidates[0] || [0, 15, 0]
}

// Resolves each candidate target's rewound hitbox position (rewind + forward-extrapolation), same
// math as the original inline loop. Shared by both the linear scan and the spatial-accelerated path
// so their hit-test geometry is provably identical -- only the CANDIDATE SET each considers differs.
export function resolveTargetPoint(target, lagComp, latencyMs) {
  const rewound = latencyMs > 0 && lagComp ? lagComp.getPlayerStateAtTime(target.id, latencyMs) : null
  // must skip (not fall back to current position) if lagged shooter has no rewind history -- else awards a phantom hit
  if (latencyMs > 0 && lagComp && !rewound) return null
  let tp = rewound ? rewound.position : target.state.position
  if (rewound && rewound.velocity) {
    // forward-extrapolate the stale rewound sample, capped at 0.5m displacement so a bad velocity can't teleport the hitbox
    const ahead = Math.min(0.05, (latencyMs * 0.5) / 1000)
    let ex0 = rewound.velocity[0] * ahead, ex1 = rewound.velocity[1] * ahead, ex2 = rewound.velocity[2] * ahead
    const exMag = Math.hypot(ex0, ex1, ex2)
    if (exMag > 0.5) { const k = 0.5 / exMag; ex0 *= k; ex1 *= k; ex2 *= k }
    tp = [tp[0] + ex0, tp[1] + ex1, tp[2] + ex2]
  }
  return { tp, rewound }
}

export function rayVsCapsule(origin, direction, range, tp) {
  const toTarget = [tp[0] - origin[0], tp[1] + 0.9 - origin[1], tp[2] - origin[2]]
  const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
  if (dot < 0 || dot > range) return null
  const proj = [origin[0] + direction[0] * dot, origin[1] + direction[1] * dot, origin[2] + direction[2] * dot]
  const ddx = proj[0] - tp[0], ddy = proj[1] - (tp[1] + 0.9), ddz = proj[2] - tp[2]
  const d2 = ddx * ddx + ddy * ddy + ddz * ddz
  if (d2 > 0.36) return null
  return { proj, dot }
}

// Linear O(n) baseline: every eligible target's rewound capsule is ray-tested unconditionally,
// first hit in ctx.players.getAll() array order wins (matches the original inline loop exactly).
export function findHitLinear(ctx, players, shooterId, origin, direction, latencyMs, range) {
  const lagComp = ctx.lagCompensator
  for (const target of players) {
    if (!target.state || target.id === shooterId) continue
    if (ctx.state.respawning.has(target.id)) continue
    if ((ctx.state.invuln?.get(target.id) ?? 0) > Date.now()) continue
    if ((target.state.health ?? ctx.state.config.health) <= 0) continue
    const resolved = resolveTargetPoint(target, lagComp, latencyMs)
    if (!resolved) continue
    const hit = rayVsCapsule(origin, direction, range, resolved.tp)
    if (!hit) continue
    return { target, tp: resolved.tp, rewound: resolved.rewound, proj: hit.proj }
  }
  return null
}

// Spatial-accelerated path: a BROAD-PHASE prune against a grid of LIVE positions (built once per
// tick via buildLiveIndex and reused across every shot fired that tick -- no per-shot rebuild),
// walking only the cells the ray's DDA touches, so most far-away targets are rejected before ever
// paying a rewind lookup. Only prune survivors get the real exact-phase: rewind resolution +
// capsule ray test, identical math to the linear baseline. Falls back to array order among
// surviving candidates so ties resolve identically to the linear baseline (first eligible target
// in ctx.players.getAll() order, restricted to the pruned set).
export function findHitSpatial(ctx, players, shooterId, origin, direction, latencyMs, range, liveIndex) {
  const lagComp = ctx.lagCompensator
  const index = liveIndex || buildLiveIndex(players)
  // Collect candidates with their ORIGINAL players-array index so the array-order tie-break can be
  // reproduced by a sort, instead of re-scanning the full `players` array (which would put an O(n)
  // step right back on the hot path and erase the whole point of pruning).
  const candidates = [] // [{ id, arrayIndex }]
  const seen = new Set()
  index.queryRay(origin, direction, range, (entry) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    const arrayIndex = index.arrayIndexOf ? index.arrayIndexOf(entry.id) : -1
    candidates.push({ id: entry.id, arrayIndex })
  })
  candidates.sort((a, b) => a.arrayIndex - b.arrayIndex)
  const byId = index.playersById || (() => { const m = new Map(); for (const p of players) m.set(p.id, p); return m })()
  for (const c of candidates) {
    const target = byId.get(c.id)
    if (!target) continue
    if (target.id === shooterId) continue
    if (!target.state) continue
    if (ctx.state.respawning.has(target.id)) continue
    if ((ctx.state.invuln?.get(target.id) ?? 0) > Date.now()) continue
    if ((target.state.health ?? ctx.state.config.health) <= 0) continue
    const resolved = resolveTargetPoint(target, lagComp, latencyMs)
    if (!resolved) continue
    const hit = rayVsCapsule(origin, direction, range, resolved.tp)
    if (!hit) continue
    return { target, tp: resolved.tp, rewound: resolved.rewound, proj: hit.proj }
  }
  return null
}

export function handleFire(ctx, msg) {
  const { shooterId, origin, direction, latencyMs } = msg
  if (!origin || !direction) return
  const players = ctx.players.getAll()
  const range = 1000
  const buff = ctx.state.buffs.get(shooterId)
  const damage = Math.round(ctx.state.config.damagePerHit * (buff ? buff.damage : 1))
  let _playerHit = false
  // Reuse one broad-phase live-position index across every shot fired within the same tick
  // (multiple players can fire between ticks advancing) instead of rebuilding it per shot --
  // the index is cheap but not free, and a busy server can see many handleFire calls per tick.
  // latencyMs is a real NTP-derived one-way client->server delay estimate (see ClockSync.js /
  // BaseClient.sendFire), not the old raw-clock-skew-conflated Date.now()-clientTime value --
  // exactly the "how long ago did the shot leave the client" figure the rewind needs.
  const tick = ctx.tick ?? ctx.state.tick
  if (!ctx.state._rewindIndexTick || ctx.state._rewindIndexTick !== tick || !ctx.state._rewindIndex) {
    ctx.state._rewindIndex = buildLiveIndex(players)
    ctx.state._rewindIndexTick = tick
  }
  const found = findHitSpatial(ctx, players, shooterId, origin, direction, latencyMs, range, ctx.state._rewindIndex)
  if (found) {
    const { target, tp, rewound, proj } = found
    const hitRatio = (proj[1] - tp[1]) / 1.8
    const isHeadshot = hitRatio >= ctx.state.config.headshotZone
    const finalDamage = isHeadshot ? Math.round(damage * ctx.state.config.headshotMultiplier) : damage
    const hp = target.state.health ?? ctx.state.config.health
    const newHp = Math.max(0, hp - finalDamage)
    target.state.health = newHp
    // Audit-trail record for this resolved hit test -- durable evidence a disputed kill/hit can be replayed
    // against: exactly which position the lag-rewind used (or live position if latencyMs<=0/no rewind history),
    // the hitbox math that decided it (capsule radius^2 threshold, headshot ratio), and the raw inputs the
    // shooter's client sent. Written through the real EventLog (record() auto-stamps id/timestamp/tick).
    ctx.eventLog?.record('hit_registered', {
      attackerId: shooterId,
      targetId: target.id,
      damage: finalDamage,
      headshot: isHeadshot,
      lethal: newHp <= 0,
      resultHealth: newHp,
      rewound: !!rewound,
      latencyMs,
      hitPosition: proj,
      targetPosition: tp,
      hitbox: { radiusSq: 0.36, heightOffset: 0.9, headshotRatio: ctx.state.config.headshotZone, hitRatio },
      shotOrigin: origin,
      shotDirection: direction
    }, { actor: shooterId, sourceEntity: target.id, reason: 'weapon_fire' })
    // Statistical outlier flags (anticheat-server-envelope-checks): non-blocking, operator-review-only
    // -- see OutlierDetector.js's header for exactly what each flag kind measures and why. Fed from the
    // SAME resolved-hit data hit_registered above already captures, so this is purely additive analysis
    // over data already flowing, not a new trust boundary.
    recordHit(ctx.eventLog, shooterId, { headshot: isHeadshot, timestampMs: Date.now(), targetId: target.id })
    target.state.velocity[0] += direction[0] * ctx.state.config.hitKnockback
    target.state.velocity[2] += direction[2] * ctx.state.config.hitKnockback
    ctx.players.send(target.id, { type: 'aimpunch', intensity: isHeadshot ? 0.8 : 0.6 })
    // knockback rides the payload so the victim's client can predict the shove immediately instead of waiting for a velocity snap
    ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage: finalDamage, health: newHp, headshot: isHeadshot, pos: proj, dir: direction, knockback: ctx.state.config.hitKnockback })
    if (newHp <= 0) {
      const ss = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      ss.kills++; ss.damage += finalDamage; ctx.state.playerStats.set(shooterId, ss)
      const ts = ctx.state.playerStats.get(target.id) || { kills: 0, deaths: 0, damage: 0 }
      ts.deaths++; ctx.state.playerStats.set(target.id, ts)
      persistPlayerStat(ctx, shooterId); persistPlayerStat(ctx, target.id)
      ctx.state.respawning.set(target.id, { respawnAt: Date.now() + ctx.state.config.respawnTime * 1000, killer: shooterId })
      // streak derived from server timestamps (not client arrival order) so it survives reordering under loss
      const nowK = Date.now(), ksMap = ctx.state.killStreaks
      const prevKs = ksMap?.get(shooterId)
      const streak = (prevKs && nowK - prevKs.at < 3000) ? prevKs.streak + 1 : 1
      ksMap?.set(shooterId, { streak, at: nowK })
      const killerPlayer = ctx.players.getById(shooterId)
      const killerName = killerPlayer?.name || 'Player'
      ctx.network.broadcast({ type: 'death', victim: target.id, killer: shooterId, killerName, headshot: isHeadshot, streak, killerKills: ss.kills })
    } else {
      const ss = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      ss.damage += finalDamage; ctx.state.playerStats.set(shooterId, ss)
      persistPlayerStat(ctx, shooterId)
    }
    _playerHit = true
  }
  // No player was hit -- raycast world geometry so a miss still gets a bullet-hole/scorch decal
  // (roadmap #48). Reuses the same ctx.raycast primitive findSpawnPoints/getAvailableSpawnPoint above
  // already depend on; excludeBodyId is omitted since the shooter's own character body sits behind the
  // muzzle origin along `direction`, not in front of it, so self-hits are not a real concern here.
  if (!_playerHit) {
    const r = ctx.raycast(origin, direction, range, null)
    if (r && r.hit && r.position) {
      // Attributed hit against a non-player entity (a combat-bot, or any future entity that opts into
      // onMessage damage) -- route via the addressed cross-entity message, not a broadcast, since only
      // that one entity's app cares. Bots are the first real consumer; harmless no-op against anything
      // else's onMessage (or an entity with no onMessage hook at all).
      if (r.entityId != null) {
        ctx.world.sendToEntity(r.entityId, { type: 'damage', amount: damage, shooterId })
      }
      ctx.network.broadcast({ type: 'world_hit', shooter: shooterId, pos: r.position, normal: r.normal || null })
    }
  }
}
