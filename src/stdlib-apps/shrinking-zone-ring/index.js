const UNIT_DISC_RADIUS = 0.5
export default {
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      const h = c.h ?? 0.2, color = c.color ?? 0x00ffff
      ctx.entity.custom = { mesh: 'cylinder', color, roughness: 0.4, r: UNIT_DISC_RADIUS, h }
      const initialR = c.r ?? 50
      ctx.entity.scale = [initialR / UNIT_DISC_RADIUS, 1, initialR / UNIT_DISC_RADIUS]
    }
  }
}
