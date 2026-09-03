export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = {
        enemyType: 'final-boss',
        health: 200,
        maxHealth: 200,
        xpValue: 150,
        isDamaged: false,
        mesh: 'box',
        color: 0x8b008b,
        sx: 1.5,
        sy: 2.0,
        sz: 1.5,
        requiresLevel: 10
      }

      ctx.physics.addColliderFromConfig({
        type: 'box',
        size: [0.75, 1.0, 0.75],
        mass: 30,
        dynamic: true
      })

      let moveTimer = 0
      let attackTimer = 0

      ctx.time.every(0.2, () => {
        moveTimer += 0.2
        attackTimer += 0.2

        const players = ctx.players.getAll()
        if (players.length === 0) return

        const targetPlayer = players[0]
        const ps = ctx.state.players?.get(targetPlayer.id)

        if (ps && ps.level < 10) {
          ctx.physics.setVelocity([0, ctx.physics.getVelocity()[1], 0])
          return
        }

        const dist = Math.hypot(
          targetPlayer.state.position[0] - ctx.entity.position[0],
          targetPlayer.state.position[2] - ctx.entity.position[2]
        )

        if (dist < 50 && dist > 8) {
          const dx = targetPlayer.state.position[0] - ctx.entity.position[0]
          const dz = targetPlayer.state.position[2] - ctx.entity.position[2]
          const len = Math.hypot(dx, dz)
          if (len > 0.1) {
            const nx = dx / len
            const nz = dz / len
            ctx.physics.setVelocity([nx * 5, ctx.physics.getVelocity()[1], nz * 5])
          }
        } else if (dist < 8) {
          ctx.physics.setVelocity([0, ctx.physics.getVelocity()[1], 0])

          if (attackTimer >= 2) {
            attackTimer = 0
            targetPlayer.state.health = Math.max(0, targetPlayer.state.health - 15)
            ctx.bus.emit('boss-attack', { damage: 15 })
          }
        }
      })
    },

    update(ctx, dt) {}
  },

  client: {
    render(ctx) {
      const scale = 1.5
      const health = Math.max(0, ctx.entity.custom?.health || 200)
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: {
          mesh: 'box',
          color: ctx.entity.custom?.isDamaged ? 0xff0000 : 0x8b008b,
          sx: 1.5 * scale,
          sy: 2.0 * scale,
          sz: 1.5 * scale,
          glow: health < 100,
          glowColor: 0xff0000,
          glowIntensity: 0.6,
          label: `FINAL BOSS\nHP: ${health}/200`
        }
      }
    }
  }
}
