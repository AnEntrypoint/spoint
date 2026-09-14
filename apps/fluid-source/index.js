import { createFluidBody } from '../_lib/fluid.js'

export default {
  description: 'Placeable pool/puddle/fountain: real from-scratch WASM SPH fluid, publishes a live particle cloud via entity.custom.fluid.',
  server: {
    editorProps: [
      { key: 'initialCount', label: 'Initial Particles', type: 'range', min: 0, max: 500, step: 1, default: 64 },
      { key: 'emitRate', label: 'Emit Rate (particles/sec)', type: 'range', min: 0, max: 200, step: 1, default: 0 },
      { key: 'maxParticles', label: 'Max Particles', type: 'range', min: 16, max: 4096, step: 16, default: 512 },
      { key: 'boundarySize', label: 'Boundary Size (m)', type: 'range', min: 1, max: 20, step: 0.5, default: 4 },
      { key: 'smoothingRadius', label: 'Smoothing Radius', type: 'range', min: 0.1, max: 2, step: 0.05, default: 0.5 },
      { key: 'viscosity', label: 'Viscosity', type: 'range', min: 0, max: 20, step: 0.1, default: 3.5 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      if (!ctx.entity.custom) ctx.entity.custom = { mesh: 'box', color: '#3388cc', roughness: 0.1, sx: 0.15, sy: 0.05, sz: 0.15 }
      const half = (c.boundarySize ?? 4) / 2
      const origin = ctx.entity.position
      ctx.state.fluid = ctx.defineFluid({
        initialCount: c.initialCount ?? 64,
        emitRate: c.emitRate ?? 0,
        maxParticles: c.maxParticles ?? 512,
        smoothingRadius: c.smoothingRadius ?? 0.5,
        viscosity: c.viscosity ?? 3.5,
        boundary: { minX: origin[0] - half, minZ: origin[2] - half, maxX: origin[0] + half, maxZ: origin[2] + half }
      })
    },
    update(ctx, dt) {
      const f = ctx.state.fluid
      if (!f) return
      f.tick(dt)
      f.publish()
    },
    teardown(ctx) {
      ctx.state.fluid?.dispose()
    }
  }
}
