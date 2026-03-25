import { findSpawnPoints, getAvailableSpawnPoint, handleFire } from './server.js'

export default {
  server: {
    setup(ctx) {
      ctx.state.map = 'schwust'
      ctx.state.mode = 'ffa'
      ctx.state.config = { respawnTime: 3, health: 100, damagePerHit: 20, headshotMultiplier: 2.5, headshotZone: 0.7, hitKnockback: 4, shootKnockback: 2, magazineSize: 30, reloadTime: 2000 }
      ctx.state.spawnPoints = findSpawnPoints(ctx)
      ctx.state.playerStats = new Map()
      ctx.state.respawning = new Map()
      ctx.state.buffs = new Map()
      ctx.state.ammo = new Map()
      ctx.state.reloading = new Map()
      ctx.state.started = Date.now()
      ctx.state.gameTime = 0
      ctx.state.fallTimers = new Map()
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
      for (const [pid, buff] of ctx.state.buffs) {
        if (now >= buff.expiresAt) { ctx.state.buffs.delete(pid); ctx.players.send(pid, { type: 'buff_expired' }) }
        else { const player = ctx.players.getById(pid); if (player?.state) player.state.health = Math.min(ctx.state.config.health, (player.state.health ?? ctx.state.config.health) + (ctx.state.config.health / 10) * dt) }
      }
      for (const player of ctx.players.getAll()) {
        if (!player.state || ctx.state.respawning.has(player.id)) continue
        if ((player.state.health ?? ctx.state.config.health) <= 0) continue
        const y = player.state.position?.[1] ?? 0
        if (y < -20) {
          const t = (ctx.state.fallTimers.get(player.id) || 0) + dt
          ctx.state.fallTimers.set(player.id, t)
          if (t >= 5) { player.state.health = 0; ctx.state.respawning.set(player.id, { respawnAt: now + ctx.state.config.respawnTime * 1000, killer: null }); ctx.network.broadcast({ type: 'death', victim: player.id, killer: null }); ctx.state.fallTimers.delete(player.id) }
        } else { ctx.state.fallTimers.delete(player.id) }
      }
      for (const [pid, data] of ctx.state.respawning) {
        if (now < data.respawnAt) continue
        const sp = getAvailableSpawnPoint(ctx, ctx.state.spawnPoints)
        const player = ctx.players.getById(pid)
        if (player?.state) { player.state.health = ctx.state.config.health; player.state.velocity = [0, 0, 0]; ctx.players.setPosition(pid, sp) }
        ctx.players.send(pid, { type: 'respawn', position: sp, health: ctx.state.config.health })
        ctx.state.respawning.delete(pid)
      }
    },

    onMessage(ctx, msg) {
      if (!msg) return
      if (msg.type === 'player_join') {
        const p = ctx.players.getById(msg.playerId)
        if (p?.state) p.state.health = ctx.state.config.health
        ctx.state.playerStats.set(msg.playerId, { kills: 0, deaths: 0, damage: 0 })
        ctx.state.ammo.set(msg.playerId, ctx.state.config.magazineSize)
        ctx.state.reloading.delete(msg.playerId)
      }
      if (msg.type === 'player_leave') {
        ctx.state.playerStats.delete(msg.playerId); ctx.state.respawning.delete(msg.playerId)
        ctx.state.fallTimers.delete(msg.playerId); ctx.state.ammo.delete(msg.playerId); ctx.state.reloading.delete(msg.playerId)
      }
      if (msg.type === 'reload') {
        const playerId = msg.senderId || msg.playerId
        if (ctx.state.reloading.has(playerId) || (ctx.state.ammo.get(playerId) ?? 0) >= ctx.state.config.magazineSize) return
        ctx.state.reloading.set(playerId, { startTime: Date.now() })
        ctx.players.send(playerId, { type: 'reload_start', duration: ctx.state.config.reloadTime })
        setTimeout(() => { ctx.state.ammo.set(playerId, ctx.state.config.magazineSize); ctx.state.reloading.delete(playerId); ctx.players.send(playerId, { type: 'reload_complete' }) }, ctx.state.config.reloadTime)
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
        const latencyMs = msg.clientTime ? Math.min(600, Math.max(0, Date.now() - msg.clientTime)) : 0
        const fireData = { shooterId, origin, direction: msg.direction, latencyMs }
        ctx.bus.emit('combat.fire', fireData)
        if (shooter?.state) { shooter.state.velocity[0] -= msg.direction[0] * ctx.state.config.shootKnockback; shooter.state.velocity[2] -= msg.direction[2] * ctx.state.config.shootKnockback }
        ctx.players.send(shooterId, { type: 'aimpunch', intensity: 0.3 })
        handleFire(ctx, fireData)
      }
    }
  },

  client: {
    _tps: null,
    setup(engine) {
      const flash = new engine.THREE.PointLight(0xffaa00, 0, 8)
      engine.scene.add(flash)
      engine._tps = { lastShootTime: 0, isAiming: false, boost: null, flash, flashOff: 0, ammo: 30, reloading: false, lastReloadTime: 0 }
      this._tps = engine._tps
    },
    onMouseDown(e, engine) { if (e.button === 2 && engine._tps) engine._tps.isAiming = true },
    onMouseUp(e, engine) { if (e.button === 2 && engine._tps) engine._tps.isAiming = false },
    onInput(input, engine) {
      const tps = engine._tps; if (!tps) return
      if (input.reload && !tps.reloading && Date.now() - tps.lastReloadTime > 100) { tps.lastReloadTime = Date.now(); engine.client.sendReload() }
      if (input.shoot && !tps.reloading && tps.ammo > 0 && Date.now() - tps.lastShootTime > 100) {
        tps.lastShootTime = Date.now()
        const local = engine.client.state?.players?.find(p => p.id === engine.playerId)
        if (local) {
          const pos = local.position
          engine.client.sendFire({ origin: [pos[0], pos[1] + 0.9, pos[2]], direction: engine.cam.getAimDirection(pos) })
          const animator = engine.players.getAnimator(engine.playerId)
          if (animator) animator.shoot()
          tps.flash.position.set(pos[0], pos[1] + 0.5, pos[2]); tps.flash.intensity = 3; tps.flashOff = Date.now() + 60
          tps.ammo = Math.max(0, tps.ammo - 1)
        }
      }
    },
    onEvent(payload, engine) {
      const tps = engine._tps
      if (payload.type === 'hit' && payload.target) { engine.players.setExpression(payload.target, 'angry', 0.6); setTimeout(() => engine.players.setExpression(payload.target, 'angry', 0), 500) }
      if (payload.type === 'aimpunch' && engine.cam?.punch) engine.cam.punch(payload.intensity || 0.3)
      if (payload.type === 'death' && payload.victim) engine.players.setExpression(payload.victim, 'sorrow', 1.0)
      if (payload.type === 'buff_applied' && tps) tps.boost = { expiresAt: Date.now() + (payload.duration || 45) * 1000 }
      if (payload.type === 'buff_expired' && tps) tps.boost = null
      if (payload.type === 'reload_start' && tps) { tps.reloading = true; tps.reloadEndTime = Date.now() + (payload.duration || 2000); const animator = engine.players?.getAnimator(engine.playerId); if (animator) animator.reload() }
      if (payload.type === 'reload_complete' && tps) { tps.reloading = false; tps.ammo = 30 }
    },
    onFrame(dt, engine) {
      const tps = engine._tps; if (!tps) return
      if (tps.boost && Date.now() >= tps.boost.expiresAt) tps.boost = null
      if (tps.flash && tps.flashOff && Date.now() >= tps.flashOff) { tps.flash.intensity = 0; tps.flashOff = 0 }
      engine.players.setAiming(engine.playerId, tps.isAiming)
    },
    render(ctx) {
      const h = ctx.h; if (!h) return { position: ctx.entity.position }
      const s = ctx.state || {}
      const local = ctx.players?.find(p => p.id === ctx.engine?.playerId)
      const hp = local?.health ?? 100
      const tps = ctx.engine?._tps
      const boostSec = tps?.boost ? Math.ceil((tps.boost.expiresAt - Date.now()) / 1000) : 0
      const ammo = tps?.ammo ?? 0
      const reloading = tps?.reloading ?? false
      const reloadProgress = reloading && tps?.reloadEndTime ? Math.min(100, Math.round((1 - (tps.reloadEndTime - Date.now()) / 2000) * 100)) : 0
      return {
        position: ctx.entity.position,
        custom: { game: s.map, mode: s.mode },
        ui: h('div', { class: 'tps-hud' },
          h('div', { id: 'crosshair', style: 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font-size:24px;color:#fff;text-shadow:0 0 2px #000' }, '+'),
          h('div', { id: 'ammo-counter', style: 'position:fixed;bottom:50px;right:20px;font-size:24px;font-weight:bold;color:#fff;text-shadow:0 0 4px #000;font-family:monospace' },
            reloading ? h('span', { style: 'color:#ff0' }, `RELOADING ${reloadProgress}%`) : h('span', null, `${ammo}/30`)
          ),
          h('div', { id: 'health-bar', style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:200px;height:20px;background:#333;border-radius:4px;overflow:hidden' },
            h('div', { style: `width:${hp}%;height:100%;background:${hp > 60 ? '#0f0' : hp > 30 ? '#ff0' : '#f00'};transition:width 0.2s` }),
            h('span', { style: 'position:absolute;width:100%;text-align:center;color:#fff;font-size:12px;line-height:20px' }, String(hp))
          ),
          boostSec > 0 ? h('div', { style: 'position:fixed;top:80px;right:20px;padding:8px 16px;background:linear-gradient(135deg,#ffd700,#ff8c00);color:#000;font-weight:bold;border-radius:6px;font-size:14px;box-shadow:0 0 12px rgba(255,215,0,0.6)' }, `BOOSTED ${boostSec}s`) : null
        )
      }
    }
  }
}
