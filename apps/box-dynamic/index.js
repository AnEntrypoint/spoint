// Dynamic physics box — falls, bounces, and slides
export default {
  server: {
    editorProps: [
      { key: 'hx', label: 'Width/2', type: 'number', default: 0.5 },
      { key: 'hy', label: 'Height/2', type: 'number', default: 0.5 },
      { key: 'hz', label: 'Depth/2', type: 'number', default: 0.5 },
      { key: 'mass', label: 'Mass (kg)', type: 'number', default: 50 },
      { key: 'color', label: 'Color', type: 'color', default: '#8B4513' },
      { key: 'roughness', label: 'Roughness', type: 'number', default: 0.8 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const hx = c.hx ?? 0.5, hy = c.hy ?? 0.5, hz = c.hz ?? 0.5
      ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8B4513, roughness: c.roughness ?? 0.8, sx: hx*2, sy: hy*2, sz: hz*2 }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass: c.mass ?? 50, dynamic: true })
    }
  }
}
