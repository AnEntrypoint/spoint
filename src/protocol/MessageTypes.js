export let WIRE_PROTOCOL_VERSION = 5

export let MSG = Object.freeze({
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
  BUS_EVENT: 0x74,

  EDITOR_UPDATE: 0x80,
  EDITOR_SELECT: 0x81,
  PLACE_MODEL: 0x82,
  PLACE_APP: 0x83,
  LIST_APPS: 0x84,
  APP_LIST: 0x85,
  GET_SOURCE: 0x86,
  SOURCE: 0x87,
  SAVE_SOURCE: 0x88,
  SCENE_GRAPH: 0x89,
  LIST_APP_FILES: 0x8A,
  APP_FILES: 0x8B,
  DESTROY_ENTITY: 0x8C,
  CREATE_APP: 0x8D,
  GET_EDITOR_PROPS: 0x8E,
  EDITOR_PROPS: 0x8F,

  EVENT_LOG_QUERY: 0x90,
  EVENT_LOG_DATA: 0x91,
  TRIMESH_DATA: 0x92,
  TICK_DILATION: 0x93,
  REPARENT_ENTITY: 0x94,
  DUPLICATE_ENTITY: 0x95,
  SET_LABEL: 0x96,
  SAVE_WORLD: 0x97,
  WORLD_SAVED: 0x98,
  LIST_WORLDS: 0x99,
  WORLD_LIST: 0x9a,
  TERRAIN_RESEED: 0x9b,
  TERRAIN_CONFIG: 0x9c,
  AUTH_EDITOR: 0x9d,
  AUTH_EDITOR_ACK: 0x9e,

  EDITOR_ERROR: 0x9f,
  SAVE_PREFAB: 0xa0,
  PREFAB_SAVED: 0xa1,
  PLACE_PREFAB: 0xa2,
  GROUP_ENTITIES: 0xa3,

  LIST_FS_TREE: 0xa4,
  FS_TREE: 0xa5,
  FS_TREE_CHANGED: 0xa6,
  MKDIR: 0xa7,
  DELETE_FILE: 0xa8,
  RENAME_FILE: 0xa9,
  FS_OP_RESULT: 0xaa,

  EDITOR_PRESENCE: 0xab,

  FREDDIE_MESSAGE: 0xac,

  PEER_RTT_TABLE: 0xc1,
  HOST_MIGRATE: 0xad,

  TERRAIN_SCULPT: 0xae,
  TERRAIN_SCULPT_ACK: 0xaf,

  TERRAIN_PAINT_BIOME: 0xb0,
  TERRAIN_PAINT_BIOME_ACK: 0xb1,

  GRASS_DECAL_STAMP: 0xb2,
  GRASS_DECAL_SYNC: 0xb3,

  TIME_OF_DAY_SYNC: 0xb4,

  WEATHER_SYNC: 0xb5,

  TERRAIN_SCULPT_SYNC: 0xb6,

  MIGRATE: 0xb7,
  MIGRATE_ACK: 0xb8,

  NOSTR_AUTH_CHALLENGE: 0xb9,
  NOSTR_AUTH_RESPONSE: 0xba,

  EDIT_OP_LOG: 0xbb,

  AGENT_EDIT_PROPOSE: 0xbc,
  AGENT_EDIT_LIST: 0xbd,
  AGENT_EDIT_APPROVE: 0xbe,
  AGENT_EDIT_REJECT: 0xbf,

  EDIT_OP_LOG_SINCE: 0xc0,

  TELEPORT: 0xc2,
  TELEPORT_ACK: 0xc3,

  COLLISION_CONFIG: 0xc4,
  COLLISION_TILE: 0xc5,

  CHART_REANCHOR: 0xc6,

  CLUSTER_HANDOFF: 0xc7
})

const nameMap = new Map()
for (const [name, id] of Object.entries(MSG)) {
  if (nameMap.has(id)) throw new Error(`[MessageTypes] message id 0x${id.toString(16)} is declared by both ${nameMap.get(id)} and ${name}`)
  nameMap.set(id, name)
}

// An unregistered id answers a named string, never null: a null leaks into logs and comparisons
// as an absent value, and `=== false` tests in callers never match it.
export function isRegisteredMessage(id) {
  return nameMap.has(id)
}

export function msgName(id) {
  return nameMap.has(id) ? nameMap.get(id) : `unknown(0x${Number(id).toString(16)})`
}

export let UNRELIABLE_MSGS = new Set([
  MSG.HEARTBEAT, MSG.HEARTBEAT_ACK, MSG.SNAPSHOT, MSG.INPUT, MSG.STATE_CORRECTION, MSG.DELTA_UPDATE,
  MSG.PLAYER_INPUT, MSG.CLIENT_PERF, MSG.CLIENT_STATE, MSG.FREDDIE_MESSAGE, MSG.TIME_OF_DAY_SYNC, MSG.PEER_RTT_TABLE
])

// An unregistered id is not unreliable: it answers a strict false, so `=== false` and a truthiness
// test agree on it. The unknown id itself is reported by msgName.
export function isUnreliable(type) {
  return nameMap.has(type) && UNRELIABLE_MSGS.has(type)
}

export let DISCONNECT_REASONS = Object.freeze({
  NORMAL: 0,
  TIMEOUT: 1,
  KICKED: 2,
  SERVER_SHUTDOWN: 3,
  INVALID_SESSION: 4,
  RATE_LIMITED: 5,
  PROTOCOL_MISMATCH: 6
})

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapMessageTypes = (next) => {
  msgName = next.msgName
  isUnreliable = next.isUnreliable
  isRegisteredMessage = next.isRegisteredMessage
  WIRE_PROTOCOL_VERSION = next.WIRE_PROTOCOL_VERSION
  MSG = next.MSG
  UNRELIABLE_MSGS = next.UNRELIABLE_MSGS
  DISCONNECT_REASONS = next.DISCONNECT_REASONS
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapMessageTypes)
