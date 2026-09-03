export default {
  server: {
    setup(ctx) {
      if (ctx.entity.model) ctx.physics.addColliderFromConfig({ type: 'convex' })
    }
  }
}
