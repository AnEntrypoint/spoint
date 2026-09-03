// A flat static floor: a wide, thin static box, sized/colored via editorProps so a maker can resize it in
// the inspector after placing it. Mirrors bin/project-template/apps/hello-app's own static-box + collider
// pattern, just parameterized instead of hardcoded 0.5m.
export default {
  description: 'Flat static floor (wide static box collider), size/color editable in the inspector.',
  server: {
    editorProps: [
      { key: 'width', label: 'Width (X)', type: 'range', min: 4, max: 2000, step: 10, default: 300 },
      { key: 'depth', label: 'Depth (Z)', type: 'range', min: 4, max: 2000, step: 10, default: 300 },
      { key: 'thickness', label: 'Thickness (Y)', type: 'range', min: 0.2, max: 10, step: 0.2, default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#4a5f4a' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const sx = c.width ?? 300, sy = c.thickness ?? 1, sz = c.depth ?? 300
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#4a5f4a', sx, sy, sz }
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
