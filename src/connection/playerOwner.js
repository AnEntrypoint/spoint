const OWNER_BRAND = Symbol('spoint.playerOwner')
const BRANDED = 'player-owner'

function seal(playerId) {
  return Object.freeze({ [OWNER_BRAND]: BRANDED, id: playerId })
}

export const UNBOUND_OWNER = seal(null)

export function mintPlayerOwner(playerId) {
  if (!Number.isInteger(playerId) || playerId < 0) {
    throw new TypeError(`[playerOwner] owner id must be a non-negative integer, got ${JSON.stringify(playerId)}`)
  }
  return seal(playerId)
}

export function isPlayerOwner(value) {
  return typeof value === 'object' && value !== null && value[OWNER_BRAND] === BRANDED
}

export function playerIdOf(owner) {
  if (!isPlayerOwner(owner)) throw new TypeError('[playerOwner] value is not a player owner')
  return owner.id
}
