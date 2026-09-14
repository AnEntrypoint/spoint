import { createFluid3DBody } from '../_lib/fluid3d.js'

export default {
  description: 'Placeable 3D fluid volume (tank/waterfall): real from-scratch WASM 3D SPH fluid with genuine varying-Y depth, publishes a live particle cloud via entity.custom.fluid.',
  server: {
    editorProps: [
      { key: 'initialCount', label: 'Initial Particles', type: 'range', min: 0, max: 500, step: 1, default: 96 },
      { key: 'emitRate', label: 'Emit Rate (particles/sec)', type: 'range', min: 0, max: 200, step: 1, default: 0 },
      { key: 'maxParticles', label: 'Max Particles', type: 'range', min: 16, max: 2048, step: 16, default: 512 },
      { key: 'boundaryWidth', label: 'Boundary Width/Depth (m)', type: 'range', min: 1, max: 10, step: 0.5, default: 3 },
      { key: 'boundaryHeight', label: 'Boundary Height (m)', type: 'range', min: 1, max: 15, step: 0.5, default: 6 },
      { key: 'smoothingRadius', label: 'Smoothing Radius', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.5 },
      { key: 'viscosity', label: 'Viscosity', type: 'range', min: 0, max: 20, step: 0.1, default: 3.5 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      if (!ctx.entity.custom) ctx.entity.custom = { mesh: 'box', color: '#2266aa', roughness: 0.1, sx: 0.15, sy: 0.05, sz: 0.15 }
      const halfXZ = (c.boundaryWidth ?? 3) / 2
      const height = c.boundaryHeight ?? 6
      const origin = ctx.entity.position
      ctx.state.fluid3d = ctx.defineFluid3D({
        initialCount: c.initialCount ?? 96,
        emitRate: c.emitRate ?? 0,
        maxParticles: c.maxParticles ?? 512,
        smoothingRadius: c.smoothingRadius ?? 0.5,
        viscosity: c.viscosity ?? 3.5,
        boundary: {
          minX: origin[0] - halfXZ, minY: origin[1], minZ: origin[2] - halfXZ,
          maxX: origin[0] + halfXZ, maxY: origin[1] + height, maxZ: origin[2] + halfXZ
        }
      })
    },
    update(ctx, dt) {
      const f = ctx.state.fluid3d
      if (!f) return
      f.tick(dt)
      f.publish()
    },
    teardown(ctx) {
      ctx.state.fluid3d?.dispose()
    }
  }
}
