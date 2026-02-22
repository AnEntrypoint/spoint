export default {
  server: {
    setup(ctx) {
      const c = ctx.config
      if (c.color !== undefined) {
        ctx.entity.custom = {
          mesh: 'box',
          color: c.color,
          roughness: c.roughness ?? 0.9,
          sx: (c.hx ?? 1) * 2,
          sy: (c.hy ?? 1) * 2,
          sz: (c.hz ?? 1) * 2
        }
      }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([c.hx ?? 1, c.hy ?? 1, c.hz ?? 1])
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
