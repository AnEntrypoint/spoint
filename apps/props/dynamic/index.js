export default {
  server: {
    async setup(ctx) {
      ctx.physics.setDynamic(true)
      if (ctx.entity.model) {
        try {
          await ctx.physics.addConvexFromModel(0)
        } catch (e) {
          ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
        }
      } else {
        ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
