export function collectCheckpointMarkers(ctx) {
  const marks = ctx.world.query(e => e?.custom?._deathrunCheckpoint)
  return marks
    .map(e => ({ order: e.custom.order ?? 0, position: [e.position[0], e.position[1], e.position[2]], radius: e.custom.radius ?? 3, id: e.id }))
    .sort((a, b) => a.order - b.order)
}

export default {
  description: 'Ordered deathrun/parkour checkpoint marker: order 0 is the start trigger, the highest order is the finish line.',
  server: {
    editorProps: [
      { key: 'order', label: 'Order # (0 = start)', type: 'number', default: 0 },
      { key: 'radius', label: 'Trigger radius', type: 'range', min: 0.5, max: 20, step: 0.5, default: 3 },
      { key: 'color', label: 'Color', type: 'color', default: '#33ccff' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        ...(ctx.entity.custom || {}),
        mesh: 'cylinder', color: c.color ?? '#33ccff',
        _deathrunCheckpoint: true, order: c.order ?? 0, radius: c.radius ?? 3,
        sx: (c.radius ?? 3) * 2, sy: 0.3, sz: (c.radius ?? 3) * 2,
      }
      ctx.onConfigChange?.((cfg) => {
        ctx.entity.custom.order = cfg.order ?? 0
        ctx.entity.custom.radius = cfg.radius ?? 3
        ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color
        ctx.entity.custom.sx = ctx.entity.custom.sz = (cfg.radius ?? 3) * 2
      })
    },
  },
}
