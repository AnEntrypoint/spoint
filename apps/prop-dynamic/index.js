export default {
  server: {
    async setup(ctx) {
      ctx.physics.setDynamic(true)
      ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
