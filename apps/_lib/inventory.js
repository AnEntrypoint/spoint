// definePlayerInventory(spec, appCtx) -> a per-player inventory + optional currency/economy primitive.
// Crafting / survival / RPG / bomb-defusal-buy-phase / shop games all need "this player holds N of item X"
// + "this player has M currency" + "buy this if they can afford it". This wraps it once as a pure server
// state bag keyed by playerId, broadcasting each player's own inventory to that client for its HUD.
//
// SERVER-AUTHORITATIVE BY CONSTRUCTION: every mutation method here (add/remove/earn/spend/buy/dropOnDeath)
// is a plain JS function call an app's SERVER-SIDE code makes -- there is no wire-message shape this module
// itself parses or trusts. The real client-trust boundary is one level up, in whatever app calls these
// methods: src/sdk/ServerHandlers.js broadcasts every client-sent APP_EVENT to every entity's onMessage
// with a server-verified senderId (never a client-asserted playerId) but an entirely CLIENT-CHOSEN payload
// shape -- an app whose onMessage naively did `inv.add(msg.senderId, msg.item, msg.n)` would let any
// connected client grant itself unlimited of any item. No app in this repo does that (apps/pickup and
// apps/collectible, the two definePickup consumers, decide the item/amount from EDITOR-authored config,
// never from the incoming message; see apps/item-pickup/index.js for the definePlayerInventory consumer).
// This module's own hardening below (integer/positive/catalog/maxStack checks) is defense in depth for
// that boundary, not a replacement for "never wire msg.item/msg.n into add() directly" at the call site.
//
// spec = {
//   startItems?: Record<string, number>,   // items every player starts with (default {})
//   startCurrency?: number,                 // starting balance (default 0)
//   catalog?: Record<string, { cost: number, grants?: Record<string,number> }>,  // buyable items for buy()
//   itemDefs?: Record<string, { maxStack?: number, dropPolicy?: 'keep'|'dropAll'|'dropPercent', dropPercent?: number }>,
//     // optional per-item rules (pass apps/_lib/item-definitions.js's ITEM_DEFINITIONS, or a subset/custom
//     // table). When omitted, add() has no maxStack ceiling (Infinity) and dropOnDeath defaults every item
//     // to 'dropAll'. When provided, add() REJECTS an item id not present in the table (returns 0, no-op)
//     // -- this is what makes a forged/typo'd item id a structural no-op instead of silently creating a
//     // brand-new uncataloged item bucket.
//   channel?: string,                       // per-player client message type (default 'inventory')
//   onChange?(ctx, { playerId, items, currency }),
//   onBuy?(ctx, { playerId, item, cost, currency }),
//   onDrop?(ctx, { playerId, dropped, kept }),   // fired by dropOnDeath after the bag is mutated
// }
// Returns { add(pid,item,n=1), remove(pid,item,n=1), count(pid,item), has(pid,item,n=1), items(pid),
//           currency(pid), earn(pid,amount), spend(pid,amount), canAfford(pid,amount), buy(pid,item),
//           dropOnDeath(pid), reset(pid), clearAll(), push(pid) }.
//
// INVENTORY_SCHEMA: the declarative replicated-field schema for this component (see
// apps/_lib/ComponentSchema.js). Scoped to `currency` only for this proof-of-pattern pass -- the full
// `items` bag is an open-ended string-keyed map (arbitrary item ids added at runtime via add()/buy()),
// which needs a genuinely different wire strategy (a registered item-id table, closer to teams.js's
// enum-over-declared-ids approach) than a fixed-field schema can express; that is real follow-up scope,
// not a gap in this schema itself. currency is u16 (0-65535) -- matches this component's existing
// Number-only balance contract; a game needing a larger economy range should not rely on this narrow
// schema without widening the field type first.

import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'

export const INVENTORY_SCHEMA = defineComponentSchema({
  currency: { type: 'u16', tier: 'full' },
})
registerComponentSchema('inventory', INVENTORY_SCHEMA)

// A positive (>0), finite, INTEGER count. Rejects fractional counts (no half-items), NaN/Infinity, and
// -- critically -- rejects a negative n reaching add() disguised as a grant (a caller must go through
// remove(), which explicitly Math.abs()es, to ever decrease a stack; add() itself can never subtract).
function isPositiveInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0
}

export function definePlayerInventory(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[inventory] appCtx is required')
  const startItems = (spec.startItems && typeof spec.startItems === 'object') ? spec.startItems : {}
  const startCurrency = (typeof spec.startCurrency === 'number' && Number.isFinite(spec.startCurrency)) ? spec.startCurrency : 0
  const catalog = (spec.catalog && typeof spec.catalog === 'object') ? spec.catalog : {}
  // itemDefs, when supplied, is the single source of truth for maxStack + dropPolicy; add()/remove() only
  // enforce catalog-membership when this is non-null (an uncataloged inventory -- e.g. a game using only
  // free-form crafting materials with no fixed item list -- keeps today's permissive any-item-id behavior).
  const itemDefs = (spec.itemDefs && typeof spec.itemDefs === 'object') ? spec.itemDefs : null
  const channel = spec.channel || 'inventory'

  const _bags = new Map()   // playerId -> { items: Map<string,number>, currency: number }

  const _bag = (pid) => {
    const key = String(pid)
    let b = _bags.get(key)
    if (!b) { b = { items: new Map(Object.entries(startItems)), currency: startCurrency }; _bags.set(key, b) }
    return b
  }
  const _maxStack = (item) => {
    if (!itemDefs) return Infinity
    const def = itemDefs[item]
    if (!def || typeof def.maxStack !== 'number' || !Number.isFinite(def.maxStack)) return Infinity
    return def.maxStack
  }
  const _snapshot = (b) => ({ items: Object.fromEntries(b.items), currency: b.currency })
  const _fire = (name, arg) => { const fn = spec[name]; if (typeof fn === 'function') { try { fn(appCtx, arg) } catch (e) { appCtx.debug?.warn?.('[inventory] ' + name + ' threw: ' + e.message) } } }
  const _changed = (pid, b) => { const s = _snapshot(b); _fire('onChange', { playerId: String(pid), ...s }); inv.push(pid) }

  const inv = {
    // Grants n (a positive integer) of item, clamped to the item's catalog maxStack. Returns the ACTUAL
    // post-add count (which may be less than count()+n if the stack was already partially full), or the
    // player's PRE-add count unchanged if the call was rejected outright (bad n, uncataloged item when a
    // catalog is configured, or the stack was already at/above maxStack). Never accepts a negative/zero/
    // fractional/non-finite n -- that shape is a rejected no-op, not a silent remove().
    add(pid, item, n = 1) {
      const b = _bag(pid)
      const current = b.items.get(item) || 0
      if (!isPositiveInt(n)) return current
      if (itemDefs && !Object.prototype.hasOwnProperty.call(itemDefs, item)) return current
      const cap = _maxStack(item)
      const next = Math.min(cap, current + n)
      if (next === current) return current   // already at/above cap: no-op, no spurious onChange/push
      b.items.set(item, next)
      _changed(pid, b)
      return next
    },
    // Removes up to n (a positive integer; non-positive-int n is a no-op) of item, never going below 0 and
    // never removing more than the player actually owns (n is clamped to the held count first). Returns
    // the actual number removed (0 if the player did not own the item or n was invalid).
    remove(pid, item, n = 1) {
      const b = _bag(pid)
      const current = b.items.get(item) || 0
      if (!isPositiveInt(n) || current <= 0) return 0
      const removed = Math.min(n, current)
      const next = current - removed
      if (next <= 0) b.items.delete(item); else b.items.set(item, next)
      _changed(pid, b)
      return removed
    },
    count(pid, item) { return _bag(pid).items.get(item) || 0 },
    has(pid, item, n = 1) { return inv.count(pid, item) >= n },
    items(pid) { return Object.fromEntries(_bag(pid).items) },
    currency(pid) { return _bag(pid).currency },
    earn(pid, amount) {
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return inv.currency(pid)
      const b = _bag(pid); b.currency += amount; _changed(pid, b); return b.currency
    },
    canAfford(pid, amount) { return _bag(pid).currency >= amount },
    // Returns true if spent, false if the player can't afford it (no partial spend).
    spend(pid, amount) {
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount < 0) return false
      const b = _bag(pid); if (b.currency < amount) return false
      b.currency -= amount; _changed(pid, b); return true
    },
    // Purchase a catalog item: spend its cost, grant its items. Returns {ok} or {ok:false, reason}.
    // A grant already fully blocked by a maxStack cap on every granted item (nothing would actually be
    // received) is rejected BEFORE spending -- charging currency for zero items received is a real
    // economic bug this method used to have (the pre-add/post-add delta was never checked, so a full
    // inventory could be charged repeatedly while gaining nothing). A PARTIAL grant (e.g. multi-item
    // grants where only some items are capped) still spends the full cost and succeeds -- ok:true with
    // reason omitted -- since the buyer received real value; ok.granted reports exactly what was added
    // per item so a caller/HUD can show "stack full" for the items that didn't fit.
    buy(pid, item) {
      const entry = catalog[item]
      if (!entry) return { ok: false, reason: 'not-in-catalog' }
      if (!inv.canAfford(pid, entry.cost)) return { ok: false, reason: 'cannot-afford' }
      const grantList = entry.grants ? Object.entries(entry.grants) : [[item, 1]]
      const before = grantList.map(([g]) => inv.count(pid, g))
      // Dry-run against maxStack without mutating: if EVERY granted item is already at/above its cap,
      // the whole purchase would add nothing -- reject before spend() ever runs.
      const wouldGrantNothing = grantList.every(([g, n], i) => {
        const cap = itemDefs && itemDefs[g] && typeof itemDefs[g].maxStack === 'number' && Number.isFinite(itemDefs[g].maxStack) ? itemDefs[g].maxStack : Infinity
        return isPositiveInt(n) === false || before[i] >= cap
      })
      if (wouldGrantNothing) return { ok: false, reason: 'stack-full' }
      inv.spend(pid, entry.cost)
      const granted = {}
      grantList.forEach(([g, n], i) => { const after = inv.add(pid, g, n); granted[g] = after - before[i] })
      _fire('onBuy', { playerId: String(pid), item, cost: entry.cost, currency: inv.currency(pid), granted })
      return { ok: true, currency: inv.currency(pid), granted }
    },
    // Apply each held item's dropPolicy (from itemDefs; items with no itemDefs entry, or when no itemDefs
    // table is configured at all, default to 'dropAll' -- the safe default for a survival/looter game is
    // to lose your bag on death unless an item is explicitly marked 'keep'/'dropPercent'). Mutates the bag
    // in place (dropped items/currency are removed from the player), fires onDrop, and returns
    // { dropped: {item:n,...}, kept: {item:n,...} } so the caller (a real onDeath hook) can decide what to
    // do with the dropped items -- e.g. spawn a real world pickup entity at the death position.
    dropOnDeath(pid) {
      const b = _bag(pid)
      const dropped = {}, kept = {}
      for (const [item, heldCount] of [...b.items]) {
        const def = itemDefs ? itemDefs[item] : null
        const policy = def?.dropPolicy || 'dropAll'
        let dropN = 0
        if (policy === 'keep') { dropN = 0 }
        else if (policy === 'dropPercent') {
          const pct = (typeof def?.dropPercent === 'number' && def.dropPercent >= 0 && def.dropPercent <= 1) ? def.dropPercent : 1
          dropN = Math.min(heldCount, Math.max(pct > 0 ? 1 : 0, Math.floor(heldCount * pct)))
        } else { dropN = heldCount }   // 'dropAll' (also the default for an uncataloged item)
        if (dropN > 0) {
          dropped[item] = dropN
          const remaining = heldCount - dropN
          if (remaining <= 0) b.items.delete(item); else b.items.set(item, remaining)
          if (remaining > 0) kept[item] = remaining
        } else if (heldCount > 0) {
          kept[item] = heldCount
        }
      }
      _fire('onDrop', { playerId: String(pid), dropped, kept })
      _changed(pid, b)
      return { dropped, kept }
    },
    reset(pid) { _bags.delete(String(pid)); const b = _bag(pid); _changed(pid, b) },
    clearAll() { _bags.clear() },
    // Push this player's own inventory to their client (their app onEvent gets { type: channel, items, currency }).
    push(pid) { appCtx.players?.send?.(String(pid), { type: channel, ..._snapshot(_bag(pid)) }) },
  }
  return inv
}

export default definePlayerInventory
