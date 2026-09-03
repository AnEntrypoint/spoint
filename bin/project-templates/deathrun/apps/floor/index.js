// A flat static floor/platform block: a wide, thin static box, sized/colored via editorProps so a maker
// can resize it in the inspector after placing it. Reused for the deathrun template's start pad and any
// jump platforms a maker adds. Mirrors bin/project-template/apps/hello-app's own static-box + collider
// pattern, just parameterized instead of hardcoded 0.5m.
export default {
  description: 'Flat static floor/platform block (static box collider), size/color editable in the inspector.',
  server: {
    editorProps: [
      { key: 'width', label: 'Width (X)', type: 'range', min: 1, max: 400, step: 1, default: 20 },
      { key: 'depth', label: 'Depth (Z)', type: 'range', min: 1, max: 400, step: 1, default: 20 },
      { key: 'thickness', label: 'Thickness (Y)', type: 'range', min: 0.2, max: 10, step: 0.2, default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#556677' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const sx = c.width ?? 20, sy = c.thickness ?? 1, sz = c.depth ?? 20
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#556677', sx, sy, sz }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([sx / 2, sy / 2, sz / 2])
      ctx.onConfigChange?.((cfg) => {
        ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color
        ctx.entity.custom.sx = cfg.width ?? ctx.entity.custom.sx
        ctx.entity.custom.sy = cfg.thickness ?? ctx.entity.custom.sy
        ctx.entity.custom.sz = cfg.depth ?? ctx.entity.custom.sz
      })
    },
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
