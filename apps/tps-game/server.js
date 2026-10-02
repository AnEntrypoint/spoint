const SCOREBOARD_KEY = 'scoreboard'
const RANGE_M = 1000

export const scoreboard = ctx => ctx.persisted(SCOREBOARD_KEY, {})

export async function loadScoreboard(ctx) {
  await scoreboard(ctx).ready
  console.log(`[scoreboard] loaded ${Object.keys(scoreboard(ctx).value).length} saved player record(s)`)
}

export function persistPlayerStat(ctx, playerId) {
  const stat = ctx.state.playerStats.get(playerId)
  if (!stat) return
  const name = ctx.players.getById(playerId)?.name || `Player ${playerId}`
  scoreboard(ctx).value[name] = { kills: stat.kills, deaths: stat.deaths, damage: stat.damage }
  scoreboard(ctx).save()
}

export function findSpawnPoints(ctx) {
  const valid = []
  const SPAWN_MARGIN = 3
  for (let x = -850; x <= 1050; x += 180) {
    for (let z = -80; z <= 960; z += 160) {
      const hit = ctx.raycast([x, 20, z], [0, -1, 0], 30, ctx.terrainBodyId)
      const arenaY = (hit.hit && hit.position[1] > -3) ? hit.position[1] : -Infinity
      const tY = ctx.terrainHeightAt(x, z)
      const groundY = Math.max(arenaY, Number.isFinite(tY) ? tY : -Infinity)
      if (Number.isFinite(groundY)) valid.push([x, groundY + SPAWN_MARGIN, z])
    }
  }
  if (valid.length < 4) { const ty = ctx.terrainHeightAt(0, 0); const y0 = (Number.isFinite(ty) ? ty : 3) + 5; valid.push([0, y0, 0], [100, y0, 200], [-100, y0, -100], [200, y0, 500]) }
  return valid
}

export function isTargetable(ctx, target) {
  if (ctx.state.respawning.has(target.id)) return false
  if ((ctx.state.invuln?.get(target.id) ?? 0) > Date.now()) return false
  return (target.state.health ?? ctx.state.config.health) > 0
}

function addStat(ctx, id, delta) {
  const s = ctx.state.playerStats.get(id) || { kills: 0, deaths: 0, damage: 0 }
  s.kills += delta.kills || 0; s.deaths += delta.deaths || 0; s.damage += delta.damage || 0
  ctx.state.playerStats.set(id, s)
  persistPlayerStat(ctx, id)
  return s
}

function onKill(ctx, shooterId, target, damage, isHeadshot) {
  const ss = addStat(ctx, shooterId, { kills: 1, damage })
  addStat(ctx, target.id, { deaths: 1 })
  ctx.state.respawning.set(target.id, { respawnAt: Date.now() + ctx.state.config.respawnTime * 1000, killer: shooterId })
  const now = Date.now(), prev = ctx.state.killStreaks.get(shooterId)
  const streak = (prev && now - prev.at < 3000) ? prev.streak + 1 : 1
  ctx.state.killStreaks.set(shooterId, { streak, at: now })
  const killerName = ctx.players.getById(shooterId)?.name || 'Player'
  ctx.network.broadcast({ type: 'death', victim: target.id, killer: shooterId, killerName, headshot: isHeadshot, streak, killerKills: ss.kills })
}

export function handleFire(ctx, msg) {
  const { shooterId, origin, direction, viewTick } = msg
  if (!origin || !direction) return
  const { combat } = ctx
  const players = ctx.players.getAll()
  const buff = ctx.state.buffs.get(shooterId)
  const damage = Math.round(ctx.state.config.damagePerHit * (buff ? buff.damage : 1))
  const tick = ctx.time.tick
  if (ctx.state._rewindIndexTick !== tick || !ctx.state._rewindIndex) {
    ctx.state._rewindIndex = combat.buildLiveIndex(players)
    ctx.state._rewindIndexTick = tick
  }
  const shot = { shooterId, origin, direction, viewTick, range: RANGE_M, lagComp: ctx.lagCompensator, isTargetable: t => isTargetable(ctx, t) }
  const found = combat.findHitSpatial(players, shot, ctx.state._rewindIndex)
  if (!found) {
    const r = ctx.raycast(origin, direction, RANGE_M, null)
    if (r?.hit && r.position) {
      if (r.entityId != null) ctx.world.sendToEntity(r.entityId, { type: 'damage', amount: damage, shooterId })
      ctx.network.broadcast({ type: 'world_hit', shooter: shooterId, pos: r.position, normal: r.normal || null })
    }
    return
  }
  const { target, tp, rewound, proj } = found
  const hitRatio = combat.hitHeightRatio(proj, tp)
  const isHeadshot = hitRatio >= ctx.state.config.headshotZone
  const finalDamage = isHeadshot ? Math.round(damage * ctx.state.config.headshotMultiplier) : damage
  const newHp = Math.max(0, (target.state.health ?? ctx.state.config.health) - finalDamage)
  target.state.health = newHp
  const hb = combat.DEFAULT_HITBOX
  ctx.eventLog?.record('hit_registered', {
    attackerId: shooterId, targetId: target.id, damage: finalDamage, headshot: isHeadshot, lethal: newHp <= 0, resultHealth: newHp,
    rewound: !!rewound, viewTick, rewoundTicks: viewTick != null && ctx.lagCompensator ? ctx.lagCompensator.latestTick - viewTick : 0,
    hitPosition: proj, targetPosition: tp,
    hitbox: { radiusSq: hb.radiusSq, heightOffset: hb.centerHeight, headshotRatio: ctx.state.config.headshotZone, hitRatio },
    shotOrigin: origin, shotDirection: direction
  }, { actor: shooterId, sourceEntity: target.id, reason: 'weapon_fire' })
  combat.recordHit(ctx.eventLog, shooterId, { headshot: isHeadshot, timestampMs: Date.now(), targetId: target.id })
  target.state.velocity[0] += direction[0] * ctx.state.config.hitKnockback
  target.state.velocity[2] += direction[2] * ctx.state.config.hitKnockback
  ctx.players.send(target.id, { type: 'aimpunch', intensity: isHeadshot ? 0.8 : 0.6 })
  ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage: finalDamage, health: newHp, headshot: isHeadshot, pos: proj, dir: direction, knockback: ctx.state.config.hitKnockback })
  if (newHp <= 0) onKill(ctx, shooterId, target, finalDamage, isHeadshot)
  else addStat(ctx, shooterId, { damage: finalDamage })
}
