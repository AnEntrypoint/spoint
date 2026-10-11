export const DEFAULT_TICK_RATE_HZ = 60
export const DEFAULT_GRAVITY = Object.freeze([0, -9.81, 0])
export const DEFAULT_SPAWN_POINT = Object.freeze([0, 5, 0])
export const PLAYER_DEFAULTS = Object.freeze({ capsuleRadius: 0.4, capsuleHalfHeight: 0.9, crouchHalfHeight: 0.45, mass: 120, health: 100 })
export const DEFAULT_PLAYER_MODEL = '/assets/default-avatar.vrm'
export const DEFAULT_ICE_SERVERS =Object.freeze([Object.freeze({ urls: 'stun:stun.l.google.com:19302' })])
export const DEFAULT_MOBILE_BUTTONS = Object.freeze([
  Object.freeze({ action: 'jump' }),
  Object.freeze({ action: 'crouch' }),
  Object.freeze({ action: 'interact' })
])

export function worldTickRate(worldDef) {
  return worldDef?.tickRate || DEFAULT_TICK_RATE_HZ
}

export function worldGravity(worldDef) {
  return [...(worldDef?.gravity || DEFAULT_GRAVITY)]
}

export function worldSpawnPoints(worldDef) {
  if (worldDef?.spawnPoints?.length) return worldDef.spawnPoints
  return [worldDef?.spawnPoint || [...DEFAULT_SPAWN_POINT]]
}

export function worldEquipment(worldDef) {
  return Array.isArray(worldDef?.equipment) ? worldDef.equipment : []
}

export class WorldMobileButtonsError extends Error {
  constructor(reason, message) {
    super(`${reason}: ${message}`)
    this.name = 'WorldMobileButtonsError'
    this.reason = reason
  }
}

export const MOBILE_BUTTON_GRID_MAX_COL = 3
export const MOBILE_BUTTON_GRID_MAX_ROW = 3

export function worldMobileButtons(worldDef) {
  const declared = worldDef?.input?.mobileButtons
  if (declared === undefined) return DEFAULT_MOBILE_BUTTONS.map(b => ({ ...b }))
  if (!Array.isArray(declared)) throw new WorldMobileButtonsError('mobile-buttons-not-a-list', `world input.mobileButtons must be an array, got ${declared === null ? 'null' : typeof declared}`)
  const taken = new Set()
  const out = []
  for (let index = 0; index < declared.length; index++) {
    const spec = declared[index]
    if (!spec || typeof spec !== 'object') throw new WorldMobileButtonsError('button-not-an-object', `world input.mobileButtons[${index}] must be an object, got ${spec === null ? 'null' : typeof spec}`)
    if (typeof spec.action !== 'string' || spec.action === '') throw new WorldMobileButtonsError('button-action-not-a-non-empty-string', `world input.mobileButtons[${index}].action must be a non-empty string, got ${JSON.stringify(spec.action) ?? typeof spec.action}`)
    if (out.some(b => b.action === spec.action)) throw new WorldMobileButtonsError('button-action-duplicated', `world input.mobileButtons[${index}] repeats the action "${spec.action}", so one of the two buttons could never be pressed`)
    const grid = gridCellOf(spec, index, taken)
    taken.add(grid.join(','))
    out.push({ ...spec, grid })
  }
  return out
}

function gridCellOf(spec, index, taken) {
  if (spec.grid === undefined) {
    for (let row = 1; row <= MOBILE_BUTTON_GRID_MAX_ROW; row++) for (let col = 1; col <= MOBILE_BUTTON_GRID_MAX_COL; col++) {
      const cell = [col, row]
      if (!taken.has(cell.join(','))) return cell
    }
    throw new WorldMobileButtonsError('button-grid-exhausted', `world input.mobileButtons[${index}] ("${spec.action}") is one button too many: the ${MOBILE_BUTTON_GRID_MAX_COL}x${MOBILE_BUTTON_GRID_MAX_ROW} grid holds ${MOBILE_BUTTON_GRID_MAX_COL * MOBILE_BUTTON_GRID_MAX_ROW}`)
  }
  if (!Array.isArray(spec.grid) || spec.grid.length !== 2 || !spec.grid.every(Number.isInteger)) throw new WorldMobileButtonsError('button-grid-not-a-cell', `world input.mobileButtons[${index}].grid must be [column, row] with two integers, got ${JSON.stringify(spec.grid) ?? typeof spec.grid}`)
  const [col, row] = spec.grid
  if (col < 1 || col > MOBILE_BUTTON_GRID_MAX_COL || row < 1 || row > MOBILE_BUTTON_GRID_MAX_ROW) throw new WorldMobileButtonsError('button-grid-out-of-range', `world input.mobileButtons[${index}].grid [${col}, ${row}] is outside the ${MOBILE_BUTTON_GRID_MAX_COL}x${MOBILE_BUTTON_GRID_MAX_ROW} grid, so the declared cell cannot be honoured`)
  if (taken.has(`${col},${row}`)) throw new WorldMobileButtonsError('button-grid-cell-taken', `world input.mobileButtons[${index}].grid [${col}, ${row}] is already taken by an earlier button`)
  return [col, row]
}

export function worldPlayerModel(worldDef) {
  return worldDef?.playerModel === undefined ? DEFAULT_PLAYER_MODEL : worldDef.playerModel
}

export function playerDefault(playerConfig, key) {
  const v = playerConfig?.[key]
  return Number.isFinite(v) && v > 0 ? v : PLAYER_DEFAULTS[key]
}

function envIceServers() {
  const raw = typeof process !== 'undefined' ? process.env?.SPOINT_ICE_SERVERS : undefined
  if (!raw) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { throw new TypeError(`SPOINT_ICE_SERVERS must be a JSON array of RTCIceServer objects: ${e.message}`) }
  if (!Array.isArray(parsed) || !parsed.every(s => s && (typeof s.urls === 'string' || (Array.isArray(s.urls) && s.urls.every(u => typeof u === 'string'))))) throw new TypeError('SPOINT_ICE_SERVERS must be a JSON array of objects with a urls string or string array')
  return parsed
}

export function worldIceServers(worldDef) {
  return worldDef?.iceServers || envIceServers() || DEFAULT_ICE_SERVERS.map(s => ({ ...s }))
}
