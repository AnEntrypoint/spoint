import { buildLiveIndex } from '../../src/netcode/RewindSpatialIndex.js'
import { recordHit } from '../../src/netcode/OutlierDetector.js'
import { spawnSurfaceY } from '../../src/shared/SpawnSurface.js'

const SCOREBOARD_KEY = 'scoreboard'
const SCOREBOARD_PERSIST_DEBOUNCE_MS = 500
const HITBOX_CENTER_HEIGHT = 0.9
const HITBOX_RADIUS_SQ = 0.36
const HITBOX_HEIGHT = 1.8
const FALL_DEPTH_BELOW_GROUND_M = 20
const FALL_FLOOR_WITHOUT_TERRAIN_Y = -20

export function fallFloorY(ctx, x, z) {
  const groundY = typeof ctx.terrainHeightAt === 'function' ? ctx.terrainHeightAt(x, z) : null
  return Number.isFinite(groundY) ? groundY - FALL_DEPTH_BELOW_GROUND_M : FALL_FLOOR_WITHOUT_TERRAIN_Y
}

export async function loadScoreboard(ctx) {
  let byName = null
  try { byName = await ctx.storage?.get(SCOREBOARD_KEY) } catch (e) { console.error('[scoreboard] load error:', e.message) }
  ctx.state.scoreboardByName = (byName && typeof byName === 'object') ? byName : {}
  ctx.state._scoreboardPersistTimer = null
  console.log(`[scoreboard] loaded ${Object.keys(ctx.state.scoreboardByName).length} saved player record(s)`)
}

function scheduleScoreboardPersist(ctx) {
  if (ctx.state._scoreboardPersistTimer) clearTimeout(ctx.state._scoreboardPersistTimer)
  ctx.state._scoreboardPersistTimer = setTimeout(() => {
    ctx.state._scoreboardPersistTimer = null
    ctx.storage?.set(SCOREBOARD_KEY, ctx.state.scoreboardByName).catch(e => console.error('[scoreboard] persist error:', e.message))
  }, SCOREBOARD_PERSIST_DEBOUNCE_MS)
}

export async function flushScoreboard(ctx) {
  if (ctx.state._scoreboardPersistTimer) { clearTimeout(ctx.state._scoreboardPersistTimer); ctx.state._scoreboardPersistTimer = null }
  if (ctx.state.scoreboardByName) { try { await ctx.storage?.set(SCOREBOARD_KEY, ctx.state.scoreboardByName) } catch (e) { console.error('[scoreboard] persist error:', e.message) } }
}

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
  const excludeTerrain = ctx.terrainBodyId
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

const SPAWN_GROUND_CLEARANCE = 2

function groundSnapCandidate(ctx, sp) {
  const liveTerrainY = typeof ctx.terrainHeightAt === 'function' ? ctx.terrainHeightAt(sp[0], sp[2]) : null
  const surfaceY = spawnSurfaceY((o, d, l) => ctx.raycast(o, d, l), sp, {
    standingOffset: HITBOX_CENTER_HEIGHT,
    headroom: SPAWN_GROUND_CLEARANCE + HITBOX_HEIGHT,
    terrainY: liveTerrainY,
  })
  if (surfaceY !== null) return [sp[0], surfaceY + SPAWN_GROUND_CLEARANCE, sp[2]]
  if (Number.isFinite(liveTerrainY)) return [sp[0], liveTerrainY + SPAWN_GROUND_CLEARANCE, sp[2]]
  return null
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
    const snapped = groundSnapCandidate(ctx, sp)
    if (snapped) return snapped
  }
  return candidates[0] || [0, 15, 0]
}

export function normalizeShotDirection(d) {
  if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return null
  const m = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]))
  if (!(m > 0)) return null
  const x = d[0] / m, y = d[1] / m, z = d[2] / m, len = Math.hypot(x, y, z)
  return [x / len, y / len, z / len]
}

export function resolveFireRequest(lagComp, shooterId, shooterPosition, msg) {
  const eye = [shooterPosition[0], shooterPosition[1] + HITBOX_CENTER_HEIGHT, shooterPosition[2]]
  if (!lagComp) return { origin: eye, viewTick: null }
  const origin = lagComp.validateShotOrigin(shooterPosition, msg.origin, HITBOX_CENTER_HEIGHT)
  const viewTick = lagComp.acceptRewind(shooterId) ? lagComp.resolveViewTick(msg.viewTick) : null
  return { origin, viewTick }
}

export function resolveTargetPoint(target, lagComp, viewTick) {
  const rewound = viewTick != null && lagComp ? lagComp.rewindAtTick(target.id, viewTick) : null
  return { tp: rewound ? [...rewound.position] : target.state.position, rewound }
}

export function rayVsCapsule(origin, direction, range, tp) {
  const toTarget = [tp[0] - origin[0], tp[1] + HITBOX_CENTER_HEIGHT - origin[1], tp[2] - origin[2]]
  const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
  if (dot < 0 || dot > range) return null
  const proj = [origin[0] + direction[0] * dot, origin[1] + direction[1] * dot, origin[2] + direction[2] * dot]
  const ddx = proj[0] - tp[0], ddy = proj[1] - (tp[1] + HITBOX_CENTER_HEIGHT), ddz = proj[2] - tp[2]
  const d2 = ddx * ddx + ddy * ddy + ddz * ddz
  if (d2 > HITBOX_RADIUS_SQ) return null
  return { proj, dot }
}

export function findHitLinear(ctx, players, shooterId, origin, direction, viewTick, range) {
  const lagComp = ctx.lagCompensator
  for (const target of players) {
    if (!target.state || target.id === shooterId) continue
    if (ctx.state.respawning.has(target.id)) continue
    if ((ctx.state.invuln?.get(target.id) ?? 0) > Date.now()) continue
    if ((target.state.health ?? ctx.state.config.health) <= 0) continue
    const resolved = resolveTargetPoint(target, lagComp, viewTick)
    const hit = rayVsCapsule(origin, direction, range, resolved.tp)
    if (!hit) continue
    return { target, tp: resolved.tp, rewound: resolved.rewound, proj: hit.proj }
  }
  return null
}

export function findHitSpatial(ctx, players, shooterId, origin, direction, viewTick, range, liveIndex) {
  const lagComp = ctx.lagCompensator
  const index = liveIndex || buildLiveIndex(players)
  const candidates = []
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
    const resolved = resolveTargetPoint(target, lagComp, viewTick)
    const hit = rayVsCapsule(origin, direction, range, resolved.tp)
    if (!hit) continue
    return { target, tp: resolved.tp, rewound: resolved.rewound, proj: hit.proj }
  }
  return null
}

export function handleFire(ctx, msg) {
  const { shooterId, origin, direction, viewTick } = msg
  if (!origin || !direction) return
  const players = ctx.players.getAll()
  const range = 1000
  const buff = ctx.state.buffs.get(shooterId)
  const damage = Math.round(ctx.state.config.damagePerHit * (buff ? buff.damage : 1))
  let _playerHit = false
  const tick = ctx.tick ?? ctx.state.tick
  if (!ctx.state._rewindIndexTick || ctx.state._rewindIndexTick !== tick || !ctx.state._rewindIndex) {
    ctx.state._rewindIndex = buildLiveIndex(players)
    ctx.state._rewindIndexTick = tick
  }
  const found = findHitSpatial(ctx, players, shooterId, origin, direction, viewTick, range, ctx.state._rewindIndex)
  if (found) {
    const { target, tp, rewound, proj } = found
    const hitRatio = (proj[1] - tp[1]) / HITBOX_HEIGHT
    const isHeadshot = hitRatio >= ctx.state.config.headshotZone
    const finalDamage = isHeadshot ? Math.round(damage * ctx.state.config.headshotMultiplier) : damage
    const hp = target.state.health ?? ctx.state.config.health
    const newHp = Math.max(0, hp - finalDamage)
    target.state.health = newHp
    ctx.eventLog?.record('hit_registered', {
      attackerId: shooterId,
      targetId: target.id,
      damage: finalDamage,
      headshot: isHeadshot,
      lethal: newHp <= 0,
      resultHealth: newHp,
      rewound: !!rewound,
      viewTick,
      rewoundTicks: viewTick != null && ctx.lagCompensator ? ctx.lagCompensator.latestTick - viewTick : 0,
      hitPosition: proj,
      targetPosition: tp,
      hitbox: { radiusSq: HITBOX_RADIUS_SQ, heightOffset: HITBOX_CENTER_HEIGHT, headshotRatio: ctx.state.config.headshotZone, hitRatio },
      shotOrigin: origin,
      shotDirection: direction
    }, { actor: shooterId, sourceEntity: target.id, reason: 'weapon_fire' })
    recordHit(ctx.eventLog, shooterId, { headshot: isHeadshot, timestampMs: Date.now(), targetId: target.id })
    target.state.velocity[0] += direction[0] * ctx.state.config.hitKnockback
    target.state.velocity[2] += direction[2] * ctx.state.config.hitKnockback
    ctx.players.send(target.id, { type: 'aimpunch', intensity: isHeadshot ? 0.8 : 0.6 })
    ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage: finalDamage, health: newHp, headshot: isHeadshot, pos: proj, dir: direction, knockback: ctx.state.config.hitKnockback })
    if (newHp <= 0) {
      const ss = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      ss.kills++; ss.damage += finalDamage; ctx.state.playerStats.set(shooterId, ss)
      const ts = ctx.state.playerStats.get(target.id) || { kills: 0, deaths: 0, damage: 0 }
      ts.deaths++; ctx.state.playerStats.set(target.id, ts)
      persistPlayerStat(ctx, shooterId); persistPlayerStat(ctx, target.id)
      ctx.state.respawning.set(target.id, { respawnAt: Date.now() + ctx.state.config.respawnTime * 1000, killer: shooterId })
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
  if (!_playerHit) {
    const r = ctx.raycast(origin, direction, range, null)
    if (r && r.hit && r.position) {
      if (r.entityId != null) {
        ctx.world.sendToEntity(r.entityId, { type: 'damage', amount: damage, shooterId })
      }
      ctx.network.broadcast({ type: 'world_hit', shooter: shooterId, pos: r.position, normal: r.normal || null })
    }
  }
}
