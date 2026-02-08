export default {
  server: {
    setup(ctx) {
      ctx.state.waypoints = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]]
      ctx.state.current = 0
      ctx.state.speed = 3
      ctx.physics.setKinematic(true)
      ctx.physics.addCapsuleCollider(0.5, 1.8)
    },
    update(ctx, dt) {
      const target = ctx.state.waypoints[ctx.state.current]
      const pos = ctx.entity.position
      const dx = target[0] - pos[0]
      const dz = target[2] - pos[2]
      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist < 0.5) {
        ctx.state.current = (ctx.state.current + 1) % ctx.state.waypoints.length
      } else {
        const step = ctx.state.speed * dt
        pos[0] += (dx / dist) * step
        pos[2] += (dz / dist) * step
        const angle = Math.atan2(dx, dz)
        ctx.entity.rotation = [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)]
      }
    }
  },
  client: {
    render(ctx) {
      return {
        model: ctx.entity.model,
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: { animation: 'walk' }
      }
    }
  }
}
