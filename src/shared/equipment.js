export let EQUIP_UNARMED = 0

export let EQUIP_RESOLVE_NAMED = 'named'
export let EQUIP_RESOLVE_NOT_A_LIST = 'equipment-not-a-list'
export let EQUIP_RESOLVE_NAME_NOT_A_STRING = 'name-not-a-string'
export let EQUIP_RESOLVE_NAME_NOT_DECLARED = 'name-not-declared'

export let EQUIP_NAME_NAMED = 'named'
export let EQUIP_NAME_NOT_A_LIST = 'equipment-not-a-list'
export let EQUIP_NAME_CODE_NOT_AN_INTEGER = 'code-not-an-integer'
export let EQUIP_NAME_CODE_BELOW_ONE = 'code-below-one'
export let EQUIP_NAME_EMPTY_SLOT = 'empty-slot'

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

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapEquipment = (next) => {
  equipResolve = next.equipResolve
  equipNameOf = next.equipNameOf
  EQUIP_UNARMED = next.EQUIP_UNARMED
  EQUIP_RESOLVE_NAMED = next.EQUIP_RESOLVE_NAMED
  EQUIP_RESOLVE_NOT_A_LIST = next.EQUIP_RESOLVE_NOT_A_LIST
  EQUIP_RESOLVE_NAME_NOT_A_STRING = next.EQUIP_RESOLVE_NAME_NOT_A_STRING
  EQUIP_RESOLVE_NAME_NOT_DECLARED = next.EQUIP_RESOLVE_NAME_NOT_DECLARED
  EQUIP_NAME_NAMED = next.EQUIP_NAME_NAMED
  EQUIP_NAME_NOT_A_LIST = next.EQUIP_NAME_NOT_A_LIST
  EQUIP_NAME_CODE_NOT_AN_INTEGER = next.EQUIP_NAME_CODE_NOT_AN_INTEGER
  EQUIP_NAME_CODE_BELOW_ONE = next.EQUIP_NAME_CODE_BELOW_ONE
  EQUIP_NAME_EMPTY_SLOT = next.EQUIP_NAME_EMPTY_SLOT
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapEquipment)
