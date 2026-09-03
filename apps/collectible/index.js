// A placeable COLLECTIBLE (coin/star/gem): a maker drops it, sets its value + whether it respawns. When a player
// walks into it, it awards `value` (emitted as a collected event the game's score system listens for), hides,
// and optionally respawns after a cooldown. Uses definePickup's overlap scan -- the standard "walk over to grab"
// primitive every platformer/collectathon needs, authorable with zero code.
import { definePickup } from '../_lib/pickup.js'

export default {
  description: 'Collectible (coin/star/gem): a player walking into it collects it and fires a value event.',
  server: {
    editorProps: [
      { key: 'value', label: 'Value', type: 'number', default: 1 },
      { key: 'channel', label: 'Score channel', type: 'text', default: 'collectible.collect' },
      { key: 'color', label: 'Color', type: 'color', default: '#ffd700' },
      { key: 'radius', label: 'Pickup radius', type: 'range', min: 0.5, max: 6, step: 0.5, default: 1.5 },
      { key: 'respawns', label: 'Respawns', type: 'checkbox', default: false },
      { key: 'respawnMs', label: 'Respawn delay (ms)', type: 'number', default: 5000 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'sphere', color: c.color ?? '#ffd700', sx: 0.4, sy: 0.4, sz: 0.4 }
      const build = (cfg) => definePickup({
        radius: cfg.radius ?? 1.5,
        oneShot: !cfg.respawns,
        cooldown: cfg.respawns ? (cfg.respawnMs ?? 5000) : 0,
        onCollect: (c2, player) => {
          c2.bus.emit(cfg.channel || 'collectible.collect', { by: player?.id ?? null, source: c2.entity.id, value: cfg.value ?? 1 })
          // Hide/show for the respawn cycle: toggle a custom flag the client reads (or destroy if one-shot).
          if (!cfg.respawns) { if (c2.entity.custom) c2.entity.custom._collected = true }
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
