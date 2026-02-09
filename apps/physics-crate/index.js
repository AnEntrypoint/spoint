export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0xff8800, sx: 1, sy: 1, sz: 1 }
      ctx.physics.setDynamic(true)
      ctx.physics.setMass(10)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
    },
    teardown(ctx) {
      const ent = ctx._entity
      if (ent?._physicsBodyId && ctx._runtime?._physics) {
        ctx._runtime._physics.removeBody(ent._physicsBodyId)
        ent._physicsBodyId = null
      }
    },
    update(ctx, dt) {
      const ent = ctx._entity
      if (!ent?._physicsBodyId || !ctx._runtime?._physics) return
      const pw = ctx._runtime._physics
      ent.position = pw.getBodyPosition(ent._physicsBodyId)
      ent.rotation = pw.getBodyRotation(ent._physicsBodyId)
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
