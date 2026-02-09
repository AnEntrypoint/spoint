export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0xff8800, sx: 1, sy: 1, sz: 1 }
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(10)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
