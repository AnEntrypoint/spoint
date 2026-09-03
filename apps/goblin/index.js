export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        enemyType: 'goblin',
        health: 10,
        maxHealth: 10,
        xpValue: 30,
        isDamaged: false,
        mesh: 'box',
        color: 0x4a7c2c,
        sx: 0.6,
        sy: 1.0,
        sz: 0.6
      }

      ctx.physics.addColliderFromConfig({
        type: 'box',
        size: [0.3, 0.5, 0.3],
        mass: 5,
        dynamic: true
      })

      let moveTimer = 0
      const moveInterval = 3 + Math.random() * 2

      ctx.time.every(0.2, () => {
        moveTimer += 0.2

        const players = ctx.players.getAll()
        if (players.length === 0) return

        const targetPlayer = players[0]
        const dist = Math.hypot(
          targetPlayer.state.position[0] - ctx.entity.position[0],
          targetPlayer.state.position[2] - ctx.entity.position[2]
        )

        if (dist < 30) {
          const dx = targetPlayer.state.position[0] - ctx.entity.position[0]
          const dz = targetPlayer.state.position[2] - ctx.entity.position[2]
          const len = Math.hypot(dx, dz)
          if (len > 0.1) {
            const nx = dx / len
            const nz = dz / len
            ctx.physics.setVelocity([nx * 3, ctx.physics.getVelocity()[1], nz * 3])
          }
        } else if (moveTimer >= moveInterval) {
          moveTimer = 0
          const angle = Math.random() * Math.PI * 2
          ctx.physics.setVelocity([Math.cos(angle) * 2, ctx.physics.getVelocity()[1], Math.sin(angle) * 2])
        }
      })
    },

    update(ctx, dt) {}
  },

  client: {
    render(ctx) {
      const scale = 1.0
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: {
          mesh: 'box',
          color: ctx.entity.custom?.isDamaged ? 0xff6b6b : 0x4a7c2c,
          sx: 0.6 * scale,
          sy: 1.0 * scale,
          sz: 0.6 * scale,
          label: `Goblin\nHP: ${Math.max(0, ctx.entity.custom?.health || 10)}/10`
        }
      }
    }
  }
}
