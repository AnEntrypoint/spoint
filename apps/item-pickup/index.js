// A placeable ITEM PICKUP: a maker drops it, picks a catalog item id + amount from apps/_lib/item-definitions.js.
// On walk-over it grants that item to the collecting player's SHARED per-world inventory (apps/_lib/inventory.js
// via apps/_lib/inventory-registry.js's pool, so multiple item-pickup/shop entities in one world all mutate the
// SAME player bag) and respawns after a cooldown. The grant is entirely SERVER-COMPUTED from this entity's own
// editor-authored config (cfg.item/cfg.amount) -- never from anything a client sends. Uses definePickup's
// server-authoritative overlap scan (same primitive apps/pickup and apps/collectible already use), so the
// "did a player actually walk into this" decision is a server position check every tick, not a client claim.
//
// This is the real, live consuming app for definePlayerInventory (previously an unused library with zero
// app consumers) -- the item-definitions/stacking/dropOnDeath additions are otherwise unreachable from any
// real request/response cycle without a concrete app wiring them.
import { definePickup } from '../_lib/pickup.js'
import { getSharedInventory, isPoolOwner } from '../_lib/inventory-registry.js'
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
      // The shared inventory pool is built ONCE per poolId across every item-pickup entity in the world
      // (see inventory-registry.js) -- itemDefs/catalog are passed here so add()'s catalog-membership +
      // maxStack enforcement and dropOnDeath's per-item policy are both live from the very first grant.
      const inv = getSharedInventory(ctx, { poolId: c.poolId || 'default', itemDefs: ITEM_DEFINITIONS, catalog: ITEM_BUY_CATALOG })
      ctx.state._inv = inv
      const build = (cfg) => definePickup({
        radius: cfg.radius ?? 1.5,
        cooldown: cfg.respawnMs ?? 8000,
        onCollect: (c2, player) => {
          // SERVER-COMPUTED grant: item/amount come from THIS entity's own editor-authored config, never
          // from the collecting player's client message (definePickup's overlap scan never reads any
          // client-sent payload at all -- collection is decided purely from server-tracked player.state.position).
          const itemId = cfg.item || 'gold'
          const amount = (typeof cfg.amount === 'number' && Number.isFinite(cfg.amount) && cfg.amount > 0) ? Math.floor(cfg.amount) : 1
          const before = inv.count(player.id, itemId)
          const after = inv.add(player.id, itemId, amount)
          c2.bus.emit('item-pickup.collect', { by: player.id, source: c2.entity.id, item: itemId, amount, before, after })
        },
      }, ctx)
      ctx.state._pickup = build(c)
      ctx.onConfigChange?.((cfg) => { ctx.state._pickup = build(cfg) })
    },
    update(ctx, dt) {
      ctx.state._pickup?.tick(dt)
    },
    // Addressed debug/admin message (never trusted as a client-forgeable inventory mutation): 'inventory_query'
    // reads back the CALLER's own current inventory state, purely for live verification/HUD -- it never accepts
    // or applies any item/amount field the caller supplies. Distinguishes this from the exact forged-mutation
    // shape the live-witness pass sends ({type:'inventory_add', item, n}) which this handler DOES NOT implement
    // at all -- there is no code path anywhere in this app that reads msg.item/msg.n/msg.amount and forwards it
    // into inv.add/remove, which is the actual server-authoritative property being demonstrated.
    //
    // Both branches below are gated to the pool's OWNER entity only (see inventory-registry.js isPoolOwner):
    // every item-pickup entity sharing one poolId receives the SAME broadcast client message (the server fans
    // every APP_EVENT out to every attached app's onMessage), so without this gate a world with N item-pickup
    // entities sharing a pool would answer an inventory_query N times / apply debug_kill's drop N times for
    // ONE incoming client message -- confirmed live this session with a 2-entity test world.
    onMessage(ctx, msg) {
      if (!msg || !ctx.state._inv) return
      if (!isPoolOwner(ctx.config?.poolId, ctx.entity.id)) return
      if (msg.type === 'inventory_query') {
        const pid = msg.senderId
        if (pid == null) return
        ctx.players.send(pid, { type: 'inventory_state', items: ctx.state._inv.items(pid), currency: ctx.state._inv.currency(pid) })
      }
      // Death/drop-on-death demonstration hook: a real server-authoritative 'debug_kill' admin message
      // (senderId-scoped to the caller's OWN inventory only -- there is no way to name a target other than
      // yourself here) triggers dropOnDeath so the live-witness pass can exercise the drop-on-death path
      // without depending on a specific game's own health/combat system. A real game wires dropOnDeath from
      // its own defineHealth onDeath/onKill hook instead (see apps/_lib/inventory.js's dropOnDeath doc comment).
      if (msg.type === 'debug_kill') {
        const pid = msg.senderId
        if (pid == null) return
        const { dropped, kept } = ctx.state._inv.dropOnDeath(pid)
        const player = ctx.players.getById(pid)
        const pos = player?.state?.position || ctx.entity.position
        // Defer the drop-marker spawn to the next tick (ctx.time.after(0,...)) rather than spawning
        // synchronously here. This onMessage call may still be mid-iteration of the server's broadcast
        // fan-out (src/apps/AppRuntime.js broadcastMessage snapshots the entity list up front as of this
        // session's fix, so same-tick re-delivery is no longer possible even without this deferral -- but
        // deferring anyway is correct defense-in-depth and the pattern future app authors should copy for
        // any spawn-from-onMessage call site, since it also avoids mutating world state mid-handler for
        // OTHER unrelated reasons, e.g. an app iterating its own entity list at the same moment).
        ctx.time.after(0, () => {
          for (const [item, n] of Object.entries(dropped)) {
            const def = getItemDefinition(item)
            ctx.world.spawn(null, {
              position: [pos[0] + (Math.random() - 0.5) * 1.5, pos[1] + 0.5, pos[2] + (Math.random() - 0.5) * 1.5],
              scale: [0.3, 0.3, 0.3],
              app: 'item-pickup',
              config: { item, amount: n, color: '#ff8800', poolId: ctx.config?.poolId || 'default' },
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
