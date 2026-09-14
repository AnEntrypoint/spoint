export default {
  description: 'Shrinking storm zone: an authored battle-royale safe circle that closes over time and hurts stragglers.',
  server: {
    editorProps: [
      { key: 'startRadius', label: 'Start radius', type: 'range', min: 5, max: 500, step: 5, default: 120 },
      { key: 'endRadius', label: 'Final radius', type: 'range', min: 1, max: 100, step: 1, default: 8 },
      { key: 'shrinkSeconds', label: 'Shrink time (s)', type: 'range', min: 5, max: 600, step: 5, default: 120 },
      { key: 'startDelaySeconds', label: 'Start delay (s)', type: 'range', min: 0, max: 120, step: 1, default: 10 },
      { key: 'damagePerSec', label: 'Out-of-bounds dmg/s', type: 'range', min: 0, max: 50, step: 1, default: 5 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const build = (cfg) => ctx.defineShrinkingZone({
        center: [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]],
        curve: 'linear',
        startRadius: cfg.startRadius ?? 120,
        endRadius: cfg.endRadius ?? 8,
        durationSec: cfg.shrinkSeconds ?? 120,
        startDelaySec: cfg.startDelaySeconds ?? 10,
        damagePerSec: cfg.damagePerSec ?? 5,
        showRing: true,
      })
      ctx.state.zone = build(c)
      ctx.onConfigChange?.((cfg) => { ctx.state.zone = build(cfg) })
    },
    update(ctx, dt) { ctx.state.zone?.tick(dt) },
  },
}
