// Tutorial NPC: NPCs for quest interaction (elder, healer, etc)

export const server = {
  setup(ctx) {
    ctx.state = { npcId: ctx.entity.custom?.npcId || 'unknown' }
    ctx.physics.setBodyType('static')
  },

  onMessage(ctx, msg) {
    if (msg.type === 'talk') {
      ctx.world.sendToEntity('tutorial-world', {
        type: 'npcTalked',
        playerId: msg.playerId,
        npcId: ctx.state.npcId,
      })
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialNPC] Spawned')
  },
}
