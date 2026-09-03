// A placeable POWERUP PICKUP: a maker drops it, picks a kind (speed/rapid/damage/heal) + strength. On walk-over
// it emits a buff event (the game's per-player buff/stat system listens on the channel) and respawns after a
// delay. Distinct from apps/collectible (which awards score); this grants a temporary ability. Uses definePickup.
import { definePickup } from '../_lib/pickup.js'

export default {
  description: 'Powerup pickup: a player walking into it gains a timed effect (speed/rapid/damage/etc.).',
  server: {
    editorProps: [
      { key: 'kind', label: 'Kind', type: 'select', options: ['speed', 'rapid', 'damage', 'heal', 'shield'], default: 'speed' },
      { key: 'strength', label: 'Strength', type: 'range', min: 0.1, max: 5, step: 0.1, default: 1.5 },
      { key: 'durationMs', label: 'Duration (ms)', type: 'number', default: 8000 },
      { key: 'channel', label: 'Buff channel', type: 'text', default: 'powerup.pickup' },
      { key: 'color', label: 'Color', type: 'color', default: '#40b0ff' },
      { key: 'radius', label: 'Pickup radius', type: 'range', min: 0.5, max: 6, step: 0.5, default: 1.5 },
      { key: 'respawnMs', label: 'Respawn delay (ms)', type: 'number', default: 12000 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'capsule', color: c.color ?? '#40b0ff', sx: 0.4, sy: 0.6, sz: 0.4 }
      const build = (cfg) => definePickup({
        radius: cfg.radius ?? 1.5,
        cooldown: cfg.respawnMs ?? 12000,
        onCollect: (c2, player) => {
          c2.bus.emit(cfg.channel || 'powerup.pickup', {
            by: player?.id ?? null, source: c2.entity.id,
            kind: cfg.kind ?? 'speed', strength: cfg.strength ?? 1.5, durationMs: cfg.durationMs ?? 8000,
          })
        },
      }, ctx)
      ctx.state._pickup = build(c)
      ctx.onConfigChange?.((cfg) => { ctx.state._pickup = build(cfg) })
    },
    update(ctx, dt) {
      ctx.state._pickup?.tick(dt)
    },
  },
}
