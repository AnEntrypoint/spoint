export const MSG = {
  HANDSHAKE: 0x01,
  HANDSHAKE_ACK: 0x02,
  HEARTBEAT: 0x03,
  HEARTBEAT_ACK: 0x04,

  SNAPSHOT: 0x10,
  INPUT: 0x11,
  STATE_CORRECTION: 0x12,
  DELTA_UPDATE: 0x13,

  PLAYER_JOIN: 0x20,
  PLAYER_LEAVE: 0x21,
  PLAYER_INPUT: 0x22,

  ENTITY_SPAWN: 0x30,
  ENTITY_DESTROY: 0x31,
  ENTITY_UPDATE: 0x32,
  APP_EVENT: 0x33,

  CLIENT_LOG: 0x40,
  CLIENT_ERROR: 0x41,
  CLIENT_WARN: 0x42,
  CLIENT_PERF: 0x43,
  CLIENT_STATE: 0x44,

  SERVER_LOG: 0x50,
  DEBUG_SNAPSHOT: 0x51,
  INSPECT_ENTITY: 0x52,
  INSPECT_RESPONSE: 0x53,

  RECONNECT: 0x60,
  RECONNECT_ACK: 0x61,
  STATE_RECOVERY: 0x62,
  DISCONNECT_REASON: 0x63,

  HOT_RELOAD: 0x70,
  WORLD_DEF: 0x71,
  APP_MODULE: 0x72,
  ASSET_UPDATE: 0x73,
  BUS_EVENT: 0x74
}

const nameMap = new Map()
for (const [name, id] of Object.entries(MSG)) nameMap.set(id, name)

export function msgName(id) {
  return nameMap.get(id) || `UNKNOWN(0x${id.toString(16)})`
}

export const UNRELIABLE_MSGS = new Set([
  0x03, 0x04, 0x10, 0x11, 0x12, 0x13, 0x22, 0x43, 0x44
])

export function isUnreliable(type) {
  return UNRELIABLE_MSGS.has(type)
}

export const DISCONNECT_REASONS = {
  NORMAL: 0,
  TIMEOUT: 1,
  KICKED: 2,
  SERVER_SHUTDOWN: 3,
  INVALID_SESSION: 4,
  RATE_LIMITED: 5
}

export const CONNECTION_QUALITY = {
  EXCELLENT: 'excellent',
  GOOD: 'good',
  POOR: 'poor',
  CRITICAL: 'critical'
}
