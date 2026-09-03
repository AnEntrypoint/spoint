// bump when a required wire field/payload shape changes, so client/server mismatch is detected via HANDSHAKE_ACK
export const WIRE_PROTOCOL_VERSION = 1

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

  // Multi-user editor presence: a human editor's own entity-selection/drag broadcast to every OTHER
  // connected editor, so two makers editing the same world at once see who has what selected (editor-multiuser-presence-locks).
  EDITOR_PRESENCE: 0xab,

  // Freddie bridge: agent-to-spoint visualization messages (flagship-demo-freddie-spoint-bridge)
  FREDDIE_MESSAGE: 0xac,

  // P2P host-migration (BrowserServer/wireweave rooms only -- no-op on the WS server path). PEER_RTT_TABLE
  // is a periodic broadcast of {[playerId]: rttMs} for every connected client, built from the same
  // EWMA client.rtt ServerHandlers.js already computes per HEARTBEAT round trip -- every joiner gets an
  // identical, symmetric view of who has the lowest ping without any peer-to-peer ping mesh (the wireweave
  // room is a star topology: only the host has an RTC data channel to each joiner). HOST_MIGRATE is a
  // best-effort broadcast the CURRENT host sends immediately before a graceful handoff (see
  // client/HostMigration.js) so the elected next host can seed its world state from a live-fresh
  // snapshot instead of falling back to its own last-received one; it is NOT required for migration to
  // work (an ungraceful host loss -- crash/network drop -- has no opportunity to send it, and the elected
  // peer instead reconstructs from its own already-current SnapshotProcessor state, which is always at
  // most one snapshot-interval stale).
  PEER_RTT_TABLE: 0xac,
  HOST_MIGRATE: 0xad,

  // Terrain sculpting brush (raise + lower + smooth + flatten -- see src/terrain/HeightDelta.js).
  // Client sends TERRAIN_SCULPT {brush:'raise'|'lower'|'smooth'|'flatten', x, z, radius, strength} at
  // the brush's local-XZ world position. `strength` contract varies by brush: raise/lower take a
  // positive METRES magnitude (server negates it for 'lower'); smooth/flatten take a [0,1] blend factor
  // (0=no change, 1=fully applied) -- flatten's strength is additionally OPTIONAL, defaulting server-side
  // to 1 (fully flattened) since "how flat" has a sensible on/off default unlike the other three brushes.
  // flatten pins every touched cell's composed (base+delta) height to the surface sampled at the brush
  // CENTER, so it blends into surrounding slopes via the same cosine falloff rather than showing a hard
  // flat-top disc. Server applies the stroke to the shared per-world HeightDelta store, rebuilds the
  // collider heightFn through it (mirrors the TERRAIN_RESEED handler shape), and acks with the resulting
  // cell/stroke counts (+ targetHeight for flatten) so the editor UI can confirm the stamp landed
  // without needing a full heightfield read-back itself.
  TERRAIN_SCULPT: 0xae,
  TERRAIN_SCULPT_ACK: 0xaf,

  // Paint-biome brush (fourth/final slice of the raise/lower/smooth/flatten sculpt-brush epic -- see
  // src/terrain/BiomeOverride.js). Distinct payload shape from TERRAIN_SCULPT: a biome ID string instead
  // of a height-magnitude strength, since this brush overrides the per-cell CLIMATE tuple
  // (temp/humidity/erosion) consumed by src/terrain/VegPlacement.js/RockPlacement.js/GrassPlacement.js's
  // classify() rather than a height offset -- painting "desert" over a forest changes what grows there,
  // it does not raise or lower the ground. Client sends TERRAIN_PAINT_BIOME {biome, x, z, radius,
  // strength} where `biome` is one of BiomeOverride.BIOME_NAMES and `strength` is a [0,1] blend factor
  // (0=no change, 1=fully painted), same contract/default (1) as the flatten/smooth brushes. Server
  // applies the stroke to the shared per-world BiomeOverride store, re-cooks the trunk/rock collider
  // streamers' chunk-placement caches around the current center (species/density is a placement-time
  // decision, not a persistent body property, so a repaint needs those streamers' cached classify()
  // output invalidated -- see ColliderStreamer.js's clearChunkCache), and acks with the resulting
  // cell/stroke counts mirroring TERRAIN_SCULPT_ACK's shape.
  TERRAIN_PAINT_BIOME: 0xb0,
  TERRAIN_PAINT_BIOME_ACK: 0xb1,

  // Server-authoritative grass decal persistence + replication (follow-up to the client-only/in-memory
  // grass decal regrowth system, see src/terrain/GrassDecal.js). Mirrors TERRAIN_SCULPT/_ACK's shape:
  // client sends GRASS_DECAL_STAMP {x, z, radius, strength} (local planet-frame world metres, same space
  // TERRAIN_SCULPT/entity positions use), the server applies it to a single per-world authoritative
  // GrassDecal store (ctx._grassDecal, lazily created on first stamp -- decals are visual-only and don't
  // need a terrain streamer/collider to exist) and BROADCASTS the resulting stamp (with server-stamped
  // appliedAt) to every connected client via GRASS_DECAL_SYNC {stamps:[{x,z,radius,strength,appliedAt}]}
  // -- a one-stamp array, same shape as the backfill case below, so client code has exactly one array-of-
  // stamps handler instead of two payload shapes. A newly-joining client is backfilled the FULL current
  // decal set (also GRASS_DECAL_SYNC, multiple stamps) once, piggybacked on the existing connect handshake
  // (see ServerHandlers.js's onClientConnect, same resend-on-join pattern voice_identity already uses).
  // Regrowth (strength decaying toward 0 over wall-clock time since appliedAt) is NOT server-ticked or
  // re-broadcast periodically -- every client independently re-derives the same decayed strength from the
  // shared appliedAt timestamp using the identical exponential half-life math already shipped client-side
  // (src/terrain/GrassDecal.js effectiveStrength), since decay is a pure function of elapsed wall-clock
  // time given the same halfLifeS -- deterministic without a new per-tick broadcast channel.
  // NOTE: renumbered from the original 0xb0/0xb1 (collided with TERRAIN_PAINT_BIOME/_ACK, landed
  // concurrently in a sibling worktree) to 0xb2/0xb3 during merge.
  GRASS_DECAL_STAMP: 0xb2,
  GRASS_DECAL_SYNC: 0xb3,

  // Server-authoritative time-of-day sync (follow-up to the local-only client/core/TimeOfDay.js day-cycle
  // clock -- see AGENTS.md/PRD server-clock-synced-time-of-day-network-sync). A periodic COARSE correction
  // broadcast, not a per-tick stream: {t, dayLengthSec} where `t` is the server's own day-cycle fraction
  // [0,1), advanced every server tick but only BROADCAST on a ~5s real-time cadence (see
  // ServerTimeOfDay.js/TickHandler.js -- mirrors the existing ~1Hz PEER_RTT_TABLE cadence pattern above,
  // just a slower interval since a day-cycle fraction changes far more slowly than RTT). Sent once
  // immediately on connect (ServerHandlers.js onClientConnect, join-time
  // correction so a late joiner doesn't free-run from its own default startFraction) and then periodically
  // while server-authoritative mode is enabled for the world (opt-in via worldDef.terrain.timeOfDay.
  // serverAuthoritative -- see client/app.js's existing _todCfg read of the same nested config path).
  // Client applies via TimeOfDay.setFraction() on receipt and keeps running its own per-frame update(dt)
  // locally in between corrections -- smooth local interpolation, never a hard visual snap every sync tick,
  // same discipline netcode already uses for entity position reconciliation.
  TIME_OF_DAY_SYNC: 0xb4,

  // Server-authoritative weather state sync (follow-up to the static-per-world-config-only
  // client/core/Weather.js -- see AGENTS.md/PRD weather-server-driven-state-and-multiplayer-sync).
  // {type, intensity} -- unlike TIME_OF_DAY_SYNC's periodic ~5s heartbeat (a continuously-advancing
  // clock fraction), this is a CHANGE-triggered broadcast only (see ServerWeather.js's shouldBroadcast
  // dirty-flag): weather is a discrete state that can go a whole session without changing, so there is
  // nothing useful to re-send on a fixed cadence. Sent once immediately on connect (ServerHandlers.js
  // onClientConnect, join-time backfill so a late joiner starts from the server's current weather instead
  // of its own world-config static default) and again whenever ServerWeather.setState() actually changes
  // type/intensity while server-authoritative mode is enabled for the world (opt-in via
  // worldDef.terrain.weather.serverAuthoritative -- mirrors terrain.timeOfDay.serverAuthoritative's own
  // opt-in shape). Client applies via the ALREADY-LIVE window.__weatherType/window.__weatherIntensity
  // RenderControls-mirrored globals the weather-update render-graph node reads every frame (client/app.js)
  // -- no new client-side apply path needed, this message just writes those same globals on receipt.
  WEATHER_SYNC: 0xb5,

  // Late-join GPU-visible sculpt-overlay backfill (terrain-sculpt-late-join-gpu-resync, follow-up to
  // terrain-gpu-visible-sculpt-mesh-deformation). client/core/SculptOverlay.js's local HeightDelta mirror
  // starts EMPTY on construction and previously only accumulated strokes from live TERRAIN_SCULPT_ACK
  // broadcasts a client actually witnessed WHILE CONNECTED -- unlike GRASS_DECAL_SYNC's documented
  // join-time backfill above, a client joining a world with pre-existing sculpted terrain saw the
  // server-authoritative COLLIDER correctly reflect every prior stroke (physics/collision was never
  // wrong) but the GPU-RENDERED mesh stayed visually flat at those locations until a new stroke happened
  // to land nearby. Sent ONCE, immediately after the join-time SNAPSHOT (ServerHandlers.js
  // onClientConnect, same resend-on-join slot as GRASS_DECAL_SYNC's backfill just above it), reusing
  // src/terrain/HeightDelta.js's own toJSON() shape verbatim: {ok:true, strokes:[{brush,x,z,radius,
  // strength,targetHeight?}], cellM}. The client replays every non-flatten stroke into its OWN local
  // HeightDelta mirror (flatten strokes need a baseHeightFn the client doesn't have -- same documented
  // gap SculptOverlay.applyStroke's live path already has, see terrain-sculpt-flatten-gpu-visual-parity)
  // then uploads ONE mapspinner uSculptOverride window centered on the joining client's OWN spawn point
  // (gl-render.js's sculpt-override texture is a single fixed window, not a multi-window/tiled store --
  // see SculptOverlay.js's own header comment -- so this is the only window that can usefully be shown
  // immediately; any other historical stroke becomes visible again once the player wanders within range
  // of a live stroke or a future multi-window slice ships). Only sent when the world's shared HeightDelta
  // store actually has strokes (an empty send on every join in the common no-sculpting-yet case is pure
  // waste, mirroring GRASS_DECAL_SYNC's own stampCount>0 guard).
  TERRAIN_SCULPT_SYNC: 0xb6,

  // Live transport migration (client-initiated, session-token-authenticated) -- distinct from
  // RECONNECT/RECONNECT_ACK, which assumes the OLD connection is already dead and destroys+respawns the
  // player entity (broadcasts PLAYER_LEAVE + player_join to every other client). MIGRATE instead re-points
  // an ALREADY-ACTIVE client's transport in place: same playerId, same PlayerManager/NetworkState/physics
  // collider, zero broadcast, zero snapshot-processor/prediction-engine reset. Sent over a SECOND, already
  // fully open candidate transport while the first stays live (see PhysicsNetworkClient.migrateTransport).
  MIGRATE: 0xb7,
  MIGRATE_ACK: 0xb8,

  // Nostr auth challenge (cross-project-identity-nostr-login-flow): server sends a random challenge
  // string, client signs it with their nostr private key and returns the signed event. Server verifies
  // the signature against the claimed pubkey. Opt-in per worldDef.identity.nostrAuth.
  NOSTR_AUTH_CHALLENGE: 0xb9,
  NOSTR_AUTH_RESPONSE: 0xba,

  // Collaborative editor op log (editor-collaborative-crdt-agent-staging-full-flow): server broadcasts
  // every editor operation (SAVE_SOURCE, PLACE_APP, etc.) to all OTHER connected editors so they can
  // replay it locally. Payload carries {type, entityId, payload, editorId, ts, seq}.
  EDIT_OP_LOG: 0xbb,

  // Agent edit staging (editor-collaborative-crdt-agent-staging-full-flow): an agent (freddie, claude,
  // etc.) proposes a set of staged edits. Editor renders ghost previews in-viewport, user approves or
  // rejects per-op or wholesale.
  AGENT_EDIT_PROPOSE: 0xbc,
  AGENT_EDIT_LIST: 0xbd,
  AGENT_EDIT_APPROVE: 0xbe,
  AGENT_EDIT_REJECT: 0xbf,

  // Late-join editor op log replay: a newly-connected editor sends its last known seq,
  // server responds with all ops since then via EDIT_OP_LOG.
  EDIT_OP_LOG_SINCE: 0xc0
}

// Compact VRM viseme/emote expression wire code, PLAYER_INPUT-piggybacked (follow-up to
// animation-vrm-spring-bone-lod-expression-wire's audit: remote player facial expression state --
// client/facial-animation.js's ARKIT_NAMES viseme/emote system -- had ZERO network representation
// before this; a remote player's VRM face was always neutral/idle-blink-only regardless of the driving
// player's actual expression). NOT a distinct message TYPE -- input.expr is a single u8 code (see
// client/core/ExpressionCodes.js EXPR_* constants + nameToCode/pickExpressionCode/applyExpressionCode,
// index into a small fixed table: neutral/happy/sad/angry/surprised/relaxed/aa/ih/ou/ee/oh/blink) added
// additively to the plain PLAYER_INPUT object every one
// of the 3 sendInput implementations already forwards whole (same discipline as the existing
// input._vsync stamp, see project/sim-render-pacing-vsync-input-stamp) -- zero protocol surface change.
// Server stores it on st.expr (TickHandler.js, same flow as st.crouch from inp.crouch) and broadcasts
// it as p[7] on the FULL player wire record (SnapshotEncoder encodePlayer/decode, SnapshotProcessor
// fillPlayerArr; 9 elements as of animation-weapon-signal-clientside-wiring's p[8]=weapon append) --
// REDUCED/dot tier players do not carry expression (position+yaw only, matching that tier's existing
// no-anim-inputs contract). Client applies via pm.setVRMExpression on receipt for every remote id
// (tickPlayerAnimators), so it round-trips through the exact same authoring API
// apps/ctx.players.setExpression already uses locally.

const nameMap = new Map()
for (const [name, id] of Object.entries(MSG)) nameMap.set(id, name)

export function msgName(id) {
  return nameMap.get(id) || `UNKNOWN(0x${id.toString(16)})`
}

export const UNRELIABLE_MSGS = new Set([
  0x03, 0x04, 0x10, 0x11, 0x12, 0x13, 0x22, 0x43, 0x44, 0xac, 0xb4
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
