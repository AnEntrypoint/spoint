export default {
  server: {
    setup(ctx) {
      const cfg = ctx.entity._config || {}
      const collider = cfg.collider || 'none'
      if (collider === 'box') {
        ctx.physics.setStatic(true)
        ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
      } else if (collider === 'sphere') {
        ctx.physics.setStatic(true)
        ctx.physics.addSphereCollider(0.5)
      } else if (collider === 'convex') {
        ctx.physics.setStatic(true)
        if (ctx.entity.model) ctx.physics.addConvexFromModel(0)
      } else if (collider === 'trimesh') {
        ctx.physics.setStatic(true)
        if (ctx.entity.model) ctx.physics.addTrimeshCollider()
      }
      if (!ctx.entity.custom) ctx.entity.custom = {}
      ctx.entity.custom._editable = true
      ctx.entity.custom._collider = collider
    },

    onEditorUpdate(ctx, changes) {
      if (changes.position) ctx.entity.position = changes.position
      if (changes.rotation) ctx.entity.rotation = changes.rotation
      if (changes.scale) ctx.entity.scale = changes.scale
      if (changes.custom) ctx.entity.custom = { ...ctx.entity.custom, ...changes.custom }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
