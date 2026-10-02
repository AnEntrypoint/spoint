export const DEFAULT_COMBAT = Object.freeze({
  respawnTime: 1.5,
  health: 100,
  damagePerHit: 20,
  headshotMultiplier: 2.5,
  headshotZone: 0.7,
  hitKnockback: 4,
  shootKnockback: 2,
  magazineSize: 30,
  reloadTime: 2000,
  spawnInvulnMs: 1500,
  fallKillDepth: 20,
  fallKillGraceSec: 0.5,
  buffRegenFractionPerSec: 0.1,
  range: 1000
})

const POWERUP_PICKUP_RADIUS = 1.7
const SPAWN_MARGIN = 3
const SCAN_REACH_M = 30
const LAST_RESORT_SPAWN = Object.freeze([0, 15, 0])
const SCOREBOARD_MAX_ENTRIES = 200

function powerupColor(def) {
  return { mesh: 'box', color: def.color, emissive: def.emissive, emissiveIntensity: 0.7, light: def.color, lightIntensity: 0.9, lightRange: 6, spin: 1.6, hover: 0.35, powerup: def.type }
}

function scanSpawnPoints(ctx) {
  const valid = []
  for (let x = -850; x <= 1050; x += 180) {
    for (let z = -80; z <= 960; z += 160) {
      const hit = ctx.raycast([x, 20, z], [0, -1, 0], SCAN_REACH_M, ctx.terrainBodyId)
      const arenaY = (hit.hit && hit.position[1] > -3) ? hit.position[1] : -Infinity
      const terrainY = ctx.terrainHeightAt(x, z)
      const groundY = Math.max(arenaY, Number.isFinite(terrainY) ? terrainY : -Infinity)
      if (Number.isFinite(groundY)) valid.push([x, groundY + SPAWN_MARGIN, z])
    }
  }
  if (valid.length < 4) {
    const ty = ctx.terrainHeightAt(0, 0)
    const y0 = (Number.isFinite(ty) ? ty : 3) + 5
    valid.push([0, y0, 0], [100, y0, 200], [-100, y0, -100], [200, y0, 500])
  }
  return valid
}

export function defineCombat(spec = {}, ctx = null) {
  if (!ctx) throw new TypeError('[combat] appCtx is required')
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('[combat] spec must be an object')
  if (spec.config !== undefined && (spec.config === null || typeof spec.config !== 'object')) throw new TypeError('[combat] spec.config must be an object')
  if (spec.powerups !== undefined && !Array.isArray(spec.powerups)) throw new TypeError('[combat] spec.powerups must be an array')

  const config = { ...DEFAULT_COMBAT, ...(spec.config || {}) }
  for (const k of ['onKill', 'onHit', 'onRespawn', 'onPowerup', 'onWorldHit', 'onDeath']) {
    if (spec[k] !== undefined && typeof spec[k] !== 'function') throw new TypeError(`[combat] spec.${k} must be a function`)
  }
  const powerupDefs = (spec.powerups || []).map((def, i) => {
    if (!def || typeof def !== 'object') throw new TypeError(`[combat] spec.powerups[${i}] must be an object`)
    if (typeof def.type !== 'string' || !def.type) throw new TypeError(`[combat] spec.powerups[${i}].type must be a non-empty string`)
    const buff = def.buff
    if (!buff || typeof buff !== 'object') throw new TypeError(`[combat] spec.powerups[${i}].buff must be an object`)
    if (!Number.isFinite(buff.duration)) throw new TypeError(`[combat] spec.powerups[${i}].buff.duration must be a finite number`)
    for (const k of ['speedMultiplier', 'fireRateMultiplier', 'damageMultiplier']) {
      if (buff[k] !== undefined && !Number.isFinite(buff[k])) throw new TypeError(`[combat] spec.powerups[${i}].buff.${k} must be a finite number`)
    }
    return { ...def, buff: { speedMultiplier: 1, fireRateMultiplier: 1, damageMultiplier: 1, ...buff } }
  })
  const scoreboard = ctx.persisted(spec.scoreboardKey || 'scoreboard', {})
  const spawnPoints = Array.isArray(spec.spawnPoints) && spec.spawnPoints.length > 0 ? spec.spawnPoints.map(sp => [...sp]) : scanSpawnPoints(ctx)

  const respawning = new Map()
  const invuln = new Map()
  const ammo = new Map()
  const reloading = new Map()
  const buffs = new Map()
  const fallTimers = new Map()
  const killStreaks = new Map()
  const powerupState = new Map()
  const playerStats = new Map()
  let rewindIndex = null
  let rewindTick = -1

  const statOf = id => playerStats.get(id) || { kills: 0, deaths: 0, damage: 0 }

  function addStat(id, delta) {
    const s = statOf(id)
    s.kills += delta.kills || 0
    s.deaths += delta.deaths || 0
    s.damage += delta.damage || 0
    playerStats.set(id, s)
    return s
  }

  function statsKeyOf(playerId) {
    const peerId = ctx.players.getById(playerId)?.socket?._peerId
    return (typeof peerId === 'string' && peerId) ? `peer:${peerId}` : `player:${playerId}`
  }

  function trimScoreboard() {
    const board = scoreboard.value
    const keys = Object.keys(board)
    if (keys.length <= SCOREBOARD_MAX_ENTRIES) return
    keys.sort((a, b) => (board[a].updatedAtMs ?? 0) - (board[b].updatedAtMs ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    for (const stale of keys.slice(0, keys.length - SCOREBOARD_MAX_ENTRIES)) delete board[stale]
  }

  function persistStat(id) {
    const stat = playerStats.get(id)
    if (!stat) return
    scoreboard.value[statsKeyOf(id)] = {
      name: ctx.players.getById(id)?.name || `Player ${id}`,
      kills: stat.kills,
      deaths: stat.deaths,
      damage: stat.damage,
      updatedAtMs: Date.now()
    }
    trimScoreboard()
    scoreboard.save()
  }

  function spawnPowerup(def, position) {
    const id = `powerup_${def.type}`
    if (!powerupState.has(id)) powerupState.set(id, { def, position: [...position], active: false, respawnAt: 0 })
    const pu = powerupState.get(id)
    pu.active = true
    ctx.world.spawn(id, { position: [...pu.position], scale: [0.55, 0.55, 0.55], custom: powerupColor(def) })
  }

  function despawnPowerup(id) {
    ctx.world.destroy(id)
  }

  function placePowerups() {
    if (powerupDefs.length === 0) return
    const picks = spawnPoints.length >= powerupDefs.length
      ? powerupDefs.map((_, i) => spawnPoints[Math.floor((i + 1) * spawnPoints.length / (powerupDefs.length + 1))])
      : powerupDefs.map((_, i) => [i * 8 - 8, 3, 0])
    powerupDefs.forEach((def, i) => {
      const p = picks[i]
      const pos = [p[0], p[1] + 0.6, p[2]]
      powerupState.set(`powerup_${def.type}`, { def, position: pos, active: false, respawnAt: 0 })
      spawnPowerup(def, pos)
    })
  }

  function isTargetable(target) {
    if (!target || !target.state) return false
    if (respawning.has(target.id)) return false
    if ((invuln.get(target.id) ?? 0) > Date.now()) return false
    return (target.state.health ?? config.health) > 0
  }

  function applyKill(shooterId, targetId, damage, headshot) {
    const stats = addStat(shooterId, { kills: 1, damage })
    addStat(targetId, { deaths: 1 })
    persistStat(shooterId)
    persistStat(targetId)
    respawning.set(targetId, { respawnAt: Date.now() + config.respawnTime * 1000, killer: shooterId })
    const now = Date.now()
    const prev = killStreaks.get(shooterId)
    const streak = (prev && now - prev.at < 3000) ? prev.streak + 1 : 1
    killStreaks.set(shooterId, { streak, at: now })
    const killerName = ctx.players.getById(shooterId)?.name || 'Player'
    ctx.network.broadcast({ type: 'death', victim: targetId, killer: shooterId, killerName, headshot, streak, killerKills: stats.kills })
    if (spec.onKill) spec.onKill(ctx, { shooterId, targetId, damage, headshot, streak, stats })
  }

  function fire(msg) {
    const shooterId = msg.shooterId
    const direction = ctx.combat.normalizeShotDirection(msg.direction)
    if (!direction) return
    if (reloading.has(shooterId)) return
    if ((ammo.get(shooterId) ?? 0) <= 0) { ctx.players.send(shooterId, { type: 'empty_click' }); return }
    ammo.set(shooterId, (ammo.get(shooterId) ?? 0) - 1)
    const shooter = ctx.players.getById(shooterId)
    const pos = shooter?.state?.position || [0, 0, 0]
    const { origin, viewTick } = ctx.combat.resolveFireRequest(ctx.lagCompensator, shooterId, pos, msg)
    if (shooter?.state) {
      shooter.state.velocity[0] -= direction[0] * config.shootKnockback
      shooter.state.velocity[2] -= direction[2] * config.shootKnockback
    }
    ctx.players.send(shooterId, { type: 'aimpunch', intensity: 0.3 })
    const players = ctx.players.getAll()
    const tick = ctx.time.tick
    if (rewindTick !== tick || !rewindIndex) { rewindIndex = ctx.combat.buildLiveIndex(players); rewindTick = tick }
    const buff = buffs.get(shooterId)
    const baseDamage = Math.round(config.damagePerHit * (buff ? buff.damage : 1))
    const shot = { shooterId, origin, direction, viewTick, range: config.range, lagComp: ctx.lagCompensator, isTargetable }
    const found = ctx.combat.findHitSpatial(players, shot, rewindIndex)
    if (!found) {
      const r = ctx.raycast(origin, direction, config.range, null)
      if (r?.hit && r.position) {
        if (r.entityId != null) ctx.world.sendToEntity(r.entityId, { type: 'damage', amount: baseDamage, shooterId })
        ctx.network.broadcast({ type: 'world_hit', shooter: shooterId, pos: r.position, normal: r.normal || null })
        if (spec.onWorldHit) spec.onWorldHit(ctx, { shooterId, position: r.position })
      }
      return
    }
    const { target, tp, rewound, proj } = found
    const hitbox = ctx.combat.DEFAULT_HITBOX
    const hitRatio = ctx.combat.hitHeightRatio(proj, tp)
    const headshot = hitRatio >= config.headshotZone
    const damage = headshot ? Math.round(baseDamage * config.headshotMultiplier) : baseDamage
    const newHp = Math.max(0, (target.state.health ?? config.health) - damage)
    target.state.health = newHp
    ctx.eventLog?.record('hit_registered', {
      attackerId: shooterId, targetId: target.id, damage, headshot, lethal: newHp <= 0, resultHealth: newHp,
      rewound: !!rewound, viewTick, rewoundTicks: viewTick != null && ctx.lagCompensator ? ctx.lagCompensator.latestTick - viewTick : 0,
      hitPosition: proj, targetPosition: tp,
      hitbox: { radiusSq: hitbox.radiusSq, heightOffset: hitbox.centerHeight, headshotRatio: config.headshotZone, hitRatio },
      shotOrigin: origin, shotDirection: direction
    }, { actor: shooterId, sourceEntity: target.id, reason: 'weapon_fire' })
    ctx.combat.recordHit(ctx.eventLog, shooterId, { headshot, timestampMs: Date.now(), targetId: target.id })
    target.state.velocity[0] += direction[0] * config.hitKnockback
    target.state.velocity[2] += direction[2] * config.hitKnockback
    ctx.players.send(target.id, { type: 'aimpunch', intensity: headshot ? 0.8 : 0.6 })
    ctx.network.broadcast({ type: 'hit', shooter: shooterId, target: target.id, damage, health: newHp, headshot, pos: proj, dir: direction, knockback: config.hitKnockback })
    if (spec.onHit) spec.onHit(ctx, { shooterId, target, damage, headshot, health: newHp })
    if (newHp <= 0) applyKill(shooterId, target.id, damage, headshot)
    else { addStat(shooterId, { damage }); persistStat(shooterId) }
  }

  function respawn(pid) {
    const sp = ctx.pickSpawnPoint(spawnPoints, { exclude: p => respawning.has(p.id) })
    const player = ctx.players.getById(pid)
    if (player?.state) {
      player.state.health = config.health
      player.state.velocity = [0, 0, 0]
      ctx.players.setPosition(pid, sp)
    }
    invuln.set(pid, Date.now() + config.spawnInvulnMs)
    ammo.set(pid, config.magazineSize)
    reloading.delete(pid)
    ctx.players.send(pid, { type: 'respawn', position: sp, health: config.health, ammo: config.magazineSize, invulnMs: config.spawnInvulnMs })
    respawning.delete(pid)
    if (spec.onRespawn) spec.onRespawn(ctx, { playerId: pid, position: sp })
  }

  function killByFall(player) {
    player.state.health = 0
    respawning.set(player.id, { respawnAt: Date.now() + config.respawnTime * 1000, killer: null })
    ctx.network.broadcast({ type: 'death', victim: player.id, killer: null, cause: 'fall' })
    fallTimers.delete(player.id)
    if (spec.onDeath) spec.onDeath(ctx, { playerId: player.id, cause: 'fall' })
  }

  return {
    config,
    spawnPoints,
    statsOf(id) { return { ...statOf(id) } },
    ammoOf(id) { return ammo.get(id) ?? 0 },
    isRespawning(id) { return respawning.has(id) },
    buffOf(id) { return buffs.get(id) || null },

    async setup() {
      await scoreboard.ready
      placePowerups()
      console.log(`[combat] ${spawnPoints.length} spawn point(s), ${Object.keys(scoreboard.value).length} saved record(s)`)
    },

    tick(dt) {
      const now = Date.now()
      for (const [pid, buff] of buffs) {
        if (now >= buff.expiresAt) { buffs.delete(pid); ctx.players.send(pid, { type: 'buff_expired' }); continue }
        const player = ctx.players.getById(pid)
        if (player?.state) player.state.health = Math.min(config.health, (player.state.health ?? config.health) + config.health * config.buffRegenFractionPerSec * dt)
      }
      const allPlayers = ctx.players.getAll()
      for (const player of allPlayers) {
        if (!player.state || respawning.has(player.id)) continue
        if ((player.state.health ?? config.health) <= 0) continue
        const pos = player.state.position
        if (pos && pos[1] < ctx.fallFloorY(pos[0], pos[2], config.fallKillDepth)) {
          const t = (fallTimers.get(player.id) || 0) + dt
          fallTimers.set(player.id, t)
          if (t >= config.fallKillGraceSec) killByFall(player)
        } else fallTimers.delete(player.id)
      }
      for (const [id, pu] of powerupState) {
        if (pu.active) {
          for (const player of allPlayers) {
            if (!isTargetable(player)) continue
            const pp = player.state.position
            if (!pp) continue
            const dx = pp[0] - pu.position[0], dy = pp[1] - pu.position[1], dz = pp[2] - pu.position[2]
            if (dx * dx + dy * dy + dz * dz > POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) continue
            const b = pu.def.buff
            buffs.set(player.id, { expiresAt: now + b.duration * 1000, speed: b.speedMultiplier, fireRate: b.fireRateMultiplier, damage: b.damageMultiplier })
            ctx.players.send(player.id, { type: 'buff_applied', duration: b.duration, speed: b.speedMultiplier, fireRate: b.fireRateMultiplier, damage: b.damageMultiplier })
            despawnPowerup(id)
            pu.active = false
            pu.respawnAt = now + (pu.def.respawnMs ?? spec.powerupRespawnMs ?? 15000)
            if (spec.onPowerup) spec.onPowerup(ctx, { playerId: player.id, def: pu.def })
            break
          }
        } else if (now >= pu.respawnAt) {
          spawnPowerup(pu.def, pu.position)
        }
      }
      for (const [pid, reload] of reloading) {
        if (now < reload.at) continue
        ammo.set(pid, config.magazineSize)
        reloading.delete(pid)
        ctx.players.send(pid, { type: 'reload_complete', ammo: config.magazineSize })
      }
      for (const [pid, data] of [...respawning]) if (now >= data.respawnAt) respawn(pid)
    },

    handle(msg) {
      if (!msg) return false
      const playerId = msg.senderId ?? msg.playerId
      if (msg.type === 'player_join') {
        const p = ctx.players.getById(msg.playerId)
        if (p?.state && !msg.reconnected) p.state.health = config.health
        if (!msg.reconnected || !playerStats.has(msg.playerId)) {
          const saved = scoreboard.value[statsKeyOf(msg.playerId)]
          const restored = v => (Number.isFinite(v) ? v : 0)
          playerStats.set(msg.playerId, { kills: restored(saved?.kills), deaths: restored(saved?.deaths), damage: restored(saved?.damage) })
        }
        ammo.set(msg.playerId, config.magazineSize)
        reloading.delete(msg.playerId)
        return true
      }
      if (msg.type === 'player_leave') {
        persistStat(msg.playerId)
        playerStats.delete(msg.playerId); respawning.delete(msg.playerId)
        fallTimers.delete(msg.playerId); ammo.delete(msg.playerId); reloading.delete(msg.playerId); invuln.delete(msg.playerId)
        return true
      }
      if (msg.type === 'player_teleport' && msg.senderId === undefined) {
        fallTimers.delete(msg.playerId)
        if (respawning.delete(msg.playerId)) { const p = ctx.players.getById(msg.playerId); if (p?.state) p.state.health = config.health }
        return true
      }
      if (msg.type === 'reload') {
        if (reloading.has(playerId)) return true
        if ((ammo.get(playerId) ?? 0) >= config.magazineSize) return true
        reloading.set(playerId, { at: Date.now() + config.reloadTime })
        ctx.players.send(playerId, { type: 'reload_start', duration: config.reloadTime })
        return true
      }
      if (msg.type === 'fire') { fire({ ...msg, shooterId: msg.senderId ?? msg.shooterId }); return true }
      return false
    },

    async flush() { await scoreboard.flush() }
  }
}

export default defineCombat
