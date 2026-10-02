export const EQUIP_UNARMED = 0

export function equipCodeOf(equipment, name) {
  if (!Array.isArray(equipment) || typeof name !== 'string' || name === '') return EQUIP_UNARMED
  const at = equipment.indexOf(name)
  return at < 0 ? EQUIP_UNARMED : at + 1
}

export function equipNameOf(equipment, code) {
  if (!Array.isArray(equipment) || !Number.isInteger(code) || code < 1) return null
  return equipment[code - 1] ?? null
}
