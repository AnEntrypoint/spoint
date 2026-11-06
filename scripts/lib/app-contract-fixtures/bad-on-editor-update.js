export default {
  server: {
    setup(ctx) {
      ctx.physics.addColliderFromConfig({ type: 'box', size: [1, 1, 1] })
    },
    onEditorUpdate(ctx, changes) {
      ctx.entity.position = changes.position
    },
  },
}
