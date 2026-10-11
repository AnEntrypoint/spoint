export const EQUIP_UNARMED = 0

export const EQUIP_RESOLVE_NAMED = 'named'
export const EQUIP_RESOLVE_UNARMED = 'unarmed'
export const EQUIP_RESOLVE_NOT_A_LIST = 'equipment-not-a-list'
export const EQUIP_RESOLVE_NAME_NOT_A_STRING = 'name-not-a-string'
export const EQUIP_RESOLVE_NAME_NOT_DECLARED = 'name-not-declared'

export function equipResolve(equipment, name) {
  if (!Array.isArray(equipment)) return { code: null, reason: EQUIP_RESOLVE_NOT_A_LIST }
  if (typeof name !== 'string') return { code: null, reason: EQUIP_RESOLVE_NAME_NOT_A_STRING }
  if (name === '') return { code: EQUIP_UNARMED, reason: EQUIP_RESOLVE_UNARMED, name }
  const at = equipment.indexOf(name)
  if (at < 0) return { code: null, reason: EQUIP_RESOLVE_NAME_NOT_DECLARED, name }
  return { code: at + 1, reason: EQUIP_RESOLVE_NAMED, name, at }
}

export function equipNameOf(equipment, code) {
  if (!Array.isArray(equipment) || !Number.isInteger(code) || code < 1) return null
  const at = equipment[code - 1]
  return typeof at === 'string' ? at : null
}
