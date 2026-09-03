import { findSpawnPoints, getAvailableSpawnPoint, handleFire, loadScoreboard, flushScoreboard, persistPlayerStat } from './server.js'
import { collectSpawnPoints } from '../spawn-point/index.js'
import { POWERUP_DEFS, POWERUP_RESPAWN_MS, POWERUP_PICKUP_RADIUS, EMOTE_CLIPS, spawnPowerup } from './shared.js'

export const tpsGameServer = {
  async setup(ctx) {
    ctx.state.map = 'schwust'
    ctx.state.mode = 'ffa'
    ctx.state.config = { respawnTime: 1.5, health: 100, damagePerHit: 20, headshotMultiplier: 2.5, headshotZone: 0.7, hitKnockback: 4, shootKnockback: 2, magazineSize: 30, reloadTime: 2000, spawnInvulnMs: 1500 }
    ctx.state.invuln = new Map()
    // Placed spawn-point entities (apps/spawn-point) take priority over the raycast grid --
    // a maker who drops markers gets exactly those; the grid is only the no-markers-placed
    // fallback so existing worlds without markers keep working unchanged.
    const placedSpawns = collectSpawnPoints(ctx)
    ctx.state.spawnPoints = placedSpawns.length > 0 ? placedSpawns : findSpawnPoints(ctx)
    ctx.state.playerStats = new Map()
    // Cumulative session/across-restart scoreboard, keyed by durable player name -- see server.js
    // loadScoreboard/persistPlayerStat. Awaited here (AppRuntime awaits server.setup) so it is fully
    // populated before the FIRST player_join can look a name up.
    await loadScoreboard(ctx)
    // Register the debounced scoreboard write's flush with the engine's graceful-shutdown registry
    // (ctx.onShutdown, src/apps/AppContext.js/AppRuntime.js) so a SIGINT/SIGTERM within the 500ms
    // debounce window (see scheduleScoreboardPersist in server.js) doesn't silently drop the last
    // burst of kill/death stat changes -- mirrors ctx.placedModelStorage.flush()'s own shutdown wiring.
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
    // Defensive re-init: setup() constructs ctx.state.buffs as a real Map. The two real root causes
    // that could hand back a non-Map here are both fixed upstream now: (1) the init-order race, where
    // update() could run before setup()'s async loadScoreboard await resolves -- see AppRuntime.js's
    // _pendingSetupIds skip in _rebuildUpdateList/_rebuildCollisionList; (2) a Map silently downgrading
    // to a plain object across any restoreGameState/WorldPersistence round-trip, since a naive
    // JSON.parse(JSON.stringify(...)) has no Map wire type -- fixed via AppRuntime.js's tagged
    // cloneAppState (Map/Set-preserving replacer/reviver), used for entity._appState (ctx.state)
    // specifically. This guard stays as cheap, top-of-update defense-in-depth against any future
    // write path this loop hasn't been audited against yet, not because either known cause is still open.
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
    // Same defensive re-init as ctx.state.buffs above (init-order race / Map->plain-object downgrade
    // across a restoreGameState/WorldPersistence round-trip) -- powerups hit the identical hazard since
    // it is also a Map constructed once in setup() with no per-tick type guard until now.
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
      // respawn must reset ammo/reload same as player_join, else stale magazine silently rejects every shot client thinks it has
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
      // must not force health on reconnect: RECONNECT_ACK already restored it, forcing max would res a mid-blip death
      if (p?.state && !msg.reconnected) p.state.health = ctx.state.config.health
      if (!msg.reconnected || !ctx.state.playerStats.has(msg.playerId)) {
        // Restore cumulative kills/deaths/damage from the durable by-name scoreboard (see server.js
        // loadScoreboard/persistPlayerStat) if this player's name has a saved record -- a fresh Map
        // entry every join/reconnect used to silently reset the live in-memory stats to zero even
        // though the durable record on disk still had the player's real cumulative totals.
        const name = p?.name || `Player ${msg.playerId}`
        const saved = ctx.state.scoreboardByName?.[name]
        ctx.state.playerStats.set(msg.playerId, saved ? { kills: saved.kills || 0, deaths: saved.deaths || 0, damage: saved.damage || 0 } : { kills: 0, deaths: 0, damage: 0 })
      }
      ctx.state.ammo.set(msg.playerId, ctx.state.config.magazineSize)
      ctx.state.reloading.delete(msg.playerId)
    }
    if (msg.type === 'player_leave') {
      // Final mirror-and-persist BEFORE dropping the in-memory entry -- covers the case where the
      // last stat change since the previous debounce fired (e.g. a damage tick from the shot that
      // killed the leaving player) hasn't hit disk yet. The durable by-name record is what survives;
      // the in-memory playerStats Map is keyed by this ephemeral playerId and is safe to drop, since
      // a future rejoin re-seeds from ctx.state.scoreboardByName (by name) on player_join above.
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
      // Server-authoritative allowlist: never trust a client-supplied clip name directly into
      // playAnimation (an arbitrary string reaching the animation library lookup is low-risk here
      // since it only no-ops on a miss, but an explicit allowlist is the correct discipline for any
      // client-triggered broadcast -- matches roadmap #78's own 'networked emote codes' framing,
      // a CODE the client sends, not a free-text clip name). Rate-limited per player (reuses the
      // same reload-style timestamp-gate pattern as the fire/reload handlers above) so a client
      // can't spam a broadcast to every other connected player.
      const playerId = msg.senderId || msg.playerId
      const now = Date.now()
      const lastEmote = ctx.state.lastEmoteAt.get(playerId) || 0
      if (now - lastEmote < 800) return
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
      // msg.clientTime is expressed in ESTIMATED SERVER CLOCK time (BaseClient.sendFire adds the
      // client's NTP-style clock offset before sending), so Date.now()-msg.clientTime here is a real
      // one-way client->server delay estimate, not the old raw-clock-skew-conflated value.
      const latencyMs = msg.clientTime ? Math.min(600, Math.max(0, Date.now() - msg.clientTime)) : 0
      const fireData = { shooterId, origin, direction: msg.direction, latencyMs }
      ctx.bus.emit('combat.fire', fireData)
      if (shooter?.state) { shooter.state.velocity[0] -= msg.direction[0] * ctx.state.config.shootKnockback; shooter.state.velocity[2] -= msg.direction[2] * ctx.state.config.shootKnockback }
      ctx.players.send(shooterId, { type: 'aimpunch', intensity: 0.3 })
      handleFire(ctx, fireData)
    }
  }
}
