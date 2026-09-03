// Real, shared item-catalog DATA (not an inline per-app-call spec). Any app wiring definePlayerInventory
// (apps/_lib/inventory.js) can pass this catalog (or a filtered subset of it) so item mutations are
// validated against a single source of truth for maxStack/cost/dropOnDeath instead of each app re-declaring
// its own ad hoc item list. A pickup/shop/crafting app looks an item up here to decide what a grant means;
// inventory.js itself stays catalog-agnostic (it accepts an optional lookup, never imports this file).
//
// Each entry:
//   maxStack: number       // hard cap on held count (Infinity = unstacked/unbounded, still an explicit choice)
//   cost?: number          // currency cost, only meaningful for buyable items (definePlayerInventory.buy)
//   dropPolicy: 'keep' | 'dropAll' | 'dropPercent'   // what happens to this item on inv.dropOnDeath(pid)
//   dropPercent?: number   // 0..1, only read when dropPolicy === 'dropPercent' (fraction of the held stack dropped, floored, min 1 if held>0)
//   label?: string         // display name (HUD/UI convenience, not used by inventory.js logic)

export const ITEM_DEFINITIONS = Object.freeze({
  gold: { maxStack: 999999, dropPolicy: 'dropPercent', dropPercent: 0.5, label: 'Gold' },
  wood: { maxStack: 200, dropPolicy: 'dropAll', label: 'Wood' },
  stone: { maxStack: 200, dropPolicy: 'dropAll', label: 'Stone' },
  medkit: { maxStack: 5, cost: 40, dropPolicy: 'dropAll', label: 'Medkit' },
  grenade: { maxStack: 3, cost: 25, dropPolicy: 'dropAll', label: 'Grenade' },
  key_bronze: { maxStack: 1, dropPolicy: 'keep', label: 'Bronze Key' },
  legendary_sword: { maxStack: 1, cost: 500, dropPolicy: 'keep', label: 'Legendary Sword' },
})

// Looks up an item's definition; returns null for an unrecognized id (caller decides whether that is
// an error or an intentionally-uncataloged free-form item, e.g. a game that wants pure numeric currencies
// only and no item bag at all can pass no catalog to definePlayerInventory and every id is uncataloged).
export function getItemDefinition(itemId) {
  return Object.prototype.hasOwnProperty.call(ITEM_DEFINITIONS, itemId) ? ITEM_DEFINITIONS[itemId] : null
}

// definePlayerInventory's optional `catalog` param (for buy()) only needs {cost, grants}; derive that
// shape from ITEM_DEFINITIONS so a game can pass ITEM_BUY_CATALOG directly instead of hand-rolling it.
// Only items with a declared `cost` are buyable; grants defaults to 1 of the item itself.
export const ITEM_BUY_CATALOG = Object.freeze(
  Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS)
      .filter(([, def]) => typeof def.cost === 'number')
      .map(([id, def]) => [id, { cost: def.cost, grants: { [id]: 1 } }])
  )
)

export default ITEM_DEFINITIONS
