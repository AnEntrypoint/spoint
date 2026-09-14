export default {
  server: {
    editorProps: [
      { key: 'hx', label: 'Width/2', type: 'number', default: 1 },
      { key: 'hy', label: 'Height/2', type: 'number', default: 1 },
      { key: 'hz', label: 'Depth/2', type: 'number', default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#888888' },
      { key: 'roughness', label: 'Roughness', type: 'number', default: 0.9 },
      { key: '_wetness', label: 'Wetness', type: 'range', min: 0, max: 1, step: 0.05, default: 0 }
    ],
    setup(ctx) {
      const c = ctx.config
      const hx = c.hx ?? 1, hy = c.hy ?? 1, hz = c.hz ?? 1
      if (c.color !== undefined) ctx.entity.custom = { mesh: 'box', color: c.color, roughness: c.roughness ?? 0.9, sx: hx*2, sy: hy*2, sz: hz*2 }
      if (c._wetness !== undefined) { if (!ctx.entity.custom) ctx.entity.custom = {}; ctx.entity.custom._wetness = c._wetness }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz] })
    }
  }
}
