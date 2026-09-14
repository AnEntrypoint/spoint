import { definePickup } from '../_lib/pickup.js'
import { getSharedInventory, isPoolOwner, releaseSharedInventory } from '../_lib/inventory-registry.js'
import { ITEM_DEFINITIONS, ITEM_BUY_CATALOG, getItemDefinition } from '../_lib/item-definitions.js'

export default {
  description: 'Item pickup: a player walking into it is granted a real, server-validated inventory item.',
  server: {
    editorProps: [
      { key: 'item', label: 'Item', type: 'select', options: Object.keys(ITEM_DEFINITIONS), default: 'gold' },
      { key: 'amount', label: 'Amount', type: 'number', default: 1 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffd700' },
      { key: 'radius', label: 'Pickup radius', type: 'range', min: 0.5, max: 6, step: 0.5, default: 1.5 },
      { key: 'respawnMs', label: 'Respawn delay (ms)', type: 'number', default: 8000 },
      { key: 'poolId', label: 'Inventory pool', type: 'text', default: 'default' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#ffd700', sx: 0.4, sy: 0.4, sz: 0.4 }
      const joinPool = (poolId) => {
        ctx.state._poolId = poolId
        ctx.state._inv = getSharedInventory(ctx, { poolId, itemDefs: ITEM_DEFINITIONS, catalog: ITEM_BUY_CATALOG })
      }
      joinPool(c.poolId || 'default')
      const build = (cfg) => definePickup({
        radius: cfg.radius ?? 1.5,
        cooldown: cfg.respawnMs ?? 8000,
        onCollect: (c2, player) => {
          const inv = ctx.state._inv
          const itemId = cfg.item || 'gold'
          const amount = (typeof cfg.amount === 'number' && Number.isFinite(cfg.amount) && cfg.amount > 0) ? Math.floor(cfg.amount) : 1
          const before = inv.count(player.id, itemId)
          const after = inv.add(player.id, itemId, amount)
          c2.bus.emit('item-pickup.collect', { by: player.id, source: c2.entity.id, item: itemId, amount, before, after })
        },
      }, ctx)
      ctx.state._pickup = build(c)
      ctx.onConfigChange((cfg) => {
        const nextPoolId = cfg.poolId || 'default'
        if (nextPoolId !== ctx.state._poolId) {
          releaseSharedInventory(ctx.state._poolId, ctx.entity.id)
          joinPool(nextPoolId)
        }
        ctx.state._pickup = build(cfg)
      })
    },
    update(ctx, dt) {
      ctx.state._pickup?.tick(dt)
    },
    teardown(ctx) {
      releaseSharedInventory(ctx.state._poolId, ctx.entity.id)
    },
    onMessage(ctx, msg) {
      if (!msg || !ctx.state._inv) return
      if (!isPoolOwner(ctx.state._poolId, ctx.entity.id)) return
      if (msg.type === 'inventory_query') {
        const pid = msg.senderId
        if (pid == null) return
        ctx.players.send(pid, { type: 'inventory_state', items: ctx.state._inv.items(pid), currency: ctx.state._inv.currency(pid) })
      }
      if (msg.type === 'debug_kill') {
        const pid = msg.senderId
        if (pid == null) return
        const { dropped, kept } = ctx.state._inv.dropOnDeath(pid)
        const player = ctx.players.getById(pid)
        const pos = player?.state?.position || ctx.entity.position
        ctx.time.after(0, () => {
          for (const [item, n] of Object.entries(dropped)) {
            const def = getItemDefinition(item)
            ctx.world.spawn(null, {
              position: [pos[0] + (Math.random() - 0.5) * 1.5, pos[1] + 0.5, pos[2] + (Math.random() - 0.5) * 1.5],
              scale: [0.3, 0.3, 0.3],
              app: 'item-pickup',
              config: { item, amount: n, color: '#ff8800', poolId: ctx.state._poolId },
              custom: { mesh: 'box', color: '#ff8800', droppedLabel: def?.label || item }
            })
          }
        })
        ctx.bus.emit('item-pickup.drop', { playerId: pid, dropped, kept })
        ctx.players.send(pid, { type: 'inventory_dropped', dropped, kept })
      }
    },
  },
}
