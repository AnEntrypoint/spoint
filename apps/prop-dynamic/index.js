export default {
  server: {
    setup(ctx) {
      ctx.physics.setMass(30)
      ctx.physics.setDynamic(true)
      ctx.physics.setLinearDamping(4.0)
      ctx.physics.setAngularDamping(4.0)
      ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
    }
  }
}
