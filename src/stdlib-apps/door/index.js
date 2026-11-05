const DEG = Math.PI / 180

export function leafAngle(t, { swing, hold, open }) {
  const cycle = 2 * (swing + hold)
  const p = ((t % cycle) + cycle) % cycle
  if (p < hold) return 0
  if (p < hold + swing) return open * (p - hold) / swing
  if (p < 2 * hold + swing) return open
  return open * (1 - (p - 2 * hold - swing) / swing)
}

export default {
  description: 'Door: a kinematic leaf that swings about a vertical hinge between a closed and an open stop, holding at each.',
  server: {
    bodyType: 'kinematic',
    editorProps: [
      { key: 'openAngle', label: 'Open angle (deg)', type: 'range', min: 10, max: 180, step: 5, default: 90 },
      { key: 'swing', label: 'Swing time (s)', type: 'range', min: 0.2, max: 20, step: 0.1, default: 1.5 },
      { key: 'hold', label: 'Hold at stops (s)', type: 'range', min: 0, max: 30, step: 0.5, default: 3 },
      { key: 'color', label: 'Color', type: 'color', default: '#7a6a55' },
      { key: 'sx', label: 'Width', type: 'number', default: 1 },
      { key: 'sy', label: 'Height', type: 'number', default: 2.2 },
      { key: 'sz', label: 'Thickness', type: 'number', default: 0.12 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const sx = c.sx ?? 1
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#7a6a55', sx, sy: c.sy ?? 2.2, sz: c.sz ?? 0.12 }
      const [px, py, pz] = ctx.entity.position
      ctx.state._hinge = [px - sx / 2, py, pz]
      ctx.state._t = 0
    },
    onChartReanchor(ctx, { transfer }) {
      transfer.point(ctx.state._hinge, ctx.state._hinge)
    },
    update(ctx, dt) {
      const c = ctx.config || {}
      const swing = typeof c.swing === 'number' && c.swing > 0 ? c.swing : 1.5
      const hold = typeof c.hold === 'number' && c.hold >= 0 ? c.hold : 3
      const open = (typeof c.openAngle === 'number' ? c.openAngle : 90) * DEG
      ctx.state._t += dt
      const a = leafAngle(ctx.state._t, { swing, hold, open })
      const half = (c.sx ?? 1) / 2
      const h = ctx.state._hinge
      const pos = [h[0] + half * Math.cos(a), h[1], h[2] - half * Math.sin(a)]
      ctx.world.setPosition(ctx.entity.id, pos, [0, Math.sin(a / 2), 0, Math.cos(a / 2)])
    },
  },
}
