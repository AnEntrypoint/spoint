import { collectSpawnPoints } from '../spawn-point/index.js'
import { POWERUP_DEFS, POWERUP_RESPAWN_MS, EMOTE_CLIPS } from './shared.js'

const EMOTE_RATE_LIMIT_MS = 800

const COMBAT_SPEC = {
  config: {
    respawnTime: 1.5,
    health: 100,
    damagePerHit: 20,
    headshotMultiplier: 2.5,
    headshotZone: 0.7,
    hitKnockback: 4,
    shootKnockback: 2,
    magazineSize: 30,
    reloadTime: 2000,
    spawnInvulnMs: 1500
  },
  powerups: POWERUP_DEFS,
  powerupRespawnMs: POWERUP_RESPAWN_MS,
  scoreboardKey: 'scoreboard'
}

const _combats = new WeakMap()

function combatOf(ctx) {
  let combat = _combats.get(ctx)
  if (combat) return combat
  const placed = collectSpawnPoints(ctx)
  combat = ctx.defineCombat(placed.length > 0 ? { ...COMBAT_SPEC, spawnPoints: placed } : COMBAT_SPEC)
  _combats.set(ctx, combat)
  return combat
}

export const tpsGameServer = {
  async setup(ctx) {
    ctx.state.map = 'schwust'
    ctx.state.mode = 'ffa'
    ctx.state.lastEmoteAt = new Map()
    const combat = combatOf(ctx)
    ctx.state.config = { ...combat.config }
    await combat.setup()
    ctx.onShutdown(() => combat.flush())
  },

  update(ctx, dt) {
    combatOf(ctx).tick(dt)
  },

  onMessage(ctx, msg) {
    if (!msg) return
    if (msg.type === 'emote') {
      const playerId = msg.senderId || msg.playerId
      const now = Date.now()
      if (now - (ctx.state.lastEmoteAt.get(playerId) || 0) < EMOTE_RATE_LIMIT_MS) return
      if (!EMOTE_CLIPS.has(msg.code)) return
      ctx.state.lastEmoteAt.set(playerId, now)
      ctx.players.playAnimation(playerId, EMOTE_CLIPS.get(msg.code), { loop: false })
      return
    }
    combatOf(ctx).handle(msg)
  }
}
