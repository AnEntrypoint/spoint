// Minimal demonstration/host app for apps/_lib/softbody.js -- a placeable cloth/banner/flag that hangs
// from configurable pin points and simulates via a real isolated @dimforge/rapier3d-compat mass-spring
// particle grid (see softbody.js's own header for the full architectural-isolation rationale). Wire your
// own game-specific soft-body object the same way: ctx.defineSoftbody() once in setup(), tick(dt) +
// publish() every server tick from update(ctx,dt).
//
// The host entity itself carries NO Jolt collider (a softbody cloth is a self-contained secondary
// simulation, not a rigid prop) -- its own position/rotation/scale stay static and exist only to give
// the cloth a spawn-time anchor point (softbody.js reads appCtx.entity.position once at build time as
// the grid's world-space origin).
import { createSoftbodyCloth } from '../_lib/softbody.js'

export default {
  description: 'Placeable cloth/flag/banner: real isolated rapier3d-compat mass-spring particle grid, publishes live particle positions via entity.custom.softbody.',
  server: {
    editorProps: [
      { key: 'cols', label: 'Grid Columns', type: 'range', min: 2, max: 16, step: 1, default: 6 },
      { key: 'rows', label: 'Grid Rows', type: 'range', min: 2, max: 16, step: 1, default: 6 },
      { key: 'spacing', label: 'Particle Spacing (m)', type: 'range', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { key: 'mass', label: 'Total Cloth Mass (kg)', type: 'range', min: 0.1, max: 20, step: 0.1, default: 2 },
      { key: 'pins', label: 'Pin Mode', type: 'select', options: ['top-corners', 'top-row'], default: 'top-corners' },
      { key: 'stiffness', label: 'Stiffness', type: 'range', min: 10, max: 2000, step: 10, default: 200 },
      { key: 'damping', label: 'Damping', type: 'range', min: 0, max: 50, step: 0.5, default: 4 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      // A default placeholder mesh (see destructible.js's own doc: EntityLoader falls back to an orange
      // box for any custom-less entity) -- keeps the ANCHOR point visible in-editor even before the
      // client-side particle-mesh render path (sibling row, not yet built) exists.
      if (!ctx.entity.custom) ctx.entity.custom = { mesh: 'box', color: '#dddddd', roughness: 0.9, sx: 0.1, sy: 0.1, sz: 0.1 }
      ctx.state.softbody = ctx.defineSoftbody({
        cols: c.cols ?? 6,
        rows: c.rows ?? 6,
        spacing: c.spacing ?? 0.3,
        mass: c.mass ?? 2,
        pins: c.pins ?? 'top-corners',
        stiffness: c.stiffness ?? 200,
        damping: c.damping ?? 4
      })
    },
    update(ctx, dt) {
      const sb = ctx.state.softbody
      if (!sb) return
      sb.tick(dt)
      sb.publish()
    },
    // Releases the isolated rapier World before a hot-reload re-runs setup() (matching apps/vehicle's
    // teardown discipline) -- softbody.js's own dispose() is also registered via appCtx._registerDisposer
    // so this call is technically redundant with the disposer firing on detachApp, but explicit here for
    // the same "release native resources before re-setup" clarity every other physics-owning app follows.
    teardown(ctx) {
      ctx.state.softbody?.dispose()
    }
  }
}
