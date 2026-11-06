export default {
  server: {
    setup(ctx) {
      ctx.world.spawn('child-1', { app: 'placed-model', position: [1, 0, 1] })
    },
    teardown(ctx) {
      ctx.world.destroy('child-1')
    },
  },
}
