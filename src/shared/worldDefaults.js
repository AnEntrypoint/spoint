export const DEFAULT_TICK_RATE_HZ = 60
export const DEFAULT_GRAVITY = Object.freeze([0, -9.81, 0])
export const DEFAULT_SPAWN_POINT = Object.freeze([0, 5, 0])
export const PLAYER_DEFAULTS = Object.freeze({ capsuleRadius: 0.4, capsuleHalfHeight: 0.9, crouchHalfHeight: 0.45, mass: 120, health: 100 })
export const DEFAULT_PLAYER_MODEL = '/assets/default-avatar.vrm'
export const DEFAULT_ICE_SERVERS =Object.freeze([Object.freeze({ urls: 'stun:stun.l.google.com:19302' })])

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
