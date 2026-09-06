const TAU = 2 * Math.PI
const QSCALE = 511 * Math.SQRT2
const Q1 = 100

// Must mirror src/netcode/SnapshotEncoder.js unpackQuat's unrolled-per-maxIdx-branch form exactly
// (same 4 flat branches instead of a QUAT_IDX[] lookup + loop -- this is the hottest per-frame
// client decode path).
function unpackQuat(packed, out) {
  const maxIdx = (packed >>> 30) & 0x3
  const c2 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c1 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2; packed = packed >>> 10
  const c0 = (packed & 0x3FF) / QSCALE - Math.SQRT1_2
  const sumSq = c0 * c0 + c1 * c1 + c2 * c2
  const m = Math.sqrt(Math.max(0, 1 - sumSq))
  switch (maxIdx) {
    case 0: out[1] = c0; out[2] = c1; out[3] = c2; out[0] = m; break
    case 1: out[0] = c0; out[2] = c1; out[3] = c2; out[1] = m; break
    case 2: out[0] = c0; out[1] = c1; out[3] = c2; out[2] = m; break
    default: out[0] = c0; out[1] = c1; out[2] = c2; out[3] = m; break
  }
  return out
}

// Mirrors src/netcode/SnapshotEncoder.js packBinRecord byte layout exactly (23 bytes: pos i16x3,
// vel i16x3, quat u32, scale u16x3, flags u8, all little-endian). Reads directly into the caller's
// scratch object -- no allocation per decode call, matching this file's pooled-slot decode pattern.
// Direct little-endian byte reads (no DataView allocated per decoded record -- this runs once per
// player + once per changed entity per snapshot): `(lo | hi << 8) << 16 >> 16` sign-extends exactly like
// DataView.getInt16(le); the u32 quat multiplies the top byte in so it stays unsigned. Must stay in sync
// with src/netcode/SnapshotBinFormat.js unpackBinRecord.
const _bin = { px:0, py:0, pz:0, vx:0, vy:0, vz:0, qrot:0, sx:1, sy:1, sz:1, flags:0 }
function unpackBinRecord(buf) {
  const b = buf instanceof DataView ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf
  _bin.px = (((b[0] | (b[1] << 8)) << 16) >> 16) / Q1; _bin.py = (((b[2] | (b[3] << 8)) << 16) >> 16) / Q1; _bin.pz = (((b[4] | (b[5] << 8)) << 16) >> 16) / Q1
  _bin.vx = (((b[6] | (b[7] << 8)) << 16) >> 16) / Q1; _bin.vy = (((b[8] | (b[9] << 8)) << 16) >> 16) / Q1; _bin.vz = (((b[10] | (b[11] << 8)) << 16) >> 16) / Q1
  _bin.qrot = (b[12] | (b[13] << 8) | (b[14] << 16)) + b[15] * 16777216
  _bin.sx = (b[16] | (b[17] << 8)) / Q1; _bin.sy = (b[18] | (b[19] << 8)) / Q1; _bin.sz = (b[20] | (b[21] << 8)) / Q1
  _bin.flags = b[22]
  return _bin
}

function makePlayerSlot() {
  return { id: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: false, health: 100, inputSequence: 0, crouch: 0, lookPitch: 0, lookYaw: 0, expr: 0, weapon: 0, tier: 0 }
}

// Player-LOD REDUCED-tier record: [id, i16 x, i16 z, u8 yaw256, tierFlag=1] -- see SnapshotEncoder.js
// encodeReducedPlayer. 5 elements + tierFlag at index 4 distinguishes it from a FULL-tier 7-element
// record (fillPlayerArr below) at the array-length check in fillAnyPlayerArr. Only position.x/z and
// lookYaw are updated -- position.y/rotation/velocity/health/etc are left at whatever the track slot
// already holds (the player's last known FULL state, or slot defaults for a player that was NEVER
// seen at FULL tier, e.g. one who spawned already beyond the FULL/REDUCED cutoff), matching the "coast
// on last known + this cheap update" contract REDUCED tier is designed around.
// BUG FIX: Ensure position[1] (Y coordinate) is always defined. If this is the first snapshot for a
// player and it's REDUCED tier (e.g. a distant player who spawned out of FULL range), position[1]
// would be left undefined from makePlayerSlot, causing later position checks to fail with
// "Number.isFinite(undefined) === false". Always set position[1] to the current value or 0 if unset.
function fillPlayerArrReduced(s, p) {
  s.id = p[0]
  s.position[0] = p[1] / Q1
  if (s.position[1] === undefined) s.position[1] = 0  // Initialize Y if not already set
  s.position[2] = p[2] / Q1
  s.lookYaw = (p[3] || 0) / 256 * TAU
  s.tier = 1
}

// Single dispatch point for the two array wire shapes a `players[]` entry can now take (FULL 7-el vs
// REDUCED 5-el with tierFlag=1 at index 4) -- keeps the two decoders (fillPlayerArr/fillPlayerArrReduced)
// each simple and shape-specific rather than one branchy function.
function fillAnyPlayerArr(s, p) {
  if (p.length === 5 && p[4] === 1) fillPlayerArrReduced(s, p)
  else { fillPlayerArr(s, p); s.tier = 0 }
}

function makeEntitySlot() {
  return { id: 0, model: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], bodyType: 'static', custom: null, scale: [1, 1, 1], sleeping: false }
}

// p[1] = 23-byte packed bin record (pos/vel/quat/scale); p[6] = pitch<<8|yaw; p[7] = expr (u8 compact
// viseme/emote code, OPTIONAL -- see SnapshotEncoder.js encodePlayer's layout comment, this must mirror
// it exactly). p[7]||0 keeps this decoder backwards-compatible with any pre-expr 7-element wire record.
// p[8] = weapon (u8 compact equipped-weapon code, OPTIONAL, see src/shared/WeaponCodes.js --
// animation-weapon-signal-clientside-wiring). p[8]||0 keeps this decoder backwards-compatible with any
// pre-weapon 8-element wire record, same discipline as p[7]/expr above.
function fillPlayerArr(s, p) {
  s.id = p[0]
  const bin = unpackBinRecord(p[1])
  s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz
  unpackQuat(bin.qrot, s.rotation)
  s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz
  s.onGround = p[2] === 1; s.health = p[3]; s.inputSequence = p[4]; s.crouch = p[5] || 0
  s.lookPitch = (((p[6] || 0) >> 8) & 0xFF) / 255 * Math.PI - Math.PI / 2   // 8-bit pitch over [-pi/2,pi/2]
  s.lookYaw = ((p[6] || 0) & 0xFF) / 256 * TAU                              // 8-bit yaw over [0,2pi)
  s.expr = p[7] || 0
  s.weapon = p[8] || 0
}

function fillPlayerObj(s, p) {
  s.id = p.id || p.i
  const pos = p.position; const rot = p.rotation; const vel = p.velocity
  if (pos) { s.position[0] = pos[0]; s.position[1] = pos[1]; s.position[2] = pos[2] }
  else { s.position[0] = 0; s.position[1] = 0; s.position[2] = 0 }
  if (rot) { s.rotation[0] = rot[0]; s.rotation[1] = rot[1]; s.rotation[2] = rot[2]; s.rotation[3] = rot[3] }
  else { s.rotation[0] = 0; s.rotation[1] = 0; s.rotation[2] = 0; s.rotation[3] = 1 }
  if (vel) { s.velocity[0] = vel[0]; s.velocity[1] = vel[1]; s.velocity[2] = vel[2] }
  else { s.velocity[0] = 0; s.velocity[1] = 0; s.velocity[2] = 0 }
  s.onGround = p.onGround ?? false; s.health = p.health ?? 100
  // must preserve server inputSequence -- zeroing it breaks reconciliation acks (re-predicts every input each snapshot)
  s.inputSequence = p.inputSequence ?? 0; s.crouch = p.crouch ?? 0; s.lookPitch = p.lookPitch ?? 0; s.lookYaw = p.lookYaw ?? 0
  s.expr = p.expr ?? 0
  s.weapon = p.weapon ?? 0
  s.tier = 0
}

const FIELD_POS = 1 << 0
const FIELD_ROT = 1 << 1
const FIELD_VEL = 1 << 2
const FIELD_SCALE = 1 << 3
const FIELD_BODY = 1 << 4
const FIELD_CUSTOM = 1 << 5
const FIELD_SLEEP = 1 << 6
const FIELD_MODEL = 1 << 7

// `fields` is the whole [id, mask, ...fields] delta record built by computeFieldDelta in
// SnapshotEncoder.js, read from base offset `fi` (2) -- no per-entity slice() copy of the tail --
// POS/ROT/VEL/SCALE all changing at once still costs exactly ONE bin-buffer slot (the whole 23-byte
// record is re-sent together), never 4 separate sub-writes.
function applyFieldDelta(s, mask, fields, fi) {
  if (mask & FIELD_MODEL) { s.model = fields[fi]; fi++ }
  if (mask & (FIELD_POS|FIELD_ROT|FIELD_VEL|FIELD_SCALE)) {
    const bin = unpackBinRecord(fields[fi]); fi++
    if (mask & FIELD_POS) { s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz }
    if (mask & FIELD_ROT) unpackQuat(bin.qrot, s.rotation)
    if (mask & FIELD_VEL) { s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz }
    if (mask & FIELD_SCALE) { s.scale[0] = bin.sx; s.scale[1] = bin.sy; s.scale[2] = bin.sz }
  }
  if (mask & FIELD_BODY) { s.bodyType = fields[fi]; fi++ }
  if (mask & FIELD_CUSTOM) { s.custom = fields[fi]; fi++ }
  if (mask & FIELD_SLEEP) { s.sleeping = fields[fi] === 1; fi++ }
}

// e[2] = 23-byte packed bin record (pos/vel/quat/scale); mirrors SnapshotEncoder.js fillEntityEnc.
function fillEntityArr(s, e) {
  if (typeof e[1] === 'number') {
    applyFieldDelta(s, e[1], e, 2)
    return
  }
  s.id = e[0]; s.model = e[1]
  const bin = unpackBinRecord(e[2])
  s.position[0] = bin.px; s.position[1] = bin.py; s.position[2] = bin.pz
  unpackQuat(bin.qrot, s.rotation)
  s.velocity[0] = bin.vx; s.velocity[1] = bin.vy; s.velocity[2] = bin.vz
  s.bodyType = e[3]; s.custom = e[4]
  s.scale[0] = bin.sx; s.scale[1] = bin.sy; s.scale[2] = bin.sz
  s.sleeping = e[5] === 1
}

function fillEntityObj(s, e) {
  s.id = e.id; s.model = e.model
  const pos = e.position; const rot = e.rotation; const vel = e.velocity; const sc = e.scale
  if (pos) { s.position[0] = pos[0]; s.position[1] = pos[1]; s.position[2] = pos[2] }
  else { s.position[0] = 0; s.position[1] = 0; s.position[2] = 0 }
  if (rot) { s.rotation[0] = rot[0]; s.rotation[1] = rot[1]; s.rotation[2] = rot[2]; s.rotation[3] = rot[3] }
  else { s.rotation[0] = 0; s.rotation[1] = 0; s.rotation[2] = 0; s.rotation[3] = 1 }
  if (vel) { s.velocity[0] = vel[0]; s.velocity[1] = vel[1]; s.velocity[2] = vel[2] }
  else { s.velocity[0] = 0; s.velocity[1] = 0; s.velocity[2] = 0 }
  s.bodyType = e.bodyType || 'static'; s.custom = e.custom || null
  if (sc) { s.scale[0] = sc[0]; s.scale[1] = sc[1]; s.scale[2] = sc[2] }
  else { s.scale[0] = 1; s.scale[1] = 1; s.scale[2] = 1 }
}

// Deep-copy a decoded track slot into an independent buffer entry. The jitter buffer / interpolation holds
// older+newer entries across frames, so entries must never alias the reused track slot. These are the ONLY
// place buffer entries are produced -- decoding itself is done once, by fillPlayer*/fillEntity* above.
//
// GC-pressure fix (measured, see AGENTS.md gc-pressure-audit-offscreencanvas-frame-pacing): the naive form
// of this function allocated a fresh object + 3 fresh arrays PER PLAYER/ENTITY PER SNAPSHOT -- measured
// ~123KB/call (60 players + 200 entities/snapshot) pre-GC heap churn via a real process.memoryUsage()
// harness against this exact module, and ~94.5KB/call via a real Chrome performance.memory measurement
// (direct Playwright). Buffer entries still need to be independent (never alias the live track slot OR
// each other, since JitterBuffer holds many of them concurrently as older/newer interpolation brackets and
// SmoothInterpolation.getDisplayState mutates a rendered entry's position/velocity arrays in place) --
// but "independent" only requires each entry to own its OWN storage, not that storage be freshly allocated
// every call. Fix: a per-SnapshotProcessor free-list pool of reusable state objects (SlotPool below),
// recycled via the SnapshotProcessor-owned _releaseQueue/_maybeReleaseOldest FIFO (see SNAPSHOT_RELEASE_
// WINDOW's comment for the safety invariant against JitterBuffer's own eviction window), so a pooled slot
// is never handed out while still referenced by a live buffer entry. copyPlayerStateInto/copyEntityStateInto
// take an explicit destination object (from the pool, via SnapshotProcessor.processSnapshot/_handleEntity)
// and overwrite its fields/array elements in place instead of allocating. Result: ~56.5KB/call (Node,
// steady-state pool) / ~43.4KB/call (real Chrome) -- a ~54% reduction in both environments.
function copyPlayerStateInto(dst, s) {
  dst.id = s.id
  // Ensure arrays exist and are not null/undefined -- the slot may be recycled from the pool and
  // dst.position/rotation/velocity must be ready to receive values. A stale null reference would cause
  // copyPlayerStateInto to throw when trying to assign to dst.position[0]. This guards the rare race
  // where a pooled slot's array reference is stale.
  if (!dst.position) dst.position = [0, 0, 0]
  if (!dst.rotation) dst.rotation = [0, 0, 0, 1]
  if (!dst.velocity) dst.velocity = [0, 0, 0]
  dst.position[0] = s.position[0]; dst.position[1] = s.position[1]; dst.position[2] = s.position[2]
  dst.rotation[0] = s.rotation[0]; dst.rotation[1] = s.rotation[1]; dst.rotation[2] = s.rotation[2]; dst.rotation[3] = s.rotation[3]
  dst.velocity[0] = s.velocity[0]; dst.velocity[1] = s.velocity[1]; dst.velocity[2] = s.velocity[2]
  dst.onGround = s.onGround; dst.health = s.health; dst.inputSequence = s.inputSequence; dst.crouch = s.crouch
  dst.lookPitch = s.lookPitch; dst.lookYaw = s.lookYaw; dst.tier = s.tier || 0
  dst.expr = s.expr || 0; dst.weapon = s.weapon || 0
  return dst
}

function copyEntityStateInto(dst, s) {
  dst.id = s.id; dst.model = s.model
  dst.position[0] = s.position[0]; dst.position[1] = s.position[1]; dst.position[2] = s.position[2]
  dst.rotation[0] = s.rotation[0]; dst.rotation[1] = s.rotation[1]; dst.rotation[2] = s.rotation[2]; dst.rotation[3] = s.rotation[3]
  dst.velocity[0] = s.velocity[0]; dst.velocity[1] = s.velocity[1]; dst.velocity[2] = s.velocity[2]
  dst.bodyType = s.bodyType; dst.custom = s.custom
  dst.scale[0] = s.scale[0]; dst.scale[1] = s.scale[1]; dst.scale[2] = s.scale[2]
  dst.sleeping = s.sleeping
  return dst
}

// Free-list pool of reusable buffer-entry state objects (see the copyPlayerStateInto/copyEntityStateInto
// comment above for the full rationale). A buffer entry stays referenced by JitterBuffer for as long as
// it's within the buffer (up to maxSize entries, evicted oldest-first by shift() on overflow or by age),
// so slots can only be safely recycled once SnapshotProcessor itself knows a given snapshot's slots can no
// longer be referenced -- see SnapshotProcessor._maybeReleaseOldest()/SNAPSHOT_RELEASE_WINDOW below, which
// tracks every produced snapshot in a FIFO (_releaseQueue) and releases the oldest entry's slots back to
// the pool once the queue exceeds a window comfortably larger than JitterBuffer's own eviction window --
// by construction always already outside JitterBuffer's live range by the time it's recycled, entirely
// self-contained within this module (no cross-module release call required from the caller). Never shrinks
// (free-list only grows via makeSlot on exhaustion), so a config with more buffered snapshots or more
// players/entities than the initial window self-heals into a larger steady-state pool rather than ever
// handing out a slot that's still live -- correctness over minimal footprint.
class SlotPool {
  constructor(makeSlot) {
    this._make = makeSlot
    this._free = []
  }
  acquire() { return this._free.length ? this._free.pop() : this._make() }
  release(slot) { this._free.push(slot) }
}

// A REDUCED-tier player is legitimately omitted from players[] on most snapshots (see
// SnapshotEncoder.js filterEncodedPlayersTiered's reducedTickMod throttle, ~PLAYER_LOD_REDUCED_HZ):
// that omission means "no update this tick", not "no longer relevant". Without a grace window the
// absence-based prune below (pre-existing, driven by _seenPlayers membership) would delete+rejoin a
// REDUCED player's track slot every throttled-off tick, firing spurious onPlayerLeft/onPlayerJoined
// and resetting any per-player accumulated client state (anim blend, LOD hysteresis) every cycle. A
// FULL-tier player is expected on every relevant snapshot, so its grace window is tiny (1 tick, i.e.
// none beyond ordinary jitter) -- absence still means "truly gone" almost immediately for them.
const REDUCED_TIER_ABSENCE_GRACE = 40  // snapshots; generous relative to a ~4-8x reducedTickMod throttle

// How many past produced snapshots' player/entity slot arrays SnapshotProcessor keeps un-recycled
// before releasing the oldest back to the pool. Must stay comfortably above JitterBuffer's default
// maxSize (64, see JitterBuffer.js) -- a buffered snapshot is only ever referenced while it's within
// JitterBuffer's own window (bounded by maxSize entries AND an age-based cutoff, whichever evicts
// first), so retaining strictly MORE history here than JitterBuffer ever holds guarantees a released
// snapshot's slots are always already unreferenced by the time they're recycled, with no cross-module
// coordination required. 96 = 64 (default maxSize) + 50% headroom for a caller-configured larger maxSize.
const SNAPSHOT_RELEASE_WINDOW = 96

export class SnapshotProcessor {
  constructor(config = {}) {
    this._playerStates = new Map()
    this._entityStates = new Map()
    this.lastSnapshotTick = 0
    this._callbacks = config.callbacks || {}
    this._seenPlayers = new Set()
    this._seenEntities = new Set()
    this._deltaFailures = 0
    this._deltaFailureIds = new Set()
    // pid -> the processSnapshot() call-count at which this player was last present in players[].
    // Call-count (not server tick) so the grace window is robust to variable snapshot cadence and to
    // the caller skipping ticks with no new snapshot.
    this._lastSeenCall = new Map()
    this._callCount = 0
    // GC-pressure fix: pooled player/entity buffer-entry slots (see SlotPool + copyPlayerStateInto/
    // copyEntityStateInto comments above) plus a FIFO history of produced snapshots' slot arrays, so
    // slots can be safely recycled once they fall outside SNAPSHOT_RELEASE_WINDOW calls of history.
    this._playerSlotPool = new SlotPool(makePlayerSlot)
    this._entitySlotPool = new SlotPool(makeEntitySlot)
    this._releaseQueue = []
  }

  // Recycles the oldest produced snapshot's player/entity slots back into the pools once the release
  // queue exceeds SNAPSHOT_RELEASE_WINDOW -- see that constant's comment for the safety invariant.
  _maybeReleaseOldest() {
    if (this._releaseQueue.length <= SNAPSHOT_RELEASE_WINDOW) return
    const oldest = this._releaseQueue.shift()
    for (const slot of oldest.players) this._playerSlotPool.release(slot)
    for (const slot of oldest.entities) this._entitySlotPool.release(slot)
  }

  processSnapshot(data, tick) {
    this.lastSnapshotTick = tick
    this._callCount++
    const snapshotForBuffer = { tick: data.tick || 0, timestamp: data.timestamp || Date.now(), players: [], entities: [] }
    // Player-LOD DOT-tier crowd aggregate (see SnapshotEncoder.js buildCrowdDots): [[cellX,cellZ,count],...],
    // passed straight through with no per-player identity -- consumed by client/core/PlayerLOD.js's
    // crowd-dot renderer, never turned into a tracked player.
    if (data.dots) snapshotForBuffer.dots = data.dots

    this._seenPlayers.clear()
    for (const p of data.players || []) {
      const pid = Array.isArray(p) ? p[0] : (p.id || p.i)
      this._seenPlayers.add(pid)
      this._lastSeenCall.set(pid, this._callCount)
      let track = this._playerStates.get(pid)
      if (track) {
        if (Array.isArray(p)) fillAnyPlayerArr(track, p); else fillPlayerObj(track, p)
      } else {
        track = makePlayerSlot()
        if (Array.isArray(p)) fillAnyPlayerArr(track, p); else fillPlayerObj(track, p)
        this._playerStates.set(pid, track)
        // DEBUG: Trace player join to catch position issues early
        if (typeof window !== 'undefined' && window.__dbgSnap) console.log('[SnapProc] onPlayerJoined id=' + pid + ' pos=' + JSON.stringify(track.position))
        this._callbacks.onPlayerJoined?.(pid, track)
      }
      // Buffer entries are decoded ONCE via the authoritative fillAnyPlayerArr/fillPlayerObj (into the
      // pooled track slot), then a DEEP COPY is pushed -- never the track slot itself, since
      // interpolateSnapshot holds older/newer buffer entries across frames and aliasing the pool would
      // corrupt interpolation. (Replaces the removed parsePlayerNew, a second hand-written decoder that
      // had drifted to a stale 4-bit look-angle layout; one decoder makes wire-layout drift structurally
      // impossible.) A REDUCED-tier record (fillPlayerArrReduced) intentionally leaves every field it
      // doesn't carry (y, rotation, velocity, health, ...) at the track's last known value, so the
      // pushed copy still has a complete, renderable player state -- just with stale non-position/yaw
      // fields between REDUCED updates, exactly the coast-on-last-known contract this tier is for.
      // GC-pressure fix: copy target is now a pooled slot (copyPlayerStateInto overwrites in place)
      // instead of a fresh object+3 fresh arrays every call -- see SlotPool/SNAPSHOT_RELEASE_WINDOW.
      // BUG FIX (e2e-cross-client-remote-player-null-flake): track.position, track.rotation, track.velocity
      // must be guaranteed non-null before copying, as copyPlayerStateInto updates arrays in-place and
      // a null reference would cause a TypeError. See SnapshotProcessor's slot-pool recycling and
      // fillPlayerArrReduced's incomplete state initialization.
      if (!track.position || !track.rotation || !track.velocity) {
        if (typeof window !== 'undefined' && window.__dbgSnap) console.error('[SnapProc] NULL ARRAYS BUG DETECTED: id=' + pid + ' pos=' + track.position + ' rot=' + track.rotation + ' vel=' + track.velocity)
        if (!track.position) track.position = [0, 0, 0]
        if (!track.rotation) track.rotation = [0, 0, 0, 1]
        if (!track.velocity) track.velocity = [0, 0, 0]
      }
      snapshotForBuffer.players.push(copyPlayerStateInto(this._playerSlotPool.acquire(), track))
    }
    for (const [pid, track] of this._playerStates) {
      if (this._seenPlayers.has(pid)) continue
      // FULL-tier (track.tier===0) absence still prunes immediately -- unchanged behavior. A
      // REDUCED-tier track (tier===1) only prunes after REDUCED_TIER_ABSENCE_GRACE consecutive
      // processSnapshot() calls with no sighting, distinguishing "throttled-off tick" from "actually
      // out of relevance range / disconnected". While inside the grace window the stale track is still
      // pushed into snapshotForBuffer.players so rendering keeps coasting on last known state.
      if (track.tier === 1) {
        const lastSeen = this._lastSeenCall.get(pid) || 0
        if (this._callCount - lastSeen < REDUCED_TIER_ABSENCE_GRACE) {
          snapshotForBuffer.players.push(copyPlayerStateInto(this._playerSlotPool.acquire(), track))
          continue
        }
      }
      this._playerStates.delete(pid); this._lastSeenCall.delete(pid); this._callbacks.onPlayerLeft?.(pid)
    }

    this._processEntities(data, snapshotForBuffer)
    this._releaseQueue.push(snapshotForBuffer)
    this._maybeReleaseOldest()
    return snapshotForBuffer
  }

  _handleEntity(e, snapshotForBuffer) {
    const eid = Array.isArray(e) ? e[0] : e.id
    let track = this._entityStates.get(eid)
    const isFieldDelta = Array.isArray(e) && typeof e[1] === 'number'
    if (isFieldDelta) {
      if (!track) {
        this._deltaFailures++
        this._deltaFailureIds.add(eid)
        if (this._deltaFailures < 10) this._callbacks.onDeltaCorruption?.(eid)
        if (this._deltaFailures >= 10) this._callbacks.onFullSnapshotRequested?.()
        return eid
      }
      fillEntityArr(track, e)
      // GC-pressure fix: pooled slot overwritten in place instead of a fresh object + 3 fresh
      // [...spread] arrays every field-delta entity every snapshot -- see SlotPool comment above.
      snapshotForBuffer.entities.push(copyEntityStateInto(this._entitySlotPool.acquire(), track))
    } else {
      if (track) {
        if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
      } else {
        track = makeEntitySlot()
        if (Array.isArray(e)) fillEntityArr(track, e); else fillEntityObj(track, e)
        this._entityStates.set(eid, track)
        this._callbacks.onEntityAdded?.(eid, track)
      }
      // Decode ONCE into the track slot (authoritative fillEntityArr/fillEntityObj), then push a DEEP COPY
      // -- the same pattern the field-delta branch above already uses. Replaces the removed parseEntityNew
      // (a second hand-written decoder + a provably-dead _fieldDelta branch read nowhere).
      snapshotForBuffer.entities.push(copyEntityStateInto(this._entitySlotPool.acquire(), track))
    }
    return eid
  }

  _processEntities(data, snapshotForBuffer) {
    if (data.delta) {
      for (const e of data.entities || []) this._handleEntity(e, snapshotForBuffer)
      if (data.removed) {
        for (const eid of data.removed) {
          if (this._entityStates.has(eid)) { this._entityStates.delete(eid); this._callbacks.onEntityRemoved?.(eid) }
        }
      }
    } else {
      this._seenEntities.clear()
      for (const e of data.entities || []) this._seenEntities.add(this._handleEntity(e, snapshotForBuffer))
      for (const eid of this._entityStates.keys()) {
        if (!this._seenEntities.has(eid)) { this._entityStates.delete(eid); this._callbacks.onEntityRemoved?.(eid) }
      }
    }
  }

  getPlayerState(pid) { return this._playerStates.get(pid) }
  getAllPlayerStates() { return this._playerStates }
  getEntity(eid) { return this._entityStates.get(eid) }
  getAllEntities() { return this._entityStates }
  removePlayer(pid) { this._playerStates.delete(pid); this._lastSeenCall.delete(pid) }
  clear() { this._playerStates.clear(); this._entityStates.clear(); this._lastSeenCall.clear() }
}
