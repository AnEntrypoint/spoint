export default {
  server: {
    setup(ctx) {
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([1, 1, 1])
    },
  },
}
