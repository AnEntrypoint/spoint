export default {
  server: {
    setup(ctx) {
      ctx.physics.setDynamic(true)
      try {
        ctx.physics.addConvexFromModel(0)
      } catch (e) {
        ctx.physics.addBoxCollider([1, 1, 1])
      }
    }
  }
}
