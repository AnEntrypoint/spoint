export default {
  server: {
    async setup(ctx) {
      ctx.physics.setMass(30)
      ctx.physics.setDynamic(true)
      await ctx.physics.addConvexFromModelAsync(0)
    }
  }
}
