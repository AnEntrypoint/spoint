export default {
  server: {
    setup(ctx) {
      ctx.state.open = false
      ctx.state.openAngle = Math.PI / 2
      ctx.physics.setKinematic(true)
      ctx.physics.addBoxCollider([2, 3, 0.2])
    },
    update(ctx, dt) {
      const nearest = ctx.players.getNearest(ctx.entity.position, 3)
      if (nearest && !ctx.state.open) {
        ctx.state.open = true
        const rot = ctx.entity.rotation
        rot[1] = Math.sin(ctx.state.openAngle / 2)
        rot[3] = Math.cos(ctx.state.openAngle / 2)
        ctx.entity.rotation = rot
      } else if (!nearest && ctx.state.open) {
        ctx.state.open = false
        ctx.entity.rotation = [0, 0, 0, 1]
      }
    }
  },
  client: {
    render(ctx) {
      return {
        model: ctx.entity.model,
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: { doorOpen: ctx.state.open }
      }
    }
  }
}
