// Drag-and-drop GLB model placed in the world
export default {
  server: {
    editorProps: [
      { key: '_collider', label: 'Collider', type: 'select', options: ['none', 'convex', 'trimesh', 'box'], default: 'none' }
    ],
    setup(ctx) {
      const collider = ctx.config.collider || 'none'
      ctx.physics.addColliderFromConfig({ type: collider })
      if (!ctx.entity.custom) ctx.entity.custom = {}
      ctx.entity.custom._collider = collider
    }
  }
}
