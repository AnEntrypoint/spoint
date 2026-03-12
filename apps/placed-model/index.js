export default {
  server: {
    setup(ctx) {
      const collider = ctx.config.collider || 'none'
      ctx.physics.addColliderFromConfig({ type: collider })
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
