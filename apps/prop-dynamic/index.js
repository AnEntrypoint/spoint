export default {
  server: {
    async setup(ctx) {
      ctx.physics.setDynamic(true)
      await ctx.physics.addConvexFromModelAsync(0)
    }
  }
}
