// Tutorial Herb: collectible item for herb quest

export const server = {
  setup(ctx) {
    ctx.state = { collected: false }
    ctx.physics.setBodyType('static')
  },

  onMessage(ctx, msg) {
    if (msg.type === 'collect' && !ctx.state.collected) {
      ctx.state.collected = true
      ctx.entity.destroy()

      ctx.world.sendToEntity('tutorial-world', {
        type: 'herbCollected',
        playerId: msg.playerId,
      })
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialHerb] Spawned')
  },
}
