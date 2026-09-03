// Tutorial Boss: Shadow Beast boss for final quest

export const server = {
  setup(ctx) {
    ctx.state = {
      health: 100,
      maxHealth: 100,
      alive: true,
      active: ctx.entity.custom?.active || false,
    }

    ctx.physics.setBodyType('dynamic')
    ctx.physics.setMass(50)
  },

  tick(ctx, dt) {
    if (!ctx.state.alive || !ctx.state.active) return

    // Boss AI: patrol area
    const vel = ctx.entity.velocity
    if (Math.random() < 0.01) {
      const angle = Math.random() * Math.PI * 2
      const speed = 8
      ctx.physics.setVelocity([Math.cos(angle) * speed, vel[1], Math.sin(angle) * speed])
    }
  },

  onMessage(ctx, msg) {
    if (msg.type === 'activate') {
      ctx.state.active = true
      console.log('[TutorialBoss] Activated!')
    }

    if (msg.type === 'damage') {
      if (!ctx.state.alive || !ctx.state.active) return

      ctx.state.health = Math.max(0, ctx.state.health - (msg.amount || 10))

      if (ctx.state.health <= 0) {
        ctx.state.alive = false
        ctx.entity.destroy()

        ctx.world.sendToEntity('tutorial-world', {
          type: 'beastDefeated',
          playerId: msg.playerId,
        })
      }
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialBoss] Spawned')
  },
}
