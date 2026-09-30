export default {
  description: 'Visual body of one lockstep-rts unit; the lockstep-rts controller owns its position every tick.',
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      const size = c.size ?? 0.7
      ctx.entity.custom = { mesh: 'box', color: c.color ?? '#cccccc', roughness: 0.6, sx: size, sy: size, sz: size }
    }
  }
}
