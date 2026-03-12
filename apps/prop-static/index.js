export default {
  server: {
    setup(ctx) {
      if (ctx.entity.model) ctx.physics.addColliderFromConfig({ type: 'convex' })
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, model: ctx.entity.model, scale: ctx.entity.scale }
    }
  }
}
