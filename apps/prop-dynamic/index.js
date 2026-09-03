export default {
  server: {
    setup(ctx) {
      ctx.physics.addColliderFromConfig({ type: 'box', size: [0.5, 0.5, 0.5], mass: 30, dynamic: true, linearDamping: 1.5, angularDamping: 4.0 })
    }
  }
}
