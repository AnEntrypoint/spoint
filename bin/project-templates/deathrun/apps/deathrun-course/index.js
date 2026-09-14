function collectCheckpointMarkers(ctx) {
  const marks = ctx.world.query(e => e?.custom?._deathrunCheckpoint)
  return marks
    .map(e => ({ order: e.custom.order ?? 0, position: [e.position[0], e.position[1], e.position[2]], radius: e.custom.radius ?? 3, id: e.id }))
    .sort((a, b) => a.order - b.order)
}

export default {
  description: 'Deathrun/parkour course controller: reads placed checkpoint-marker entities, drives respawn + finish detection.',
  server: {
    editorProps: [
      { key: 'minY', label: 'Kill-plane Y', type: 'number', default: -50 },
      { key: 'spawn', label: 'Course start (fallback)', type: 'vec3', default: [0, 2, 0] },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const rebuild = (cfg) => {
        const markers = collectCheckpointMarkers(ctx)
        const spawn = Array.isArray(cfg.spawn) && cfg.spawn.length >= 3 ? cfg.spawn : [0, 2, 0]
        const finishOrder = markers.length ? markers[markers.length - 1].order : -1
        ctx.state._finished = ctx.state._finished || new Set()
        ctx.state.checkpoint = ctx.defineCheckpoint({
          spawn,
          minY: cfg.minY ?? -50,
          checkpoints: markers.map(m => ({ position: m.position, radius: m.radius })),
          onCheckpoint: (c2, playerId, index) => {
            if (finishOrder >= 0 && markers[index]?.order === finishOrder && !ctx.state._finished.has(playerId)) {
              ctx.state._finished.add(playerId)
              c2.bus.emit('run.finish', { playerId, checkpoints: markers.length })
            }
          },
        })
      }
      rebuild(c)
      ctx.onConfigChange?.((cfg) => rebuild(cfg))
    },
    update(ctx, dt) { ctx.state.checkpoint?.tick(dt) },
  },
}
