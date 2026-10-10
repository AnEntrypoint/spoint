export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        itemType: 'gold-coin',
        collected: false,
        mesh: 'sphere',
        color: 0xffd700,
        r: 0.3,
        spin: 3
      }

      ctx.physics.addColliderFromConfig({
        type: 'sphere',
        radius: 0.3
      })

      ctx.time.every(0.1, () => {
        if (ctx.entity.custom.collected) return

        const collector = ctx.players.getAll().find(player => {
          const dist = Math.hypot(
            player.state.position[0] - ctx.entity.position[0],
            player.state.position[2] - ctx.entity.position[2]
          )
          return dist < 2
        })
        if (!collector) return

        ctx.entity.custom.collected = true
        ctx.bus.emit('gold-coin-collected', {
          playerId: collector.id,
          coin: ctx.entity.id
        })
        ctx.entity.destroy()
      })
    },

    update(ctx, dt) {}
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: {
          mesh: 'sphere',
          color: 0xffd700,
          r: 0.3,
          spin: 3,
          glow: true,
          glowColor: 0xffed4e,
          glowIntensity: 0.8
        }
      }
    }
  }
}
