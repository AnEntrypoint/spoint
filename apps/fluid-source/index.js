// Minimal demonstration/host app for apps/_lib/fluid.js -- a placeable pool/puddle/fountain that
// simulates via a real from-scratch WASM SPH solver (see fluid.js's own header for the emitter/
// world-plane-mapping rationale, and src/fluid/SPHSolver.js / src/fluid/as-src/sph.ts for the underlying
// WCSPH physics). Wire your own game-specific fluid the same way: ctx.defineFluid() once in setup(),
// tick(dt) + publish() every server tick from update(ctx,dt) -- mirrors apps/softbody-cloth/index.js's
// own shape exactly.
//
// The host entity itself carries NO Jolt collider (a fluid body is a self-contained secondary simulation,
// not a rigid prop) -- its own position/rotation/scale stay static and exist only to give the fluid a
// spawn-time anchor point (fluid.js reads appCtx.entity.position once at build time as the boundary's
// world-space center).
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
      // A default placeholder mesh (see destructible.js's own doc: EntityLoader falls back to an orange
      // box for any custom-less entity) -- keeps the ANCHOR point visible in-editor even before the
      // client-side particle-mesh render path (sibling row, not yet built) exists.
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
    // Releases the solver reference before a hot-reload re-runs setup() (matching apps/softbody-cloth's
    // own teardown discipline) -- fluid.js's own dispose() is also registered via appCtx._registerDisposer
    // so this call is technically redundant with the disposer firing on detachApp, but explicit here for
    // the same "release resources before re-setup" clarity every other physics-owning app follows.
    teardown(ctx) {
      ctx.state.fluid?.dispose()
    }
  }
}
