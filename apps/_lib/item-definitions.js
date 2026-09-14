export const ITEM_DEFINITIONS = Object.freeze({
  gold: { maxStack: 999999, dropPolicy: 'dropPercent', dropPercent: 0.5, label: 'Gold' },
  wood: { maxStack: 200, dropPolicy: 'dropAll', label: 'Wood' },
  stone: { maxStack: 200, dropPolicy: 'dropAll', label: 'Stone' },
  medkit: { maxStack: 5, cost: 40, dropPolicy: 'dropAll', label: 'Medkit' },
  grenade: { maxStack: 3, cost: 25, dropPolicy: 'dropAll', label: 'Grenade' },
  key_bronze: { maxStack: 1, dropPolicy: 'keep', label: 'Bronze Key' },
  legendary_sword: { maxStack: 1, cost: 500, dropPolicy: 'keep', label: 'Legendary Sword' },
})

export function getItemDefinition(itemId) {
  return Object.prototype.hasOwnProperty.call(ITEM_DEFINITIONS, itemId) ? ITEM_DEFINITIONS[itemId] : null
}

export const ITEM_BUY_CATALOG = Object.freeze(
  Object.fromEntries(
    Object.entries(ITEM_DEFINITIONS)
      .filter(([, def]) => typeof def.cost === 'number')
      .map(([id, def]) => [id, { cost: def.cost, grants: { [id]: 1 } }])
  )
)

export default ITEM_DEFINITIONS
