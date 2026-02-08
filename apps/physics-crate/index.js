export default {
  server: {
    setup(ctx) {
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(10)
      ctx.physics.addBoxCollider([1, 1, 1])
    },
    onCollision(ctx, other) {
      if (other.velocity > 5) {
        ctx.entity.destroy()
      }
    }
  },
  client: {
    render(ctx) {
      return {
        model: ctx.entity.model,
        position: ctx.entity.position,
        rotation: ctx.entity.rotation
      }
    }
  }
}
