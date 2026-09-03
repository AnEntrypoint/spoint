export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        tower: true,
        mesh: 'cylinder',
        color: 0x8b7355,
        r: 3,
        h: 15
      }

      ctx.physics.addColliderFromConfig({
        type: 'cylinder',
        radius: 3,
        height: 15
      })
    },

    update(ctx, dt) {
      const players = ctx.players.getAll()
      players.forEach(p => {
        const dist = Math.hypot(
          p.state.position[0] - ctx.entity.position[0],
          p.state.position[2] - ctx.entity.position[2]
        )
        if (dist < 10) {
          ctx.bus.emit('player-near-tower', { playerId: p.id })
        }
      })
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: {
          mesh: 'cylinder',
          color: 0x8b7355,
          r: 3,
          h: 15,
          label: 'The Tower'
        }
      }
    }
  }
}
