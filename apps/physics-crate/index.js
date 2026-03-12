export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0xff8800, sx: 1, sy: 1, sz: 1 }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [0.5, 0.5, 0.5], mass: 10, dynamic: true })
    }
  }
}
