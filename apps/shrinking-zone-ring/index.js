// Minimal reusable visual-boundary-ring app: gives a spawned entity a flat, colored disc mesh
// (client/EntityLoader.js's existing 'cylinder' MESH_BUILDERS kind) with no collider -- purely a visual
// marker for apps/_lib/shrinking-zone.js's shrinking safe-zone. Spawned/attached by
// defineShrinkingZone(). client/EntityLoader.js bakes custom.r/h into the mesh geometry ONCE at spawn
// (every other custom-mesh primitive in this codebase -- box-dynamic, destructible-debris, etc. --
// follows the same one-shot-geometry convention, never mutating custom post-setup); the ONLY live lever
// for a spawned entity's world-space size is entity.scale, applied on top of that fixed unit geometry
// every snapshot tick. Geometry is authored here as a fixed r=0.5 unit disc (matching MESH_BUILDERS'
// own r-default pattern); the owning zone primitive then live-tracks the shrinking radius purely via
// this entity's scale.x/scale.z (== liveRadius / 0.5), never by touching custom after spawn.
// Never spawned standalone; ctx.config supplies the initial radius/height/color.
export default {
  server: {
    setup(ctx) {
      const c = ctx.config || {}
      const h = c.h ?? 0.2, color = c.color ?? 0x00ffff
      ctx.entity.custom = { mesh: 'cylinder', color, roughness: 0.4, r: 0.5, h }
      const initialR = c.r ?? 50
      ctx.entity.scale = [initialR / 0.5, 1, initialR / 0.5]
      // no collider: this is a pure visual marker, never a physics obstacle.
    }
  }
}
