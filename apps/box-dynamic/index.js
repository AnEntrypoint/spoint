export default {
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      const hx = c.hx ?? 0.5, hy = c.hy ?? 0.5, hz = c.hz ?? 0.5
      ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8B4513, roughness: c.roughness ?? 0.8, sx: hx * 2, sy: hy * 2, sz: hz * 2 }
      ctx.physics.setMass(c.mass ?? 50)
      ctx.physics.setDynamic(true)
      ctx.physics.addBoxCollider([hx, hy, hz])
    }
  }
}
