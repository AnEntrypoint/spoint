export default {
  server: {
    editorProps: [
      { key: '_collider', label: 'Collider', type: 'select', options: ['none', 'box', 'sphere', 'capsule', 'convex', 'trimesh'], default: 'none' },
      // Material-authored wetness mask (ssr-material-wetness-mask-authoring): 0 = dry, 1 = fully wet
      // (puddle/wet-road/rain-soaked). Consumed client-side by SSR.js's reflection mask via
      // EntityLoader's userData.wetness tag -- see that file's header for the full data flow. Distinct
      // from (additive to) SSR's existing sea-level-band mask: a wet road far from any water still
      // reflects once authored here.
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
