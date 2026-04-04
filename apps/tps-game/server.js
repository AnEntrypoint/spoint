export function findSpawnPoints(ctx) {
  const valid = []
  for (let x = -850; x <= 1050; x += 180) {
    for (let z = -80; z <= 960; z += 160) {
      const hit = ctx.raycast([x, 20, z], [0, -1, 0], 30)
      if (hit.hit && hit.position[1] > -3) valid.push([x, hit.position[1] + 2, z])
    }
  }
  if (valid.length < 4) valid.push([0, 5, 0], [100, 5, 200], [-100, 5, -100], [200, 5, 500])
  return valid
}

export function getAvailableSpawnPoint(ctx, spawnPoints) {
  const MIN_SAFE_DISTANCE = 15
  const activePlayers = ctx.players.getAll().filter(p => p.state && !ctx.state.respawning.has(p.id))
  if (activePlayers.length === 0) return spawnPoints[Math.floor(Math.random() * spawnPoints.length)]
  const scored = spawnPoints.map(sp => {
    let minDist = Infinity
    for (const player of activePlayers) {
      const dist = Math.hypot(sp[0] - player.state.position[0], sp[2] - player.state.position[2])
      if (dist < minDist) minDist = dist
    }
    return { sp, minDist }
  })
  const safe = scored.filter(s => s.minDist >= MIN_SAFE_DISTANCE)
  if (safe.length > 0) return safe[Math.floor(Math.random() * safe.length)].sp
  scored.sort((a, b) => b.minDist - a.minDist)
  return scored[0].sp
}

export function handleFire(ctx, msg) {
  const { shooterId, origin, direction, latencyMs } = msg
  if (!origin || !direction) return
  const players = ctx.players.getAll()
  const range = 1000
  const buff = ctx.state.buffs.get(shooterId)
  const damage = Math.round(ctx.state.config.damagePerHit * (buff ? buff.damage : 1))
  const lagComp = ctx.lagCompensator
  for (const target of players) {
    if (!target.state || target.id === shooterId) continue
    if (ctx.state.respawning.has(target.id)) continue
    if ((target.state.health ?? ctx.state.config.health) <= 0) continue
    const rewound = latencyMs > 0 && lagComp ? lagComp.getPlayerStateAtTime(target.id, latencyMs) : null
    const tp = rewound ? rewound.position : target.state.position
    const toTarget = [tp[0] - origin[0], tp[1] + 0.9 - origin[1], tp[2] - origin[2]]
    const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
    if (dot < 0 || dot > range) continue
    const proj = [origin[0] + direction[0] * dot, origin[1] + direction[1] * dot, origin[2] + direction[2] * dot]
    const dist = Math.hypot(proj[0] - tp[0], proj[1] - (tp[1] + 0.9), proj[2] - tp[2])
    if (dist > 0.6) continue
    const hitRatio = (proj[1] - tp[1]) / 1.8
    const isHeadshot = hitRatio >= ctx.state.config.headshotZone
    const finalDamage = isHeadshot ? Math.round(damage * ctx.state.config.headshotMultiplier) : damage
    const hp = target.state.health ?? ctx.state.config.health
    const newHp = Math.max(0, hp - finalDamage)
    target.state.health = newHp
    target.state.velocity[0] += direction[0] * ctx.state.config.hitKnockback
    target.state.velocity[2] += direction[2] * ctx.state.config.hitKnockback
    ctx.players.send(target.id, { type: 'aimpunch', intensity: 0.6 })
    ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage: finalDamage, health: newHp, headshot: isHeadshot })
    if (newHp <= 0) {
      const ss = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      ss.kills++; ss.damage += finalDamage; ctx.state.playerStats.set(shooterId, ss)
      const ts = ctx.state.playerStats.get(target.id) || { kills: 0, deaths: 0, damage: 0 }
      ts.deaths++; ctx.state.playerStats.set(target.id, ts)
      ctx.state.respawning.set(target.id, { respawnAt: Date.now() + ctx.state.config.respawnTime * 1000, killer: shooterId })
      ctx.network.broadcast({ type: 'death', victim: target.id, killer: shooterId })
    } else {
      const ss = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      ss.damage += finalDamage; ctx.state.playerStats.set(shooterId, ss)
    }
    break
  }
}
