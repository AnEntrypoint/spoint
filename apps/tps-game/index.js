export default {
  server: {
    setup(ctx) {
      ctx.state.map = 'schwust'
      ctx.state.mode = 'ffa'
      ctx.state.config = { respawnTime: 3, health: 100, damagePerHit: 25 }
      ctx.state.spawnPoints = findSpawnPoints(ctx)
      ctx.state.playerStats = new Map()
      ctx.state.respawning = new Map()
      ctx.state.buffs = new Map()
      ctx.state.started = Date.now()
      ctx.state.gameTime = 0

      ctx.bus.on('powerup.collected', (event) => {
        const d = event.data
        ctx.state.buffs.set(d.playerId, {
          expiresAt: Date.now() + d.duration * 1000,
          speed: d.speedMultiplier,
          fireRate: d.fireRateMultiplier,
          damage: d.damageMultiplier
        })
        ctx.players.send(d.playerId, {
          type: 'buff_applied',
          duration: d.duration,
          speed: d.speedMultiplier,
          fireRate: d.fireRateMultiplier,
          damage: d.damageMultiplier
        })
      })

      console.log(`[tps-game] ${ctx.state.spawnPoints.length} spawn points validated`)
    },

    update(ctx, dt) {
      ctx.state.gameTime = (Date.now() - ctx.state.started) / 1000
      const now = Date.now()
      for (const [pid, buff] of ctx.state.buffs) {
        if (now >= buff.expiresAt) {
          ctx.state.buffs.delete(pid)
          ctx.players.send(pid, { type: 'buff_expired' })
        }
      }
      for (const [pid, data] of ctx.state.respawning) {
        if (now < data.respawnAt) continue
        const sp = getAvailableSpawnPoint(ctx, ctx.state.spawnPoints)
        const player = ctx.players.getAll().find(p => p.id === pid)
        if (player && player.state) {
          player.state.health = ctx.state.config.health
          player.state.velocity = [0, 0, 0]
          ctx.players.setPosition(pid, sp)
        }
        ctx.players.send(pid, { type: 'respawn', position: sp, health: ctx.state.config.health })
        ctx.state.respawning.delete(pid)
      }
    },

    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'player_join') {
        const p = ctx.players.getAll().find(pl => pl.id === msg.playerId)
        if (p && p.state) p.state.health = ctx.state.config.health
        ctx.state.playerStats.set(msg.playerId, { kills: 0, deaths: 0, damage: 0 })
      }
      if (msg.type === 'player_leave') {
        ctx.state.playerStats.delete(msg.playerId)
        ctx.state.respawning.delete(msg.playerId)
      }
      if (msg.type === 'fire') {
        ctx.bus.emit('combat.fire', {
          shooterId: msg.shooterId,
          origin: msg.origin,
          direction: msg.direction
        })
        handleFire(ctx, msg)
      }
    }
  },

  client: {
    render(ctx) {
      const h = ctx.h
      const s = ctx.state || {}
      const ui = h ? h('div', { class: 'game-info' },
        h('span', null, s.mode || 'ffa'),
        h('span', null, s.time || '0')
      ) : null
      return {
        position: ctx.entity.position,
        custom: { game: s.map, mode: s.mode, time: s.gameTime?.toFixed(1) || '0' },
        ui
      }
    }
  }
}

function findSpawnPoints(ctx) {
  const valid = []
  for (let x = -56; x <= 44; x += 13) {
    for (let z = -90; z <= 34; z += 12) {
      const hit = ctx.raycast([x, 20, z], [0, -1, 0], 30)
      if (hit.hit && hit.position[1] > -3) valid.push([x, hit.position[1] + 2, z])
    }
  }
  if (valid.length < 4) valid.push([0, 5, 0], [-35, 3, -65], [20, 5, -20], [-20, 5, 20])
  return valid
}

function getAvailableSpawnPoint(ctx, spawnPoints) {
  const MIN_SAFE_DISTANCE = 6
  const activePlayers = ctx.players.getAll().filter(p => p.state && !ctx.state.respawning.has(p.id))
  const safePoints = spawnPoints.filter(sp => {
    return activePlayers.every(player => {
      const dist = Math.hypot(sp[0] - player.state.position[0], sp[1] - player.state.position[1], sp[2] - player.state.position[2])
      return dist >= MIN_SAFE_DISTANCE
    })
  })
  const availablePoints = safePoints.length > 0 ? safePoints : spawnPoints
  return availablePoints[Math.floor(Math.random() * availablePoints.length)]
}

function handleFire(ctx, msg) {
  const shooterId = msg.shooterId
  const origin = msg.origin
  const direction = msg.direction
  if (!origin || !direction) return

  const players = ctx.players.getAll()
  const range = 1000
  const buff = ctx.state.buffs.get(shooterId)
  const damageMultiplier = buff ? buff.damage : 1
  const damage = Math.round(ctx.state.config.damagePerHit * damageMultiplier)

  for (const target of players) {
    if (!target.state || target.id === shooterId) continue
    if (ctx.state.respawning.has(target.id)) continue
    if ((target.state.health ?? ctx.state.config.health) <= 0) continue
    const tp = target.state.position
    const toTarget = [tp[0] - origin[0], tp[1] + 0.9 - origin[1], tp[2] - origin[2]]
    const dot = toTarget[0] * direction[0] + toTarget[1] * direction[1] + toTarget[2] * direction[2]
    if (dot < 0 || dot > range) continue
    const proj = [origin[0] + direction[0] * dot, origin[1] + direction[1] * dot, origin[2] + direction[2] * dot]
    const dist = Math.hypot(proj[0] - tp[0], proj[1] - (tp[1] + 0.9), proj[2] - tp[2])
    if (dist > 0.6) continue

    const hp = target.state.health ?? ctx.state.config.health
    const newHp = Math.max(0, hp - damage)
    target.state.health = newHp

    ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage, health: newHp })

    if (newHp <= 0) {
      const shooterStats = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      shooterStats.kills++
      shooterStats.damage += damage
      ctx.state.playerStats.set(shooterId, shooterStats)
      const targetStats = ctx.state.playerStats.get(target.id) || { kills: 0, deaths: 0, damage: 0 }
      targetStats.deaths++
      ctx.state.playerStats.set(target.id, targetStats)
      ctx.state.respawning.set(target.id, { respawnAt: Date.now() + ctx.state.config.respawnTime * 1000, killer: shooterId })
      ctx.network.broadcast({ type: 'death', victim: target.id, killer: shooterId })
    } else {
      const shooterStats = ctx.state.playerStats.get(shooterId) || { kills: 0, deaths: 0, damage: 0 }
      shooterStats.damage += damage
      ctx.state.playerStats.set(shooterId, shooterStats)
    }
    break
  }
}
