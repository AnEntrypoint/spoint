export default {
  description: 'Moving platform: a kinematic platform that ping-pongs along a travel offset over a set period.',
  server: {
    bodyType: 'kinematic',
    editorProps: [
      { key: 'offset', label: 'Travel (x,y,z)', type: 'vec3', default: [0, 3, 0] },
      { key: 'period', label: 'Period (s)', type: 'range', min: 0.5, max: 30, step: 0.5, default: 4 },
      { key: 'color', label: 'Color', type: 'color', default: '#8899aa' },
      { key: 'sx', label: 'Width', type: 'number', default: 3 },
      { key: 'sz', label: 'Depth', type: 'number', default: 3 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#8899aa', sx: c.sx ?? 3, sy: 0.4, sz: c.sz ?? 3 }
      ctx.state._start = [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]]
      ctx.state._t = 0
    },
    update(ctx, dt) {
      const c = ctx.config || {}
      const offset = Array.isArray(c.offset) ? c.offset : [0, 3, 0]
      const period = (typeof c.period === 'number' && c.period > 0) ? c.period : 4
      ctx.state._t += dt
      const phase = (ctx.state._t % period) / period
      const pingPong = phase < 0.5 ? phase * 2 : (1 - phase) * 2
      const s = ctx.state._start
      ctx.world.setPosition(ctx.entity.id, [s[0] + offset[0] * pingPong, s[1] + offset[1] * pingPong, s[2] + offset[2] * pingPong])
    },
  },
}
