import { collectSpawnPoints } from '../../src/stdlib-apps/spawn-point/index.js'
import { POWERUP_DEFS, POWERUP_RESPAWN_MS, EMOTE_CLIPS, COMBAT_CONFIG, FIRE_SPEC } from './shared.js'
import { pickClearSpawnPose } from './respawn-clearance.js'

const EMOTE_RATE_LIMIT_MS = 800
const MAX_IGNITION_SOURCE = 255

const COMBAT_SPEC = {
  config: COMBAT_CONFIG,
  powerups: POWERUP_DEFS,
  powerupRespawnMs: POWERUP_RESPAWN_MS,
  scoreboardKey: 'scoreboard'
}

const _combats = new WeakMap()
const _fires = new WeakMap()

function fireOf(ctx) {
  let fire = _fires.get(ctx)
  if (fire !== undefined) return fire
  const cfg = ctx.config?.fire
  fire = null
  if (cfg && cfg.enabled === true) {
    const tuning = { ...cfg }
    delete tuning.enabled
    fire = ctx.defineFire({ ...FIRE_SPEC, ...tuning })
  }
  _fires.set(ctx, fire)
  return fire
}

function combatOf(ctx) {
  let combat = _combats.get(ctx)
  if (combat) return combat
  const placed = collectSpawnPoints(ctx)
  const fire = fireOf(ctx)
  const spec = fire
    ? {
      ...COMBAT_SPEC,
      shotBlocked: (c, origin, direction, distance) => fire.rayBlocked(origin, direction, distance),
      onWorldHit: (c, { shooterId, position }) => fire.ignite(position, shooterId & MAX_IGNITION_SOURCE),
    }
    : COMBAT_SPEC
  combat = ctx.defineCombat(placed.length > 0 ? { ...spec, spawnPoints: placed } : spec)
  _combats.set(ctx, combat)
  return combat
}

export const tpsGameServer = {
  async setup(ctx) {
    ctx.pickSpawnPoint = (spawnPoints, opts) => pickClearSpawnPose(ctx, spawnPoints, opts)
    ctx.state.map = 'schwust'
    ctx.state.mode = 'ffa'
    ctx.state.lastEmoteAt = new Map()
    const combat = combatOf(ctx)
    await combat.setup()
    ctx.onShutdown(async () => { await combat.flush() })
  },

  update(ctx, dt) {
    combatOf(ctx).tick(dt)
    const fire = fireOf(ctx)
    if (fire) fire.tick(dt)
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
