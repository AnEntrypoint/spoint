import { findSpawnPoints, getAvailableSpawnPoint, handleFire, loadScoreboard, flushScoreboard, persistPlayerStat } from './server.js'
import { collectSpawnPoints } from '../spawn-point/index.js'
import { POWERUP_DEFS, POWERUP_RESPAWN_MS, POWERUP_PICKUP_RADIUS, EMOTE_CLIPS, spawnPowerup } from './shared.js'

const EMOTE_RATE_LIMIT_MS = 800
const MAX_REWIND_LATENCY_MS = 600

export const tpsGameServer = {
  async setup(ctx) {
    ctx.state.map = 'schwust'
    ctx.state.mode = 'ffa'
    ctx.state.config = { respawnTime: 1.5, health: 100, damagePerHit: 20, headshotMultiplier: 2.5, headshotZone: 0.7, hitKnockback: 4, shootKnockback: 2, magazineSize: 30, reloadTime: 2000, spawnInvulnMs: 1500 }
    ctx.state.invuln = new Map()
    const placedSpawns = collectSpawnPoints(ctx)
    ctx.state.spawnPoints = placedSpawns.length > 0 ? placedSpawns : findSpawnPoints(ctx)
    ctx.state.playerStats = new Map()
    await loadScoreboard(ctx)
    ctx.onShutdown(() => flushScoreboard(ctx))
    ctx.state.respawning = new Map()
    ctx.state.buffs = new Map()
    ctx.state.ammo = new Map()
    ctx.state.reloading = new Map()
    ctx.state.lastEmoteAt = new Map()
    ctx.state.started = Date.now()
    ctx.state.gameTime = 0
    ctx.state.fallTimers = new Map()
    ctx.state.killStreaks = new Map()
    ctx.state.powerups = new Map()
    const sps = ctx.state.spawnPoints
    const picks = (sps && sps.length >= POWERUP_DEFS.length)
      ? POWERUP_DEFS.map((_, i) => sps[Math.floor((i + 1) * sps.length / (POWERUP_DEFS.length + 1))])
      : POWERUP_DEFS.map((_, i) => [i * 8 - 8, 3, 0])
    POWERUP_DEFS.forEach((def, i) => {
      const p = picks[i], pos = [p[0], p[1] + 0.6, p[2]], id = `powerup_${def.type}`
      ctx.state.powerups.set(id, { def, position: pos, active: true, respawnAt: 0 })
      spawnPowerup(ctx, id, def, pos)
    })
    ctx.bus.on('powerup.collected', (event) => {
      const d = event.data
      ctx.state.buffs.set(d.playerId, { expiresAt: Date.now() + d.duration * 1000, speed: d.speedMultiplier, fireRate: d.fireRateMultiplier, damage: d.damageMultiplier })
      ctx.players.send(d.playerId, { type: 'buff_applied', duration: d.duration, speed: d.speedMultiplier, fireRate: d.fireRateMultiplier, damage: d.damageMultiplier })
    })
    console.log(`[tps-game] ${ctx.state.spawnPoints.length} spawn points validated`)
  },

  update(ctx, dt) {
    ctx.state.gameTime = (Date.now() - ctx.state.started) / 1000
    const now = Date.now()
    if (!(ctx.state.buffs instanceof Map)) ctx.state.buffs = new Map()
    for (const [pid, buff] of ctx.state.buffs) {
      if (now >= buff.expiresAt) { ctx.state.buffs.delete(pid); ctx.players.send(pid, { type: 'buff_expired' }) }
      else { const player = ctx.players.getById(pid); if (player?.state) player.state.health = Math.min(ctx.state.config.health, (player.state.health ?? ctx.state.config.health) + (ctx.state.config.health / 10) * dt) }
    }
    const allPlayers = ctx.players.getAll()
    for (const player of allPlayers) {
      if (!player.state || ctx.state.respawning.has(player.id)) continue
      if ((player.state.health ?? ctx.state.config.health) <= 0) continue
      const y = player.state.position?.[1] ?? 0
      if (y < -20) {
        const t = (ctx.state.fallTimers.get(player.id) || 0) + dt
        ctx.state.fallTimers.set(player.id, t)
        if (t >= 0.5) { player.state.health = 0; ctx.state.respawning.set(player.id, { respawnAt: now + ctx.state.config.respawnTime * 1000, killer: null }); ctx.network.broadcast({ type: 'death', victim: player.id, killer: null, cause: 'fall' }); ctx.state.fallTimers.delete(player.id) }
      } else { ctx.state.fallTimers.delete(player.id) }
    }
    if (!(ctx.state.powerups instanceof Map)) ctx.state.powerups = new Map()
    {
      for (const [id, pu] of ctx.state.powerups) {
        if (pu.active) {
          for (const player of allPlayers) {
            if (!player.state || ctx.state.respawning.has(player.id)) continue
            if ((player.state.health ?? ctx.state.config.health) <= 0) continue
            const pp = player.state.position; if (!pp) continue
            const dx = pp[0] - pu.position[0], dy = pp[1] - pu.position[1], dz = pp[2] - pu.position[2]
            if (dx * dx + dy * dy + dz * dz <= POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) {
              ctx.bus.emit('powerup.collected', { playerId: player.id, duration: pu.def.buff.duration, speedMultiplier: pu.def.buff.speedMultiplier, fireRateMultiplier: pu.def.buff.fireRateMultiplier, damageMultiplier: pu.def.buff.damageMultiplier })
              ctx.world.destroy(id)
              pu.active = false; pu.respawnAt = now + POWERUP_RESPAWN_MS
              break
            }
          }
        } else if (now >= pu.respawnAt) {
          spawnPowerup(ctx, id, pu.def, pu.position); pu.active = true
        }
      }
    }
    for (const [pid, data] of ctx.state.respawning) {
      if (now < data.respawnAt) continue
      const sp = getAvailableSpawnPoint(ctx, ctx.state.spawnPoints)
      const player = ctx.players.getById(pid)
      if (player?.state) { player.state.health = ctx.state.config.health; player.state.velocity = [0, 0, 0]; ctx.players.setPosition(pid, sp) }
      ctx.state.invuln.set(pid, now + (ctx.state.config.spawnInvulnMs || 0))
      ctx.state.ammo.set(pid, ctx.state.config.magazineSize)
      ctx.state.reloading.delete(pid)
      ctx.players.send(pid, { type: 'respawn', position: sp, health: ctx.state.config.health, ammo: ctx.state.config.magazineSize, invulnMs: ctx.state.config.spawnInvulnMs })
      ctx.state.respawning.delete(pid)
    }
  },

  onMessage(ctx, msg) {
    if (!msg) return
    if (msg.type === 'player_join') {
      const p = ctx.players.getById(msg.playerId)
      if (p?.state && !msg.reconnected) p.state.health = ctx.state.config.health
      if (!msg.reconnected || !ctx.state.playerStats.has(msg.playerId)) {
        const name = p?.name || `Player ${msg.playerId}`
        const saved = ctx.state.scoreboardByName?.[name]
        ctx.state.playerStats.set(msg.playerId, saved ? { kills: saved.kills || 0, deaths: saved.deaths || 0, damage: saved.damage || 0 } : { kills: 0, deaths: 0, damage: 0 })
      }
      ctx.state.ammo.set(msg.playerId, ctx.state.config.magazineSize)
      ctx.state.reloading.delete(msg.playerId)
    }
    if (msg.type === 'player_leave') {
      persistPlayerStat(ctx, msg.playerId)
      ctx.state.playerStats.delete(msg.playerId); ctx.state.respawning.delete(msg.playerId)
      ctx.state.fallTimers.delete(msg.playerId); ctx.state.ammo.delete(msg.playerId); ctx.state.reloading.delete(msg.playerId); ctx.state.invuln.delete(msg.playerId)
    }
    if (msg.type === 'reload') {
      const playerId = msg.senderId || msg.playerId
      if (ctx.state.reloading.has(playerId) || (ctx.state.ammo.get(playerId) ?? 0) >= ctx.state.config.magazineSize) return
      ctx.state.reloading.set(playerId, { startTime: Date.now() })
      ctx.players.send(playerId, { type: 'reload_start', duration: ctx.state.config.reloadTime })
      setTimeout(() => { ctx.state.ammo.set(playerId, ctx.state.config.magazineSize); ctx.state.reloading.delete(playerId); ctx.players.send(playerId, { type: 'reload_complete' }) }, ctx.state.config.reloadTime)
    }
    if (msg.type === 'emote') {
      const playerId = msg.senderId || msg.playerId
      const now = Date.now()
      const lastEmote = ctx.state.lastEmoteAt.get(playerId) || 0
      if (now - lastEmote < EMOTE_RATE_LIMIT_MS) return
      if (!EMOTE_CLIPS.has(msg.code)) return
      ctx.state.lastEmoteAt.set(playerId, now)
      ctx.players.playAnimation(playerId, EMOTE_CLIPS.get(msg.code), { loop: false })
    }
    if (msg.type === 'fire') {
      const shooterId = msg.senderId || msg.shooterId
      if (ctx.state.reloading.has(shooterId)) return
      const ammo = ctx.state.ammo.get(shooterId) ?? 0
      if (ammo <= 0) { ctx.players.send(shooterId, { type: 'empty_click' }); return }
      ctx.state.ammo.set(shooterId, ammo - 1)
      const shooter = ctx.players.getById(shooterId)
      const pos = shooter?.state?.position || [0, 0, 0]
      const origin = [pos[0], pos[1] + 0.9, pos[2]]
      const latencyMs = msg.clientTime ? Math.min(MAX_REWIND_LATENCY_MS, Math.max(0, Date.now() - msg.clientTime)) : 0
      const fireData = { shooterId, origin, direction: msg.direction, latencyMs }
      ctx.bus.emit('combat.fire', fireData)
      if (shooter?.state) { shooter.state.velocity[0] -= msg.direction[0] * ctx.state.config.shootKnockback; shooter.state.velocity[2] -= msg.direction[2] * ctx.state.config.shootKnockback }
      ctx.players.send(shooterId, { type: 'aimpunch', intensity: 0.3 })
      handleFire(ctx, fireData)
    }
  }
}
