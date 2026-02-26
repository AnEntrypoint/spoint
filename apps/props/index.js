export default {
  server: {
    async setup(ctx) {
      ctx.physics.setStatic(true)
      if (ctx.entity.model) {
        try {
          await ctx.physics.addConvexFromModel(0)
        } catch (e) {
          ctx.physics.addBoxCollider(1, 1, 1)
        }
      }
    }
  },
  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        scale: ctx.entity.scale,
        model: ctx.entity.model
      }
    }
  }
}
