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
      ctx.physics.addColliderFromConfig({ type: 'box', size: [hx, hy, hz] })

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
    teardown(ctx) {
      ctx.state.destructible?.drain()
    }
  }
}
