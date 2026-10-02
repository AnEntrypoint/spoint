import { defineBuoyancy } from '../_lib/buoyancy.js'

export default {
  description: 'Buoyant dynamic box: a physics-simulated crate that floats/bobs in water via real Archimedes-style buoyancy + submerged drag (apps/_lib/buoyancy.js).',
  server: {
    editorProps: [
      { key: 'hx', label: 'Width/2', type: 'number', default: 0.5 },
      { key: 'hy', label: 'Height/2', type: 'number', default: 0.5 },
      { key: 'hz', label: 'Depth/2', type: 'number', default: 0.5 },
      { key: 'mass', label: 'Mass (kg)', type: 'number', default: 50 },
      { key: 'color', label: 'Color', type: 'color', default: '#8B4513' },
      { key: 'roughness', label: 'Roughness', type: 'number', default: 0.8 },
      { key: 'floatFactor', label: 'Float factor', type: 'number', default: 1.2 },
      { key: 'linearDrag', label: 'Water drag', type: 'number', default: 2.0 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const hx = c.hx ?? 0.5, hy = c.hy ?? 0.5, hz = c.hz ?? 0.5
      ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8B4513, roughness: c.roughness ?? 0.8, sx: hx * 2, sy: hy * 2, sz: hz * 2, mass: c.mass ?? 50 }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz], mass: c.mass ?? 50, dynamic: true })
      ctx.state.buoyancy = defineBuoyancy({ halfHeight: hy, floatFactor: c.floatFactor ?? 1.2, linearDrag: c.linearDrag ?? 2.0 }, ctx)
    },
    update(ctx, dt) {
      ctx.state.buoyancy?.tick(dt)
    }
  }
}
