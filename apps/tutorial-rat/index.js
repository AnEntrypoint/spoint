// Tutorial Rat: basic enemy that grants XP and quest progress on kill

export const server = {
  setup(ctx) {
    ctx.state = {
      health: 10,
      maxHealth: 10,
      alive: true,
    }

    ctx.physics.setBodyType('dynamic')
    ctx.physics.setMass(5)
  },

  tick(ctx, dt) {
    if (!ctx.state.alive) return

    // Simple AI: wander around
    const vel = ctx.entity.velocity
    if (Math.random() < 0.02) {
      const angle = Math.random() * Math.PI * 2
      const speed = 5
      ctx.physics.setVelocity([Math.cos(angle) * speed, vel[1], Math.sin(angle) * speed])
    }
  },

  onMessage(ctx, msg) {
    if (msg.type === 'damage') {
      if (!ctx.state.alive) return

      ctx.state.health = Math.max(0, ctx.state.health - (msg.amount || 5))

      if (ctx.state.health <= 0) {
        ctx.state.alive = false
        ctx.entity.destroy()

        // Notify quest system
        ctx.world.sendToEntity('tutorial-world', {
          type: 'ratKilled',
          playerId: msg.playerId,
        })
      }
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialRat] Spawned')
  },
}
