export default {
  description: 'Capture/control zone: players standing in it accrue capture progress (KotH/domination/hardpoint).',
  server: {
    editorProps: [
      { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 40, step: 0.5, default: 6 },
      { key: 'captureSeconds', label: 'Capture time (s)', type: 'range', min: 1, max: 60, step: 1, default: 8 },
      { key: 'decay', label: 'Decays when empty', type: 'checkbox', default: true },
      { key: 'channel', label: 'Event channel', type: 'text', default: 'capture' },
      { key: 'color', label: 'Color', type: 'color', default: '#33cc88' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'cylinder', color: c.color ?? '#33cc88', _captureZone: true, sx: (c.radius ?? 6) * 2, sy: 0.2, sz: (c.radius ?? 6) * 2 }
      ctx.state.progress = ctx.state.progress || 0
      ctx.state.owned = ctx.state.owned || false
      ctx.onConfigChange?.((cfg) => { ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color })
    },
    update(ctx, dt) {
      const c = ctx.config || {}
      const radius = c.radius ?? 6, radius2 = radius * radius
      const captureSeconds = Math.max(0.1, c.captureSeconds ?? 8)
      const pos = ctx.entity.position
      const occupants = []
      for (const p of ctx.players.getAll()) {
        const pp = p.state?.position; if (!pp) continue
        const dx = pp[0]-pos[0], dy = pp[1]-pos[1], dz = pp[2]-pos[2]
        if (dx*dx + dy*dy + dz*dz <= radius2) occupants.push(p.id)
      }
      const rate = dt / captureSeconds
      if (occupants.length > 0) {
        ctx.state.progress = Math.min(1, ctx.state.progress + rate)
      } else if (c.decay !== false) {
        ctx.state.progress = Math.max(0, ctx.state.progress - rate)
      }
      const channel = c.channel || 'capture'
      if (ctx.state.progress >= 1 && !ctx.state.owned) {
        ctx.state.owned = true
        ctx.bus.emit(channel + '.owned', { zone: ctx.entity.id, occupants })
      } else if (ctx.state.progress < 1 && ctx.state.owned) {
        ctx.state.owned = false
        ctx.bus.emit(channel + '.lost', { zone: ctx.entity.id })
      }
      const wholePercent = Math.round(ctx.state.progress * 100)
      if (wholePercent !== ctx.state._lastPct) { ctx.state._lastPct = wholePercent; ctx.bus.emit(channel + '.progress', { zone: ctx.entity.id, progress: ctx.state.progress, occupants }) }
    },
  },
}
