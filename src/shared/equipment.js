export const EQUIP_UNARMED = 0

export const EQUIP_RESOLVE_NAMED = 'named'
export const EQUIP_RESOLVE_NOT_A_LIST = 'equipment-not-a-list'
export const EQUIP_RESOLVE_NAME_NOT_A_STRING = 'name-not-a-string'
export const EQUIP_RESOLVE_NAME_NOT_DECLARED = 'name-not-declared'

export const EQUIP_NAME_NAMED = 'named'
export const EQUIP_NAME_NOT_A_LIST = 'equipment-not-a-list'
export const EQUIP_NAME_CODE_NOT_AN_INTEGER = 'code-not-an-integer'
export const EQUIP_NAME_CODE_BELOW_ONE = 'code-below-one'
export const EQUIP_NAME_EMPTY_SLOT = 'empty-slot'

export function equipResolve(equipment, name) {
  if (!Array.isArray(equipment)) return { code: null, reason: EQUIP_RESOLVE_NOT_A_LIST }
  if (typeof name !== 'string') return { code: null, reason: EQUIP_RESOLVE_NAME_NOT_A_STRING }
  const at = equipment.indexOf(name)
  if (at < 0) return { code: null, reason: EQUIP_RESOLVE_NAME_NOT_DECLARED, name }
  return { code: at + 1, reason: EQUIP_RESOLVE_NAMED, name, at }
}

export function equipNameOf(equipment, code) {
  if (!Array.isArray(equipment)) return { name: null, reason: EQUIP_NAME_NOT_A_LIST }
  if (!Number.isInteger(code)) return { name: null, reason: EQUIP_NAME_CODE_NOT_AN_INTEGER }
  if (code < 1) return { name: null, reason: EQUIP_NAME_CODE_BELOW_ONE }
  const at = equipment[code - 1]
  return typeof at === 'string'
    ? { name: at, reason: EQUIP_NAME_NAMED }
    : { name: null, reason: EQUIP_NAME_EMPTY_SLOT }
}
