export default {
  server: {
    setup(ctx) {
      ctx.physics.setStatic(true)
      if (ctx.entity.model) {
        ctx.physics.addConvexFromModel(0)
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, model: ctx.entity.model, scale: ctx.entity.scale }
    }
  }
}
