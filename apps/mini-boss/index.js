export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        enemyType: 'mini-boss',
        health: 50,
        maxHealth: 50,
        xpValue: 100,
        isDamaged: false,
        mesh: 'box',
        color: 0xff6b00,
        sx: 1.2,
        sy: 1.5,
        sz: 1.2
      }

      ctx.physics.addColliderFromConfig({
        type: 'box',
        size: [0.6, 0.75, 0.6],
        mass: 15,
        dynamic: true
      })

      let moveTimer = 0

      ctx.time.every(0.2, () => {
        moveTimer += 0.2

        const players = ctx.players.getAll()
        if (players.length === 0) return

        const targetPlayer = players[0]
        const dist = Math.hypot(
          targetPlayer.state.position[0] - ctx.entity.position[0],
          targetPlayer.state.position[2] - ctx.entity.position[2]
        )

        if (dist < 40 && dist > 5) {
          const dx = targetPlayer.state.position[0] - ctx.entity.position[0]
          const dz = targetPlayer.state.position[2] - ctx.entity.position[2]
          const len = Math.hypot(dx, dz)
          if (len > 0.1) {
            const nx = dx / len
            const nz = dz / len
            ctx.physics.setVelocity([nx * 4, ctx.physics.getVelocity()[1], nz * 4])
          }
        }
      })
    },

    update(ctx, dt) {}
  },

  client: {
    render(ctx) {
      const scale = 1.2
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: {
          mesh: 'box',
          color: ctx.entity.custom?.isDamaged ? 0xff4444 : 0xff6b00,
          sx: 1.2 * scale,
          sy: 1.5 * scale,
          sz: 1.2 * scale,
          label: `Mini-Boss\nHP: ${Math.max(0, ctx.entity.custom?.health || 50)}/50`
        }
      }
    }
  }
}
