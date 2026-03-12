// Generic prop with convex hull collider
export default {
  server: {
    setup(ctx) {
      if (ctx.entity.model) ctx.physics.addColliderFromConfig({ type: 'convex' })
    },
    onEditorUpdate(ctx, changes) {
      if (changes.position) ctx.entity.position = changes.position
      if (changes.rotation) ctx.entity.rotation = changes.rotation
      if (changes.scale) ctx.entity.scale = changes.scale
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
