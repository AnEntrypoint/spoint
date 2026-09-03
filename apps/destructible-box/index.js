// Minimal demonstration/host app for apps/_lib/destructible.js -- a static box that shatters into N
// dynamic debris pieces once anything (player or dynamic prop) closes on it fast enough, with an
// optional respawn delay. Wire your own game-specific destructible object the same way: build the
// intact visual+collider in setup(), createDestructible() once, call destructible.tick(dt) every server
// tick (drives the primary proximity+speed impact scan), and optionally forward this app's own
// onCollision events into destructible.impact() too for instant (same-tick) object-vs-object triggering.
import { createDestructible } from '../_lib/destructible.js'

export default {
  server: {
    editorProps: [
      { key: 'hx', label: 'Width/2', type: 'number', default: 1 },
      { key: 'hy', label: 'Height/2', type: 'number', default: 1 },
      { key: 'hz', label: 'Depth/2', type: 'number', default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#8B4513' },
      { key: 'debrisCount', label: 'Debris Count', type: 'number', default: 8 },
      { key: 'debrisLifetime', label: 'Debris Lifetime (s)', type: 'number', default: 8 },
      { key: 'debrisSettleGrace', label: 'Debris Settle Grace (s)', type: 'number', default: 0.5 },
      { key: 'debrisFreezeAfter', label: 'Debris Force-Freeze After (s, 0=never)', type: 'number', default: 3 },
      { key: 'respawnDelay', label: 'Respawn Delay (s, 0=never)', type: 'number', default: 6 },
      { key: 'impactThreshold', label: 'Impact Speed Threshold (m/s)', type: 'number', default: 4 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const hx = c.hx ?? 1, hy = c.hy ?? 1, hz = c.hz ?? 1
      ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x8B4513, roughness: 0.85, sx: hx * 2, sy: hy * 2, sz: hz * 2 }
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz] }) // static intact collider

      ctx.state.destructible = createDestructible({
        debrisCount: c.debrisCount ?? 8,
        debrisLifetime: c.debrisLifetime ?? 8,
        debrisSettleGrace: c.debrisSettleGrace ?? 0.5,
        debrisFreezeAfter: c.debrisFreezeAfter ?? 3,
        respawnDelay: c.respawnDelay ?? 6,
        impactThreshold: c.impactThreshold ?? 4,
        debrisImpulsePattern: 'outward-up',
        debrisShape: { hx: hx / 2, hy: hy / 2, hz: hz / 2 }
      }, ctx)
    },
    onCollision(ctx, evt) {
      ctx.state.destructible.impact(evt.velocity)
    },
    update(ctx, dt) {
      ctx.state.destructible.tick(dt)
    },
    // Releases the pooled debris entities before a hot-reload re-runs setup() (matching apps/vehicle's
    // teardown discipline) -- without this, a hot-reload would create a FRESH createDestructible() with
    // an empty pool while the old pool's entities (and their pooled Jolt bodies) are orphaned with
    // nothing left holding a reference to release them.
    teardown(ctx) {
      ctx.state.destructible?.drain()
    }
  }
}
