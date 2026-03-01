export default {
  server: {
    async setup(ctx) {
      ctx.physics.setDynamic(true)
      // Use trimesh collision for accurate physics testing/profiling
      // Extracts full geometry from GLB model for precise collision detection
      try {
        await ctx.physics.addTrimeshCollider()
      } catch (e) {
        // Fallback to box collider if trimesh fails (e.g., missing model)
        ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
