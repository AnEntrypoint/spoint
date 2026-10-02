export default {
  server: {
    editorProps: [
      { key: '_collider', label: 'Collider', type: 'select', options: ['none', 'box', 'sphere', 'capsule', 'convex', 'trimesh'], default: 'none' },
      { key: '_wetness', label: 'Wetness', type: 'range', min: 0, max: 1, step: 0.05, default: 0 }
    ],
    setup(ctx) {
      const bodyType = ctx.entity.bodyType || 'static'
      const requested = ctx.config.collider || ctx.entity.custom?._collider
      const collider = requested || (bodyType === 'static' ? 'trimesh' : 'convex')
      ctx.physics.addColliderFromConfig({ type: collider, dynamic: bodyType === 'dynamic', kinematic: bodyType === 'kinematic' })
      if (!ctx.entity.custom) ctx.entity.custom = {}
      ctx.entity.custom._collider = collider
      const wetness = ctx.config._wetness
      if (wetness !== undefined) ctx.entity.custom._wetness = wetness
    }
  }
}
