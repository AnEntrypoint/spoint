import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'

export const INVENTORY_SCHEMA = defineComponentSchema({
  currency: { type: 'u16', tier: 'full' },
})
registerComponentSchema('inventory', INVENTORY_SCHEMA)

function isPositiveInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0
}

export function definePlayerInventory(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[inventory] appCtx is required')
  const startItems = (spec.startItems && typeof spec.startItems === 'object') ? spec.startItems : {}
  const startCurrency = (typeof spec.startCurrency === 'number' && Number.isFinite(spec.startCurrency)) ? spec.startCurrency : 0
  const catalog = (spec.catalog && typeof spec.catalog === 'object') ? spec.catalog : {}
  const itemDefs = (spec.itemDefs && typeof spec.itemDefs === 'object') ? spec.itemDefs : null
  const channel = spec.channel || 'inventory'

  const _bags = new Map()

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
    add(pid, item, n = 1) {
      const b = _bag(pid)
      const current = b.items.get(item) || 0
      if (!isPositiveInt(n)) return current
      const notInItemCatalog = itemDefs && !Object.prototype.hasOwnProperty.call(itemDefs, item)
      if (notInItemCatalog) return current
      const cap = _maxStack(item)
      const next = Math.min(cap, current + n)
      const alreadyAtCap = next === current
      if (alreadyAtCap) return current
      b.items.set(item, next)
      _changed(pid, b)
      return next
    },
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
    spend(pid, amount) {
      if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount < 0) return false
      const b = _bag(pid); if (b.currency < amount) return false
      b.currency -= amount; _changed(pid, b); return true
    },
    buy(pid, item) {
      const entry = catalog[item]
      if (!entry) return { ok: false, reason: 'not-in-catalog' }
      if (!inv.canAfford(pid, entry.cost)) return { ok: false, reason: 'cannot-afford' }
      const grantList = entry.grants ? Object.entries(entry.grants) : [[item, 1]]
      const before = grantList.map(([g]) => inv.count(pid, g))
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
        } else { dropN = heldCount }
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
    push(pid) { appCtx.players?.send?.(String(pid), { type: channel, ..._snapshot(_bag(pid)) }) },
  }
  return inv
}

export default definePlayerInventory
