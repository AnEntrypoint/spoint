export default {
  server: {
    async setup(ctx) {
      ctx.physics.setDynamic(true)
      // Use trimesh collision for accurate physics testing/profiling
      // Extracts full geometry from GLB model for precise collision detection
      try {
        await ctx.physics.addTrimeshCollider()
      } catch (e) {
        console.warn(`[prop-dynamic] Trimesh failed for ${ctx.entity.id}: ${e.message}, using box collider`)
        // Fallback to box collider if trimesh fails (e.g., missing model or Draco issues)
        ctx.physics.addBoxCollider(2, 2, 2)  // larger box to contain most props
      }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
