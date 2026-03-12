export default {
  server: {
    setup(ctx) {
      const c = ctx.config
      const hx = c.hx ?? 1, hy = c.hy ?? 1, hz = c.hz ?? 1
      if (c.color !== undefined) ctx.entity.custom = { mesh: 'box', color: c.color, roughness: c.roughness ?? 0.9, sx: hx*2, sy: hy*2, sz: hz*2 }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz] })
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
