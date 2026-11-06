export default {
  server: {
    setup(ctx) {
      ctx.physics.addColliderFromConfig({ type: 'box', size: [1, 1, 1] })
      ctx.world.spawnChild('child-1', { app: 'placed-model', position: [1, 0, 1] })
    },
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, custom: { mesh: 'box' } }
    },
  },
}

function helper(v) {
  return v + 1
}
