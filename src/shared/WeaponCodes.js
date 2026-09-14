export const WEAPON_UNARMED = 0
export const WEAPON_PISTOL = 1
export const WEAPON_RIFLE = 2

const CODE_TO_NAME = {
  [WEAPON_UNARMED]: null,
  [WEAPON_PISTOL]: 'Pistol',
  [WEAPON_RIFLE]: 'Rifle'
}
const NAME_TO_CODE = {
  Pistol: WEAPON_PISTOL,
  Rifle: WEAPON_RIFLE
}

export function weaponNameToCode(name) { return NAME_TO_CODE[name] ?? WEAPON_UNARMED }
export function codeToWeaponName(code) { return CODE_TO_NAME[code] ?? null }

export const WEAPON_CODE_COUNT = 8
