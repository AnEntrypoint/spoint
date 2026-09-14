const DRIFT_UNITS_PER_SEC = 0.2
export default {
  server: {
    setup(ctx) {
      ctx.entity.bodyType = 'dynamic'
      ctx.entity.custom = { mesh: 'box', color: 0x00ff00, sx: 1, sy: 1, sz: 1 }
      ctx._startY = ctx.entity.position[1]
      ctx._t = 0
    },
    update(ctx, dt) {
      ctx._t += dt
      ctx.entity.position[1] = ctx._startY - ctx._t * DRIFT_UNITS_PER_SEC
    }
  }
}
