// Minimal demonstration/host app for apps/_lib/fluid3d.js -- a placeable REAL 3D fluid volume (tank/pool
// with actual vertical structure, varying Y per particle) simulated via the real from-scratch WASM 3D SPH
// solver (see fluid3d.js's own header for the world-space-box rationale, and src/fluid/SPHSolver3D.js /
// src/fluid/as-src/sph3d.ts for the underlying 3D WCSPH physics). Mirrors apps/fluid-source/index.js's
// own shape exactly, swapped onto the 3D factory + a 3D (minY/maxY-bearing) boundary box.
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
      // A default placeholder mesh (see destructible.js's own doc: EntityLoader falls back to an orange
      // box for any custom-less entity) -- keeps the ANCHOR point visible in-editor even before the
      // client-side particle-mesh render path (sibling row sph-fluid-3d-client-render-verification) has
      // been live-witnessed against this app's real varying-Y output.
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
    // Releases the solver reference before a hot-reload re-runs setup() (matching fluid-source's own
    // teardown discipline) -- fluid3d.js's own dispose() is also registered via appCtx._registerDisposer
    // so this call is technically redundant with the disposer firing on detachApp, but explicit here for
    // the same "release resources before re-setup" clarity every other physics-owning app follows.
    teardown(ctx) {
      ctx.state.fluid3d?.dispose()
    }
  }
}
