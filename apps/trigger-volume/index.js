import { definePickup } from '../_lib/pickup.js'

export default {
  description: 'Invisible trigger region: fires an event at a target entity when a player enters it.',
  server: {
    editorProps: [
      { key: 'target', label: 'Target entity', type: 'entity' },
      { key: 'channel', label: 'Channel', type: 'text', default: 'trigger.enter' },
      { key: 'radius', label: 'Radius', type: 'range', min: 0.5, max: 40, step: 0.5, default: 3 },
      { key: 'once', label: 'Fire once', type: 'checkbox', default: false },
      { key: 'cooldownMs', label: 'Re-fire cooldown (ms)', type: 'number', default: 0 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), _trigger: true }
      const build = (cfg) => definePickup({
        radius: cfg.radius ?? 3,
        oneShot: !!cfg.once,
        cooldown: cfg.cooldownMs ?? 0,
        onCollect: (c2, player) => {
          const channel = cfg.channel || 'trigger.enter'
          const targets = Array.isArray(cfg.targets) ? cfg.targets.filter(t => t != null).map(String) : (cfg.target != null ? [String(cfg.target)] : [])
          c2.bus.emit(channel, { by: player?.id ?? null, source: c2.entity.id, target: targets[0] ?? null, targets })
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
