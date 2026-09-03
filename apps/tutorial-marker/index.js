// Tutorial Marker: location markers for quest objectives (shrine, checkpoints, etc)

export const server = {
  setup(ctx) {
    ctx.state = { markerType: ctx.entity.custom?.marker || 'unknown' }
    ctx.physics.setBodyType('static')
  },

  onMessage(ctx, msg) {
    if (msg.type === 'enter') {
      ctx.world.sendToEntity('tutorial-world', {
        type: 'markerReached',
        playerId: msg.playerId,
        marker: ctx.state.markerType,
      })
    }
  },
}

export const client = {
  mount(engine, options) {
    console.log('[TutorialMarker] Spawned')
  },
}
