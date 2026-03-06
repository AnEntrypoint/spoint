export default {
  server: {
    setup(ctx) {
      ctx.physics.setMass(30)
      ctx.physics.setDynamic(true)
      ctx.physics.setLinearDamping(2.0)
      ctx.physics.setAngularDamping(2.0)
      ctx.physics.addBoxCollider(0.5, 0.5, 0.5)
    }
  }
}
