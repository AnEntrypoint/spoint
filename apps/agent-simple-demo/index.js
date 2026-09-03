export default {
  description: 'A simple static entity with basic setup.',
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        mesh: 'box',
        color: 0x00ff00,
        sx: 1,
        sy: 1,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.5, 0.5, 0.5] })
    },

    update(ctx, dt) {
      ctx.debug?.log?.('TODO: Add your update logic here')
    },

    teardown(ctx) {
      ctx.debug?.log?.('TODO: Cleanup resources if needed')
    }
  },

  client: {
    setup(engine) {
      this.data = { rotation: 0 }
    },

    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}