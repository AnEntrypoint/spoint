import { getComponentSchema, encodeCustomFields, decodeCustomFields } from '../../apps/_lib/ComponentSchema.js'
import {
  BIN_RECORD_BYTES, POS_I16_MAX, SCALE_U16_MAX, clampI16, clampU16Scale,
  packBinRecord, unpackBinRecord, packQuat, unpackQuat
} from './SnapshotBinFormat.js'

// Re-exported from SnapshotBinFormat.js for backward compatibility -- AnimationClipCache.js,
// TickHandler.js, and edge/cf-do/do-client-probe.mjs all import these from this file's own path.
export { unpackBinRecord, packQuat, unpackQuat }

const TAU = 2 * Math.PI, HALF_PI = Math.PI / 2
const VEL_ZERO = [0,0,0]
const SCALE_ONE = [1,1,1]

// p[12]: 8 bits pitch (range [-pi/2,pi/2]) + 8 bits yaw (range [0,2pi)) packed into one uint16
// enc layout (unchanged JS-value slots kept native; numeric fixed fields moved into enc[1] as a
// packed 23-byte Uint8Array via packBinRecord/unpackBinRecord -- see the binary-record block above):
//   enc[0]=id, enc[1]=bin(23 bytes: pos i16x3, vel i16x3, quat u32, scale u16x3, flags u8),
//   enc[2]=onGround, enc[3]=health, enc[4]=inputSequence, enc[5]=crouch (bit-packed flags: bit0=crouch,
//   bit1=swimming -- see TickHandler.js's crouchFlags; kept in the same wire slot, zero protocol-shape
//   change, since every consumer already only tests truthiness/masks bits, never `=== 1`), enc[6]=lookPitch<<8|lookYaw,
//   enc[7]=expr (u8 compact viseme/emote code, see client/core/ExpressionCodes.js --
//   animation-vrm-spring-bone-lod-expression-wire). p[7] is OPTIONAL on decode (older/short records
//   default to 0=neutral, see decode()/fillPlayerArr's `p[7]||0` reads) so this is a backwards-compatible
//   append, not a breaking layout change to the existing 7-element shape.
//   enc[8]=weapon (u8 compact equipped-weapon code, see src/shared/WeaponCodes.js --
//   animation-weapon-signal-clientside-wiring), server-authoritative. p[8] is OPTIONAL on decode (older/
//   shorter records default to 0=unarmed, see decode()/fillPlayerArr's `p[8]||0` reads), same
//   backwards-compatible append discipline as p[7]/expr above.
const PLAYER_FLAG_ONGROUND = 1 << 0
function encodePlayer(p) {
  const [px,py,pz]=p.position, [rx,ry,rz,rw]=p.rotation, [vx,vy,vz]=p.velocity
  const pitchN=Math.max(0,Math.min(255,Math.round(((p.lookPitch||0)+HALF_PI)/Math.PI*255)))
  const yawN=Math.round(((p.lookYaw||0)%TAU+TAU)%TAU/TAU*256)&0xFF
  const bin = packBinRecord(px,py,pz, packQuat(rx,ry,rz,rw), vx,vy,vz, 1,1,1, p.onGround?PLAYER_FLAG_ONGROUND:0)
  return [p.id, bin, p.onGround?1:0, Math.round(p.health||0), p.inputSequence||0, p.crouch||0, (pitchN<<8)|yawN, p.expr||0, p.weapon||0]
}

// --- Player LOD tiers (player-lod-tiers-gpu-skinned-instanced-avatars-for-1000-player-r) --------
// Full per-player state (anim inputs, health, look, velocity, precise position) is only worth its
// wire cost for the ~30 nearest players a viewer can actually resolve detail on. Players in the next
// ring only need position+yaw, and only at a throttled rate (~5Hz, i.e. every Nth snapshot tick) --
// enough for a reduced/impostor-tier avatar to track them without full-state cost. Anything past the
// dot cutoff is aggregated into on-wire dot positions (see buildCrowdDots) instead of a per-player
// record at all, so a 1000-player crowd does not linearly inflate the snapshot even before considering
// render cost. Tier thresholds are distance^2 in world metres (viewer-relative), matching the existing
// entity NEAR2/MID2 convention above.
export const PLAYER_LOD_FULL_COUNT = 30       // nearest N players (by distance) always get FULL tier, distance-independent
export const PLAYER_LOD_REDUCED2 = 120 * 120  // next-ring cutoff: REDUCED tier (position+yaw only) inside this radius
export const PLAYER_LOD_REDUCED_TICKMOD = 1   // caller multiplies the snapshot's own reduced-rate cadence in; see reducedTickHz below
export const PLAYER_LOD_REDUCED_HZ = 5        // target on-wire update rate for REDUCED-tier players

export const PLAYER_TIER_FULL = 0
export const PLAYER_TIER_REDUCED = 1
export const PLAYER_TIER_DOT = 2

// Reduced record: [id, i16 x, i16 z (Q1-scaled, same 1cm precision as the full bin record), u8 yaw256, tierFlag].
// No y/velocity/rotation/health/anim inputs -- a REDUCED-tier remote avatar only needs a ground position
// and a facing to drive a lightweight impostor/reduced-pose renderer (see client/core/PlayerLOD.js).
// tierFlag=PLAYER_TIER_REDUCED lets the client's single decode branch (fillPlayerArr today only reads
// p[0..6], so this shorter+differently-typed record must be distinguished BEFORE calling it) route to
// the reduced-record decoder instead.
function encodeReducedPlayer(p) {
  const [px, , pz] = p.position
  const yawN = Math.round(((p.lookYaw || 0) % TAU + TAU) % TAU / TAU * 256) & 0xFF
  return [p.id, clampI16(px), clampI16(pz), yawN, PLAYER_TIER_REDUCED]
}

function dist2(ax, ay, az, bx, by, bz) { const dx = ax-bx, dy = ay-by, dz = az-bz; return dx*dx+dy*dy+dz*dz }

// Aggregates every player beyond the REDUCED ring into coarse dot buckets (grid-quantized world XZ,
// cell size dotCellM) so the DOT tier is O(distinct occupied cells), not O(far-player-count) -- a
// 1000-player crowd clustered in a few areas still produces only a handful of dot records. Returns
// [[cellX, cellZ, count], ...] (3 numbers/bucket, no ids -- dots are a rendering aggregate, never a
// per-entity presence signal, so no player identity is leaked into the far tier).
export function buildCrowdDots(players, viewerPos, dotCellM) {
  if (!players || players.length === 0) return []
  const cell = dotCellM || 25
  const buckets = new Map()
  for (const p of players) {
    const pos = p.position; if (!pos) continue
    const cx = Math.floor(pos[0] / cell), cz = Math.floor(pos[2] / cell)
    const key = cx * 1000003 + cz
    buckets.set(key, (buckets.get(key) || 0) + 1)
  }
  const out = []
  for (const [key, count] of buckets) {
    const cz = key % 1000003
    const cx = (key - cz) / 1000003
    out.push([cx, cz, count])
  }
  return out
}

// Classifies `nearbyIds` (already relevance-filtered, e.g. by appRuntime.nearbyPlayerIds) into three
// tiers relative to viewerPos: the PLAYER_LOD_FULL_COUNT nearest always get FULL; the rest within
// PLAYER_LOD_REDUCED2 get REDUCED; everything further is DOT (returned separately for buildCrowdDots,
// not emitted per-player at all). Pure function of (positions, viewer) -- no snapshot-cadence state,
// so a caller wanting the ~5Hz REDUCED throttle applies it itself (see filterEncodedPlayersTiered).
// `playersById` MUST be a Map<id, player> (the caller builds this once per tick, not per viewer --
// see TickHandler.js's `playersMap`) -- player.id is an arbitrary connection id, never assumed to be
// a dense array index, so a plain array lookup here would silently read the wrong player.
export function classifyPlayerTiers(playersById, nearbyIds, viewerPos, selfId) {
  const vx = viewerPos[0], vy = viewerPos[1], vz = viewerPos[2]
  const near = []
  for (const id of nearbyIds) {
    if (id === selfId) continue
    const p = playersById.get(id)
    if (!p || !p.position) continue
    near.push({ id, p, d2: dist2(p.position[0], p.position[1], p.position[2], vx, vy, vz) })
  }
  near.sort((a, b) => a.d2 - b.d2)
  const full = [], reduced = [], dotPlayers = []
  for (let i = 0; i < near.length; i++) {
    const { id, p, d2 } = near[i]
    if (i < PLAYER_LOD_FULL_COUNT) full.push(id)
    else if (d2 < PLAYER_LOD_REDUCED2) reduced.push(id)
    else dotPlayers.push(p)
  }
  return { full, reduced, dotPlayers }
}

// Builds the tiered players[] wire array for one viewer: FULL-tier ids get their full pre-encoded
// record (from encodedMap, as filterEncodedPlayersWithSelf already did), REDUCED-tier ids get the
// compact position+yaw record -- but only on ticks where (tick % reducedTickMod)===0 for that
// player's id-parity-staggered schedule, so REDUCED players update at ~PLAYER_LOD_REDUCED_HZ instead
// of the full snapshot rate (reducedTickMod is derived by the caller from its own snapshot Hz, e.g.
// snapshotHz/PLAYER_LOD_REDUCED_HZ). On a skipped tick the player is simply omitted from this array
// (not re-sent as "unchanged") -- the client's own JitterBuffer/interpolation already holds the last
// value and coasts on velocity/yaw between updates, same contract as any other delta-omitted field.
// DOT-tier players are never placed in players[] -- the caller separately calls buildCrowdDots on
// `dotPlayers` and ships that as a distinct, much smaller payload field. `playersById` is the same
// Map<id, player> contract as classifyPlayerTiers.
export function filterEncodedPlayersTiered(encodedMap, playersById, nearbyIds, selfId, viewerPos, tick, reducedTickMod) {
  const { full, reduced, dotPlayers } = classifyPlayerTiers(playersById, nearbyIds, viewerPos, selfId)
  const out = []
  const selfEnc = encodedMap.get(selfId); if (selfEnc) out.push(selfEnc)
  for (const id of full) { const enc = encodedMap.get(id); if (enc) out.push(enc) }
  const mod = Math.max(1, reducedTickMod || 1)
  for (const id of reduced) {
    if (mod > 1 && (tick % mod) !== 0) continue
    const p = playersById.get(id)
    if (p) out.push(encodeReducedPlayer(p))
  }
  return { players: out, dots: buildCrowdDots(dotPlayers, viewerPos) }
}

const FIELD_POS = 1 << 0
const FIELD_ROT = 1 << 1
const FIELD_VEL = 1 << 2
const FIELD_SCALE = 1 << 3
const FIELD_BODY = 1 << 4
const FIELD_CUSTOM = 1 << 5
const FIELD_SLEEP = 1 << 6
const FIELD_MODEL = 1 << 7

// enc layout: enc[0]=id, enc[1]=model, enc[2]=bin(23-byte packed pos/vel/rot/scale via
// packBinRecord), enc[3]=bodyType, enc[4]=custom, enc[5]=sleeping(0/1). Delta records read the
// bin buffer's own fields directly (see computeFieldDelta) rather than 8+ separate numeric slots.
function fillEntityEnc(e, enc) {
  const pos=e.position, rot=e.rotation, v=e.velocity||VEL_ZERO, s=e.scale||SCALE_ONE
  const px=pos[0],py=pos[1],pz=pos[2],rx=rot[0],ry=rot[1],rz=rot[2],rw=rot[3]
  enc[0]=e.id; enc[1]=e.model||''
  enc[2]=packBinRecord(px,py,pz, packQuat(rx,ry,rz,rw), v[0]||0,v[1]||0,v[2]||0, s[0]||1,s[1]||1,s[2]||1, 0)
  enc[3]=e.bodyType||'static'; enc[4]=e.custom||null
  enc[5]=e._dynSleeping?1:0
  return enc
}

// Global per-tick tombstone list: replaces the old per-client-per-tick full prevEntityMap scan
// ("for (const id of prevEntityMap.keys()) if (!dynCache.has(id)...) removed.push(id)", O(client's
// known-entity-count) EVERY tick for EVERY client) with a single O(removed-this-tick) global append,
// shared read-only across all clients. Each client instead tracks the tick number of its last built
// snapshot (entityMap already carries this implicitly -- see lastTick below) and diffs only the slice
// of tombstones newer than that, filtered to ids the client actually had in its own prevEntityMap (a
// client that never knew about an entity doesn't need to be told it was removed -- same correctness
// guarantee the old per-client scan gave, just computed from a shared append-only log instead of a
// full re-scan). TombstoneLog.forClient is O(tombstones-since-client's-last-tick), not
// O(client's-total-known-entity-count) -- a large relevance-radius client with thousands of known
// entities but zero nearby removals now pays near-zero cost here instead of a full map walk.
export class TombstoneLog {
  constructor() { this._list = [] /* [{id,tick}, ...] ascending tick */; this._minTick = 0 }
  push(id, tick) { this._list.push({ id, tick }) }
  // Drop entries older than the oldest tick any live client could still need (called once per tick by
  // the caller with the minimum lastTick across all connected clients, or a fixed lookback window).
  pruneBefore(minTick) {
    if (this._list.length === 0) return
    let i = 0
    while (i < this._list.length && this._list[i].tick < minTick) i++
    if (i > 0) this._list = this._list.slice(i)
    this._minTick = minTick
  }
  // Returns removed ids for a client whose last-built snapshot was at `sinceTick`, filtered to ids
  // present in that client's own prevEntityMap (never tell a client to remove something it never knew
  // about -- preserves the exact correctness contract the old full-scan had).
  forClient(sinceTick, prevEntityMap, out) {
    out.length = 0
    for (let i = 0; i < this._list.length; i++) {
      const t = this._list[i]
      if (t.tick > sinceTick && prevEntityMap.has(t.id)) out.push(t.id)
    }
    return out
  }
}

// --- Ack-based delta baseline (per-field-delta-against-last-acked-snapshot) -------------------------
// Every existing delta path above (encodeDelta/encodeDeltaFromCache) diffs against `prevEntityMap`,
// which TickHandler.js updates to "the entityMap this call is ABOUT TO SEND" unconditionally, every
// tick, regardless of whether the client's previous packet actually arrived -- snapshots travel over
// SNAP_UNRELIABLE (see MessageTypes.js UNRELIABLE_MSGS), so packet loss is a real, routine condition,
// not an edge case. Under loss this is unsound: tick N's delta is computed against tick N-1's map even
// when the client never received N-1, so the mask/fields the client applies via fillEntityArr
// (SnapshotProcessor.js) assume a baseline state the client's own tracked entry never actually reached
// -- a real, silent divergence, not merely suboptimal bytes (the existing onDeltaCorruption/
// onFullSnapshotRequested client path only catches the DIFFERENT failure mode of a delta for an entity
// the client has literally never seen at all, not this one: a STALE-but-present track).
//
// AckedBaseline closes this structurally: it keeps a short history of per-tick entityMaps actually
// SENT to one client (ring-bounded, oldest evicted first) and promotes one to "acked" only when the
// client's own ack (the tick number of the last snapshot it successfully applied) names it. Every
// encode call diffs against the ACKED map, never the merely-sent one -- so a lost packet just means
// the next encode's delta naturally widens (falls back toward a fuller record per changed field, same
// mechanism computeFieldDelta already uses when a field truly changed) instead of assuming state the
// client doesn't have. A client that has never acked anything gets full (non-delta) records, the same
// "no baseline -> full record" contract computeFieldDelta already has for `prevEnc == null`.
const ACKED_BASELINE_HISTORY = 64 // ring size: at 30Hz this covers >2s of in-flight snapshots before eviction

export class AckedBaseline {
  constructor() {
    this._history = new Map()       // tick -> entityMap (Map<id, encRecord>) actually sent at that tick
    this._order = []                // ticks in send order, oldest first, for ring eviction
    this._ackedTick = 0             // highest tick the client has acknowledged
    this._ackedMap = new Map()      // entityMap as of _ackedTick -- the actual delta baseline
  }

  // Records what was sent to this client at `tick` (the per-entity id -> encoded-record map, i.e. the
  // same shape as encodeDelta's own entityMap/prevEntityMap contract) so a later ack can promote it.
  recordSent(tick, entityMap) {
    if (this._history.has(tick)) return
    this._history.set(tick, entityMap)
    this._order.push(tick)
    while (this._order.length > ACKED_BASELINE_HISTORY) {
      const evicted = this._order.shift()
      this._history.delete(evicted)
    }
  }

  // Applies a client-reported ack (the tick of the last snapshot it successfully decoded and applied).
  // Promotes that tick's recorded entityMap to the acked baseline. A stale/duplicate/out-of-order ack
  // (ackTick <= current _ackedTick) is a no-op -- acks can arrive reordered over an unreliable ack
  // channel same as snapshots, and only monotonic progress is ever a real advance. An ack naming a tick
  // this server no longer has history for (evicted past ACKED_BASELINE_HISTORY, or a tick this server
  // never actually sent) is also a no-op -- the baseline simply stays at its last known-good point
  // rather than silently promoting to `undefined`/empty; the caller keeps deltaing against the last
  // confirmed-real baseline until a resolvable ack arrives.
  applyAck(ackTick) {
    if (!ackTick || ackTick <= this._ackedTick) return false
    const map = this._history.get(ackTick)
    if (!map) return false
    this._ackedMap = map
    this._ackedTick = ackTick
    // Baseline advanced -- everything strictly older than it can never be re-acked (acks are
    // monotonic), so drop it from history now rather than waiting for ring eviction.
    while (this._order.length && this._order[0] <= ackTick) this._history.delete(this._order.shift())
    return true
  }

  // The map to diff THIS tick's fresh encode against -- the acked baseline, never last-sent.
  baseline() { return this._ackedMap }
  ackedTick() { return this._ackedTick }
}

const _binA = {}, _binB = {}

function computeFieldDelta(prevEnc, enc) {
  if (!prevEnc) return null
  let mask = 0
  const a = prevEnc[2], b = enc[2]
  // Fast path: identical Uint8Array reference (e.g. resolveKey reused cache) or byte-equal content
  // means every packed numeric field is unchanged -- compare bytes directly (23-byte memcmp) rather
  // than unpacking both records first, since most ticks most entities are fully still.
  let binChanged = a !== b
  if (binChanged) {
    binChanged = false
    for (let i = 0; i < BIN_RECORD_BYTES; i++) { if (a[i] !== b[i]) { binChanged = true; break } }
  }
  if (binChanged) {
    unpackBinRecord(a, _binA); unpackBinRecord(b, _binB)
    if (_binA.px !== _binB.px || _binA.py !== _binB.py || _binA.pz !== _binB.pz) mask |= FIELD_POS
    if (_binA.qrot !== _binB.qrot) mask |= FIELD_ROT
    if (_binA.vx !== _binB.vx || _binA.vy !== _binB.vy || _binA.vz !== _binB.vz) mask |= FIELD_VEL
    if (_binA.sx !== _binB.sx || _binA.sy !== _binB.sy || _binA.sz !== _binB.sz) mask |= FIELD_SCALE
  }
  if (enc[3] !== prevEnc[3]) mask |= FIELD_BODY
  if (enc[4] !== prevEnc[4]) mask |= FIELD_CUSTOM
  if (enc[5] !== prevEnc[5]) mask |= FIELD_SLEEP
  if (enc[1] !== prevEnc[1]) mask |= FIELD_MODEL
  if (mask === 0) return null
  // Build the wire array directly as [id, mask, ...deltaFields] -- the final on-wire shape a caller
  // pushes verbatim into entities[] -- instead of [id, ...fields] here plus a slice(1)+spread at every
  // call site to splice mask in after id (two extra allocations per changed entity, every tick).
  // POS/ROT/VEL/SCALE changes always ship the WHOLE 23-byte bin buffer (cheapest: one bytes-value vs
  // re-deriving a partial-field sub-buffer, and msgpackr already elides untouched top-level fields).
  const out = [enc[0], mask]
  if (mask & FIELD_MODEL) out.push(enc[1])
  if (mask & (FIELD_POS|FIELD_ROT|FIELD_VEL|FIELD_SCALE)) out.push(enc[2])
  if (mask & FIELD_BODY) out.push(enc[3])
  if (mask & FIELD_CUSTOM) out.push(enc[4])
  if (mask & FIELD_SLEEP) out.push(enc[5])
  return out
}



export function encodeEntity(e) {
  return fillEntityEnc(e, new Array(6))
}

function fnv1aStep(hash, str) {
  for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619) }
  return hash
}

// hashes the raw IEEE754 bytes of n (dirty-detection only, never transmitted -- no string round-trip needed)
const _f32buf = new ArrayBuffer(4)
const _f32view = new DataView(_f32buf)
function fnv1aStepNum(hash, n) {
  _f32view.setFloat32(0, n)
  hash ^= _f32view.getUint8(0); hash = Math.imul(hash, 16777619)
  hash ^= _f32view.getUint8(1); hash = Math.imul(hash, 16777619)
  hash ^= _f32view.getUint8(2); hash = Math.imul(hash, 16777619)
  hash ^= _f32view.getUint8(3); hash = Math.imul(hash, 16777619)
  return hash
}

function fnv1aStepBytes(hash, bytes) {
  for (let i = 0; i < bytes.length; i++) { hash ^= bytes[i]; hash = Math.imul(hash, 16777619) }
  return hash
}

// enc[2] is now the packed 23-byte bin buffer -- hash its raw bytes directly instead of stepping
// 8 separate float32 hashes (one imul chain over the buffer vs 8 DataView writes + 32 imul steps).
// custKey is either a small integer (the entity's live _customV counter, the fast common path -- see
// resolveCustKey below) or a legacy stringified-JSON fallback; both are hashed as a string via
// fnv1aStep (cheap coercion for the int case, same as before for the fallback case).
function buildEntityKey(enc, custKey) {
  let hash = 2166136261
  hash = fnv1aStep(hash, enc[1])
  hash = fnv1aStepBytes(hash, enc[2])
  hash = fnv1aStep(hash, enc[3])
  hash = fnv1aStep(hash, '' + custKey)
  hash = fnv1aStepNum(hash, enc[5])
  return hash >>> 0
}

function custToStr(cust) { return cust != null ? JSON.stringify(cust) : '' }

// --- Schema-driven custom-field encode/decode (ecs-app-layer-replicated-component-schemas) ---------
// Proof-of-pattern for a subset of entity.custom: instead of hand-writing a hp/max/alive-shaped (or
// teamId-shaped, or currency-shaped) encode/decode branch here per component, a component module
// (apps/_lib/health.js, teams.js, inventory.js) declares its wire-relevant fields as a
// ComponentSchema (apps/_lib/ComponentSchema.js) and registers it by name; these two functions are the
// ONLY netcode-side code needed to replicate ANY registered schema, generically. A caller mirrors a
// component instance's live state into a named sub-key of entity.custom (e.g.
// entity.custom.health = { hp: h.hp, max: h.max, alive: h.alive }) and this module packs/unpacks that
// sub-object through the schema's compact byte layout instead of JSON.
//
// Deliberately SEPARATE from the existing FIELD_CUSTOM mask path (computeFieldDelta/fillEntityEnc
// above), not a replacement -- entity.custom itself stays a plain JS value on the wire for every
// existing caller (env markers, _collider, _interior, arbitrary per-app data), unaffected. This is an
// additional, opt-in encode/decode pair a caller uses explicitly for a specific named sub-object it
// knows is schema-backed, proving the auto-generation pattern works and is byte-comparable against the
// hand-written JSON path before any wider SnapshotEncoder cutover (see the ecs-app-layer PRD row's
// verification requirement). encodeCustomBySchema returns null (never throws) when the schema name
// isn't registered, so a caller can fall back to the plain JSON path unconditionally on a miss.
export function encodeCustomBySchema(schemaName, obj) {
  const schema = getComponentSchema(schemaName)
  if (!schema) return null
  return encodeCustomFields(schema, obj)
}

export function decodeCustomBySchema(schemaName, buf) {
  const schema = getComponentSchema(schemaName)
  if (!schema) return null
  return decodeCustomFields(schema, buf)
}

// Resolves a cheap dirty-detection key for an entity's custom field, preferring the live version
// counter (installCustomVersion wraps entity.custom in AppRuntime.spawnEntity so every wholesale
// reassignment AND in-place mutation -- ctx.entity.custom.x = y -- bumps entity._customV) over a full
// JSON.stringify: an integer compare replaces a per-tick stringify-and-compare for every entity whose
// custom object was created through the normal spawn path. Falls back to custToStr only when the
// entity has no _customV (custom created outside spawnEntity, e.g. a raw test fixture) -- reference
// equality still short-circuits that fallback path when the object identity is unchanged, same as
// before, so this is a strict improvement, never a regression on the miss path.
function resolveCustKey(e, cust, prevCust, prevKey) {
  if (e && typeof e._customV === 'number') return e._customV
  return (prevCust === cust) ? prevKey : custToStr(cust)
}

function resolveKey(entry) {
  if (!entry._dirty) return entry.k
  const cust = entry.enc[4]
  entry.custStr = resolveCustKey(entry.srcEntity, cust, entry.cust, entry.custStr)
  entry.cust = cust
  entry.k = buildEntityKey(entry.enc, entry.custStr)
  entry._dirty = false
  return entry.k
}

function buildEntry(e, id, prevCache, sleeping) {
  const enc = encodeEntity(e), cust = enc[4]
  const prev = prevCache?.get(id)
  const custStr = resolveCustKey(e, cust, prev?.cust, prev?.custStr)
  // isEnv (custom._interior) exempts always-relevant level geometry from distance-tier throttling.
  // _sleepJustSet: true whenever this entry starts out sleeping (a fresh cache build finding the entity
  // already asleep -- e.g. server boot or a client's very first dynCache build) -- same "don't suppress
  // the FIRST observation of a sleeping entity" contract as the refreshDynamicCache transition case,
  // consumed+cleared by applyEntry the first time this entry is evaluated.
  // _lastCustomV: the entity's live _customV counter at build time (installCustomVersion, CustomVersion.js)
  // -- refreshDynamicCache's already-sleeping branch compares against this to detect a custom-only change
  // on a prop that never re-enters the active/transition paths (see that function's own comment).
  // _pBin/_pX/_pY/_pZ/_pVelScore: TickHandlerAOI.getPlayerPriorityIds' per-entity decode memo, declared
  // here (not added later) so every cache entry keeps one hidden class. See that function for why.
  return { enc, k: buildEntityKey(enc, custStr), cust, custStr, isEnv: !!e.custom?._interior, sleeping: !!sleeping, _sleepJustSet: !!sleeping, _dirty: false, srcEntity: e, _lastCustomV: typeof e._customV === 'number' ? e._customV : null, _pBin: null, _pX: 0, _pY: 0, _pZ: 0, _pVelScore: 0 }
}

// Multi-tier distance LOD schedule for snapshot updates. Replaces the old 2-tier scheme (full-rate
// inside 20m, else skip entirely on odd seqNum -- a blunt 50% skip with no further falloff). Three
// tiers by distance from the viewer:
//   NEAR   (<20m):  every tick        (tickMod=1)
//   MID    (20-60m): every 4th tick   (tickMod=4)
//   FAR    (60-200m relevance cutoff): every 16th tick (tickMod=16), velocity field omitted
// A tier's entity is skipped (falls through to nextMap.set with the previous record, i.e. "no change
// this tick") on ticks where (snapshotSeq % tickMod) !== 0, exactly generalizing the old seqNum%2!==0
// skip. isEnv (always-relevant level geometry) is exempt, same as before.
//
// tickMod divides the ADAPTIVE SNAPSHOT rate (snapshotSeq increments once per buildAndSendSnapshots
// call, itself gated by TickHandler's tick % _snapshotInterval, not the raw 60Hz physics tick -- see
// TickHandler.js onTick/getSnapshotHz), so a tickMod=N here means "every Nth snapshot", not "every
// Nth physics tick". _lastSnapRate ranges SNAP_RATE_MIN_HZ..SNAP_RATE_MAX_HZ (8-30Hz).
const NEAR2 = 20 * 20
const MID2 = 60 * 60
const _distScratch = {}

// --- Non-player entity send-rate tiers (per-entity-send-rate-tiers-sleep-detection) -----------------
// Everything reaching applyEntry via dynCache is, by construction, a NON-PLAYER entity -- players are
// encoded/tiered entirely separately (encodePlayer/classifyPlayerTiers/filterEncodedPlayersTiered
// above), never routed through dynCache. So the existing NEAR/MID/FAR distance tickMod above already
// is "non-player entity tiering"; this block extends the SAME tickMod mechanism (same nextMap
// carry-forward skip, same call site) with two more real signals dynCache entries already carry:
//   - entry.sleeping (real Jolt sleep state -- AppRuntimePhysics.js's onBodyDeactivated listener,
//     backed by body.IsActive(), sets this; refreshDynamicCache already does a ONE-TIME catch-up
//     resync of the bin record the tick a body sleeps, so a sleeping prop's last position is always
//     correct on the wire before sends stop). Once asleep and past that catch-up tick, nothing about
//     a sleeping rigid body changes -- position/rotation/velocity are frozen -- so there is nothing to
//     poll for at any cadence; PROP_SLEEP_TICKMOD suppresses ongoing sends almost entirely rather than
//     continuing to re-evaluate/re-send an unmoving prop at its distance tier's rate forever. A big
//     finite modulus (not Infinity/never) is used, not a hard stop, so a body that wakes back up mid
//     -window is still caught by the very next scheduled tick rather than waiting for an external wake
//     hook to force a resync -- belt-and-suspenders alongside the wake-triggering onBodyActivated path
//     (which flips entry.sleeping=false and marks the entry dirty on the SAME tick a body wakes, so in
//     practice a wake is caught immediately; this modulus is the fallback if that transition were ever
//     missed).
//   - bodyType (enc[3]): 'dynamic'/'kinematic' physics props are capped to a PROP_MAX_HZ ceiling
//     (10-20Hz) even at NEAR distance, where the generic tier would otherwise send every snapshot
//     (matching whatever the adaptive snapshot rate currently is, up to 30Hz) -- a physics prop's
//     rigid-body motion is smooth enough that a player cannot perceive the difference between 20Hz and
//     30Hz updates, unlike a player's own avatar (aim-critical, kept at full rate via the separate
//     player-tier path above). isEnv entities are exempt (same always-relevant carve-out the distance
//     tier already gives them) since level geometry marked always-relevant is deliberately exempted
//     from every other throttle in this file.
export const PROP_BODY_TYPES = new Set(['dynamic', 'kinematic'])
export const PROP_MAX_HZ = 15         // physics-prop ceiling inside the 10-20Hz target band
export const PROP_SLEEP_TICKMOD = 60  // ~once every 60 snapshots (a few seconds at typical adaptive rate) while asleep, not a hard stop
// snapHz: current adaptive snapshot rate (caller-supplied, e.g. TickHandler's getSnapshotHz()) -- the
// tickMod needed to cap at PROP_MAX_HZ is derived fresh each call so it always matches TODAY's real
// snapshot rate, mirroring how PLAYER_LOD_REDUCED_HZ's reducedTickMod is derived in TickHandler.js.
// Math.ceil (not round): a rounded ratio silently no-ops whenever snapHz/PROP_MAX_HZ < 1.5 (e.g.
// 20/15=1.33 rounds to 1, meaning "cap to 15Hz" would ship at the full 20Hz uncapped, a genuine bug
// found live via this task's own exec witness run -- ceil guarantees any snapHz strictly above
// PROP_MAX_HZ always divides down to AT MOST PROP_MAX_HZ, never silently passing through uncapped).
export function propTickMod(snapHz) {
  if (!snapHz || snapHz <= PROP_MAX_HZ) return 1
  return Math.max(1, Math.ceil(snapHz / PROP_MAX_HZ))
}

// Strips the velocity field out of a bin record for FAR-tier entities: client-side extrapolation
// matters much less at that range, and it saves the field's meaningfulness on the wire (zeroed, not
// physically transmitted as a real velocity). Returns a FRESH enc array (not scratch/shared) since the
// result is retained in both nextMap (this entity's cache-for-next-tick) and possibly entities[] --
// two far-tier entities encoded in the same tick must not alias one buffer.
function stripVelocityForFar(enc) {
  unpackBinRecord(enc[2], _distScratch)
  const noVelBin = packBinRecord(_distScratch.px, _distScratch.py, _distScratch.pz, _distScratch.qrot, 0, 0, 0, _distScratch.sx, _distScratch.sy, _distScratch.sz, _distScratch.flags)
  return [enc[0], enc[1], noVelBin, enc[3], enc[4], enc[5]]
}

// Per-entity decode memo shared by applyEntry (below) and TickHandlerAOI.getPlayerPriorityIds.
// enc[2]'s decoded position and the velocity score derived from it are functions of the ENTITY alone,
// but both consumers ran per (entity x VIEWER) -- 2 unpackBinRecord calls per entity per viewer, where
// one per entity per re-encode suffices. fillEntityEnc always assigns a FRESH Uint8Array to enc[2]
// (packBinRecord allocates; no bin buffer is ever mutated in place), so buffer identity is an exact
// dirty bit: a memo hit is only possible when the decoded values are provably unchanged. Fields are
// declared in buildEntry so entries keep one hidden class.
export function primeEntryDecode(entry) {
  if (entry._pBin === entry.enc[2]) return entry
  unpackBinRecord(entry.enc[2], _distScratch)
  entry._pBin = entry.enc[2]
  entry._pX = _distScratch.px; entry._pY = _distScratch.py; entry._pZ = _distScratch.pz
  const velSq = _distScratch.vx*_distScratch.vx + _distScratch.vy*_distScratch.vy + _distScratch.vz*_distScratch.vz
  entry._pVelScore = velSq >= 100 ? 1 : Math.sqrt(velSq) * 0.1
  return entry
}

function applyEntry(id, entry, nextMap, entities, prevEntityMap, useDistTier, vx, vy, vz, snapshotSeq, propModCap) {
  const k = resolveKey(entry)
  let enc = entry.enc
  let farTier = false
  // Non-player send-rate tiers, layered on top of the existing distance tickMod below (most-restrictive
  // tickMod wins -- Math.max, same nextMap-carry-forward skip as the distance tier, not a parallel
  // mechanism). isEnv is exempt from both, matching the distance tier's own carve-out.
  let extraMod = 1
  if (!entry.isEnv) {
    if (entry.sleeping) {
      // Force this call through once (extraMod stays 1) the very tick a body just fell asleep, so its
      // real final resting position always reaches the wire before ongoing sends suppress -- see the
      // _sleepJustSet comment in refreshDynamicCache above.
      if (entry._sleepJustSet) entry._sleepJustSet = false
      else extraMod = PROP_SLEEP_TICKMOD
    } else if (propModCap > 1 && PROP_BODY_TYPES.has(enc[3])) extraMod = propModCap
  }
  // vehicles-wheel-visual-wire-sync found+fixed a real bug live-witnessing this row's own mount test: the
  // sleep/prop-rate throttle above was designed around "position/rotation/velocity are frozen while
  // asleep, so there's nothing to poll for" (see the header comment above this function) -- true for the
  // BINARY physics fields, but custom is a THIRD, independent field that can change for reasons that have
  // nothing to do with physics state (apps/vehicle's onInteract writes custom.driverId on mount/dismount
  // while the chassis is stationary/asleep; any other app's onInteract/onMessage-driven custom write on a
  // resting prop hits the exact same gap). The throttle applied unconditionally to the WHOLE entry, so a
  // real interactive state change (e.g. "I just got in the car") sat invisible on the wire for up to
  // PROP_SLEEP_TICKMOD snapshots (~7s measured live at a typical adaptive rate) -- a player pressing E and
  // watching nothing happen for several seconds. Fix: if this player's own last-sent custStr differs from
  // the entry's current one (a real customs change THIS PLAYER hasn't seen yet -- prevEntityMap is already
  // per-player/per-cache, so this correctly re-evaluates independently for every viewer), force the send
  // through regardless of the sleep/prop tier, same as the existing _sleepJustSet one-tick force-through
  // just above. Distance tiering below still applies on top (a custom change on a FAR-tier sleeping prop
  // still isn't instant) -- this only removes the sleep-specific extraMod component, not visibility.
  // ONE prevEntityMap.get(id) for all three former call sites (prevCustStr, the two skip-path
  // carry-forwards, and the delta compare below) -- every path used to do two lookups of the same key.
  // encodeDeltaFromCache guarantees nextMap !== prevEntityMap (the caller-side double-buffer contract),
  // so prevEntityMap cannot change under us between them.
  const prev = prevEntityMap.get(id)
  const prevCustStr = prev?.[2]
  if (extraMod !== 1 && prevCustStr !== entry.custStr) extraMod = 1
  if (useDistTier && !entry.isEnv) {
    primeEntryDecode(entry)
    const dx = entry._pX-vx, dy = entry._pY-vy, dz = entry._pZ-vz
    const d2 = dx*dx+dy*dy+dz*dz
    const distTickMod = d2 < NEAR2 ? 1 : d2 < MID2 ? 4 : 16
    farTier = distTickMod === 16
    const tickMod = Math.max(distTickMod, extraMod)
    if (tickMod !== 1 && (snapshotSeq % tickMod) !== 0) {
      nextMap.set(id, prev || [k, entry.cust, entry.custStr, null]); return
    }
  } else if (extraMod !== 1 && (snapshotSeq % extraMod) !== 0) {
    // useDistTier===false path (no viewerPos, e.g. the shared-cell path's cellViewerPos-less callers or
    // a caller with distance tiering disabled): sleep/prop-rate tiers still apply independently of the
    // distance tier being active, since they are not distance-derived signals.
    nextMap.set(id, prev || [k, entry.cust, entry.custStr, null]); return
  }
  if (farTier) enc = stripVelocityForFar(enc)
  nextMap.set(id, [k, entry.cust, entry.custStr, enc])
  if (!prev || prev[0] !== k) {
    if (prev && prev[3]) {
      const fd = computeFieldDelta(prev[3], enc)
      // Skip rotation-only deltas for far-tier entities entirely -- a rotation-only change (mask ===
      // FIELD_ROT, nothing else set) isn't perceptible at 60m+ and will catch up on the entity's next
      // full/near-tier update. Non-rotation-only far deltas (position, model, etc) still ship normally.
      if (fd) {
        if (farTier && fd[1] === FIELD_ROT) return
        entities.push(fd); return
      }
    }
    entities.push(enc)
  }
}

// Diffs dynCache+staticEntityIds membership against the PREVIOUS tick's known-id set, pushing exactly
// the ids that dropped out (removed this tick) into the tombstone log -- O(ids-that-changed), never
// O(all-known-ids) per client. Call once per tick (not per client); returns the new known-id Set to
// keep as `prevKnownIds` for next tick's diff. knownDynIds/knownStaticIds are passed in as the
// authoritative id sets this tick (dynCache keys + staticEntityIds); prevKnownIds is whatever this
// function returned last tick (or null on the very first call / after a keyframe reset).
export function updateTombstones(tombstoneLog, tick, dynCache, staticEntityIds, prevKnownIds) {
  const known = new Set(dynCache.keys())
  if (staticEntityIds) for (const id of staticEntityIds) known.add(id)
  if (prevKnownIds) {
    for (const id of prevKnownIds) { if (!known.has(id)) tombstoneLog.push(id, tick) }
  }
  return known
}

export class SnapshotEncoder {
  // Schema-driven custom-field codec (see encodeCustomBySchema/decodeCustomBySchema above) exposed as
  // static methods for callers already using the SnapshotEncoder class surface rather than importing
  // the bare functions directly -- both forms are the same implementation, no divergence.
  static encodeCustomBySchema(schemaName, obj) { return encodeCustomBySchema(schemaName, obj) }
  static decodeCustomBySchema(schemaName, buf) { return decodeCustomBySchema(schemaName, buf) }

  static encodePlayersOnce(players) {
    const m = new Map()
    for (const p of (players || [])) m.set(p.id, encodePlayer(p))
    return m
  }

  static filterEncodedPlayers(encodedMap, nearbyIds) {
    const out = []; for (const id of nearbyIds) { const enc = encodedMap.get(id); if (enc) out.push(enc) }; return out
  }

  static filterEncodedPlayersWithSelf(encodedMap, nearbyIds, selfId) {
    const out = []; let hasSelf = false
    for (let i = 0; i < nearbyIds.length; i++) { const id = nearbyIds[i]; if (id === selfId) hasSelf = true; const enc = encodedMap.get(id); if (enc) out.push(enc) }
    if (!hasSelf) { const self = encodedMap.get(selfId); if (self) out.push(self) }
    return out
  }

  static encodePlayers(players) { return (players || []).map(encodePlayer) }

  static encodeStaticEntities(entities, prevStaticMap) {
    const nextMap = new Map()
    const allEntries = []
    const changedEntries = []
    let changed = false
    for (const e of entities) {
      if (e.bodyType !== 'static') continue
      const enc = encodeEntity(e)
      const prev = prevStaticMap.get(e.id)
      const cust = enc[4]
      const custStr = resolveCustKey(e, cust, prev?.[1], prev?.[2])
      const k = buildEntityKey(enc, custStr)
      nextMap.set(e.id, [k, cust, custStr])
      allEntries.push({ enc, k, id: e.id })
      if (!prev || prev[0] !== k) { changedEntries.push({ enc, k, id: e.id }); changed = true }
    }
    if (nextMap.size !== prevStaticMap.size) changed = true
    return { staticEntries: allEntries, changedEntries, staticMap: nextMap, staticChanged: changed }
  }

  static buildStaticIds(staticMap) { return new Set(staticMap.keys()) }

  static refreshDynamicCache(cache, activeIds, entities, sleepingIds, suspendedIds, unmanagedIds) {
    const envIds = cache._envIds || []; envIds.length = 0
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      let entry = cache.get(id)
      if (entry) {
        fillEntityEnc(e, entry.enc)
        entry._dirty = true; entry.sleeping = false; entry.srcEntity = e
      } else {
        entry = buildEntry(e, id, null, false); cache.set(id, entry)
      }
      if (entry.isEnv) envIds.push(id)
    }
    // app-driven dynamic entities with no physics body (see AppRuntime.getUnmanagedDynamicIds) refresh
    // every tick same as activeIds -- their position can change any tick with no activate/deactivate
    // event to key off of.
    if (unmanagedIds) {
      for (const id of unmanagedIds) {
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        let entry = cache.get(id)
        if (entry) {
          fillEntityEnc(e, entry.enc)
          entry._dirty = true; entry.sleeping = false; entry.srcEntity = e
        } else {
          entry = buildEntry(e, id, null, false); cache.set(id, entry)
        }
        if (entry.isEnv) envIds.push(id)
      }
    }
    // A body that went to sleep/got suspended THIS tick is no longer in activeIds (physics.step's
    // deactivation event already fired, before this runs), yet its entity.position was just synced
    // one final time by onBodyDeactivated/_tickPhysicsLOD -- refresh the cache exactly once so that
    // last real position reaches clients, or it freezes forever at the last active-tick's value
    // (witnessed live: a settled box's server position was correct but every subsequent snapshot kept
    // serving the stale mid-fall value, so the client mesh never moved to the true resting spot).
    // entry.sleeping gates this to a ONE-TIME catch-up per sleep transition, not a per-tick re-encode.
    for (const idSet of [sleepingIds, suspendedIds]) {
      if (!idSet) continue
      for (const id of idSet) {
        const entry = cache.get(id)
        if (!entry) continue
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        // vehicles-wheel-visual-wire-sync found+fixed a real bug live-witnessing this row's own mount
        // test: an ALREADY-sleeping entry (entry.sleeping already true, so the one-time transition catch-
        // up above never re-touches it) never got `entry._dirty` re-set on a plain custom-field change --
        // resolveKey's own `if (!entry._dirty) return entry.k` short-circuit means the cached custStr/k
        // NEVER updates for a sleeping prop's custom mutation, so applyEntry's own sleep-throttle-bypass
        // (added alongside this fix, see that function's comment) compared against a STALE custStr that
        // never reflected the real change in the first place -- the mount-visibility bug persisted (in
        // fact got WORSE, ~16.7s live-measured, vs ~7s before either fix) until this second half landed.
        // Detected via the entity's own live _customV counter (installCustomVersion, CustomVersion.js) --
        // a cheap integer compare against the last value THIS cache entry observed, same "integer compare
        // beats a full re-stringify" doctrine SnapshotEncoder already uses for resolveCustKey itself.
        if (entry.sleeping) {
          const cv = typeof e._customV === 'number' ? e._customV : null
          if (cv !== null && cv !== entry._lastCustomV) { entry._lastCustomV = cv; entry._dirty = true; entry.srcEntity = e }
          continue
        }
        fillEntityEnc(e, entry.enc)
        // _sleepJustSet: consumed+cleared by applyEntry's PROP_SLEEP_TICKMOD gate below to force this
        // tick's final resting-position delta through immediately, bypassing the sleep-suppression
        // modulus exactly once -- without it, a body that happens to sleep on a
        // (snapshotSeq % PROP_SLEEP_TICKMOD) !== 0 tick would have its real, changed, final position
        // silently swallowed by the very throttle meant to stop RE-sending an already-settled prop, and
        // clients would keep coasting the stale pre-sleep position for up to PROP_SLEEP_TICKMOD snapshots.
        entry._dirty = true; entry.sleeping = true; entry._sleepJustSet = true; entry.srcEntity = e
        entry._lastCustomV = typeof e._customV === 'number' ? e._customV : null
        if (entry.isEnv) envIds.push(id)
      }
    }
    cache._envIds = envIds; return cache
  }

  static buildDynamicCache(activeIds, sleepingIds, suspendedIds, entities, prevCache, unmanagedIds) {
    const cache = new Map(), envIds = []
    for (const id of activeIds) {
      const e = entities.get(id); if (!e || e.bodyType === 'static') continue
      const entry = buildEntry(e, id, prevCache, false)
      cache.set(id, entry); if (entry.isEnv) envIds.push(id)
    }
    if (unmanagedIds) {
      for (const id of unmanagedIds) {
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        const entry = buildEntry(e, id, prevCache, false)
        cache.set(id, entry); if (entry.isEnv) envIds.push(id)
      }
    }
    for (const idSet of [sleepingIds, suspendedIds]) {
      for (const id of idSet) {
        if (prevCache?.has(id)) {
          const entry = prevCache.get(id)
          cache.set(id, entry)
          if (entry.isEnv) envIds.push(id)
          continue
        }
        const e = entities.get(id); if (!e || e.bodyType === 'static') continue
        // BUGFIX (found live via this task's own isEnv+sleeping interaction witness): this loop built
        // the entry but never checked entry.isEnv to push it into envIds, unlike the activeIds/
        // unmanagedIds loops above -- an entity that starts out ALREADY sleeping at initial cache-build
        // time (e.g. server boot finding a settled prop, or a client's first dynCache build) and is also
        // isEnv (custom._interior, always-relevant level geometry) silently fell out of the _envIds
        // always-relevant list and was subject to normal relevantIds-membership filtering like any other
        // entity, defeating the "isEnv is exempt from every throttle" contract every other code path in
        // this file upholds.
        const entry = buildEntry(e, id, prevCache, true)
        cache.set(id, entry)
        if (entry.isEnv) envIds.push(id)
      }
    }
    cache._envIds = envIds; return cache
  }

  // scratch: optional pooled { entities:[], removed:[], spareMap:Map } reused across ticks for one
  // caller (e.g. one player's per-tick build) to avoid a fresh array/Map allocation every call.
  // - scratch.entities/scratch.removed are transient: consumed synchronously by the caller (packed
  //   into the wire payload) before the next call reuses them, so clearing them here on entry is
  //   always safe.
  // - scratch.spareMap is the CALLER'S double-buffer slot: the caller guarantees it is NEVER the same
  //   object as prevEntityMap (it holds whatever was returned as entityMap two calls ago for this same
  //   caller, already fully consumed as a stale prevEntityMap one call ago) -- so clearing+writing it
  //   here can never erase data prevEntityMap is being read from in this same call. The caller is
  //   responsible for swapping which buffer is "spare" after each call (see TickHandler.js).
  static encodeDeltaFromCache(tick, serverTime, dynCache, relevantIds, prevEntityMap, preEncodedPlayers, staticEntries, staticEntityMap, staticEntityIds, seqNum, viewerPos, scratch, tombstoneLog, clientLastTick, snapHz) {
    const entities = scratch ? scratch.entities : []
    const nextMap = scratch ? scratch.spareMap : new Map()
    if (scratch) { entities.length = 0; nextMap.clear() }
    if (staticEntries) for (const { enc } of staticEntries) entities.push(enc)
    const vx = viewerPos ? viewerPos[0] : 0, vy = viewerPos ? viewerPos[1] : 0, vz = viewerPos ? viewerPos[2] : 0
    const useDistTier = seqNum !== undefined && !!viewerPos
    const seq = seqNum || 0
    // propModCap: the snapshot-count divisor that caps a physics prop (dynamic/kinematic bodyType) to
    // PROP_MAX_HZ against TODAY's real adaptive snapshot rate -- see propTickMod/PROP_BODY_TYPES above.
    // snapHz undefined (a caller not passing it, e.g. a direct/legacy test call) means "no rate
    // ceiling applied" (propModCap=1), never a crash -- same forgiving-default contract useDistTier
    // already has for a missing viewerPos/seqNum.
    const propModCap = propTickMod(snapHz)
    const relevantCount = Array.isArray(relevantIds) ? relevantIds.length : (relevantIds ? relevantIds.size : 0)
    const iterIds = (relevantIds && dynCache.size > relevantCount) ? relevantIds : null
    const relevantLookup = (!iterIds && Array.isArray(relevantIds)) ? new Set(relevantIds) : null
    if (iterIds) {
      for (const id of iterIds) { const entry = dynCache.get(id); if (entry) applyEntry(id, entry, nextMap, entities, prevEntityMap, useDistTier, vx, vy, vz, seq, propModCap) }
      for (const id of (dynCache._envIds || [])) { const entry = dynCache.get(id); if (entry) applyEntry(id, entry, nextMap, entities, prevEntityMap, false, 0, 0, 0, seq, propModCap) }
    } else {
      for (const [id, entry] of dynCache) {
        if (!entry.isEnv && relevantIds && (relevantLookup ? !relevantLookup.has(id) : !relevantIds.has(id))) continue
        applyEntry(id, entry, nextMap, entities, prevEntityMap, useDistTier, vx, vy, vz, seq, propModCap)
      }
    }
    // Removed set: prefer the global tombstone log (O(tombstones-since-client's-last-tick), shared
    // read-only across clients, still filtered to this player's own prevEntityMap so a client is never
    // told to remove something it never knew about -- same correctness contract as the full scan).
    // Falls back to the full prevEntityMap scan when no log is supplied (keeps direct/test callers of
    // this method working unchanged).
    const removed = scratch ? scratch.removed : []
    if (scratch) removed.length = 0
    if (tombstoneLog) {
      tombstoneLog.forClient(clientLastTick || 0, prevEntityMap, removed)
    } else {
      for (const id of prevEntityMap.keys()) { if (!dynCache.has(id) && !(staticEntityIds && staticEntityIds.has(id))) removed.push(id) }
    }
    return { encoded: { tick: tick||0, serverTime, players: preEncodedPlayers||[], entities, removed: removed.length ? removed : undefined, delta: 1 }, entityMap: nextMap }
  }

  static encodeDelta(snapshot, prevEntityMap, preEncodedPlayers, staticEntries, staticMap, staticIds) {
    const players = preEncodedPlayers || (snapshot.players || []).map(encodePlayer)
    const dynIds = new Set(), entities = [], nextMap = new Map()
    if (staticEntries) for (const { enc } of staticEntries) entities.push(enc)
    for (const e of snapshot.entities || []) {
      if (e.bodyType === 'static' && staticEntries) continue
      const encoded = encodeEntity(e); dynIds.add(e.id)
      const prev = prevEntityMap.get(e.id), cust = encoded[4]
      const custStr = resolveCustKey(e, cust, prev?.[1], prev?.[2])
      const k = buildEntityKey(encoded, custStr); nextMap.set(e.id, [k, cust, custStr, encoded])
      if (!prev || prev[0] !== k) {
        if (prev && prev[3]) {
          const fd = computeFieldDelta(prev[3], encoded)
          if (fd) { entities.push(fd); continue }
        }
        entities.push(encoded)
      }
    }
    const removed = []; for (const id of prevEntityMap.keys()) { if (!dynIds.has(id) && !(staticIds && staticIds.has(id))) removed.push(id) }
    return { encoded: { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities, removed: removed.length ? removed : undefined, delta: 1 }, entityMap: nextMap }
  }

  // Same per-entity diff contract as encodeDelta above, but the delta baseline is sourced from
  // `ackedBaseline` (an AckedBaseline instance, one per client) instead of a caller-threaded
  // prevEntityMap -- see the AckedBaseline block above for why this matters under packet loss.
  // Call ackedBaseline.applyAck(clientReportedAckTick) BEFORE this, whenever the client's ack arrives
  // (own message, decoupled from this call's cadence); this method then does two things beyond
  // encodeDelta's own job: (1) diffs against ackedBaseline.baseline() rather than a raw prevEntityMap
  // argument, (2) calls ackedBaseline.recordSent(snapshot.tick, nextMap) so a FUTURE ack naming this
  // tick can promote it. removed[] is computed against the acked baseline too -- an entity the client
  // never acked receiving is, from the client's actual state's perspective, still "there" until an ack
  // proves otherwise, so telling it to remove something only present in unacked history would be
  // telling it to remove state it may not even have.
  static encodeDeltaAcked(snapshot, ackedBaseline, preEncodedPlayers, staticEntries, staticMap, staticIds) {
    const prevEntityMap = ackedBaseline.baseline()
    const r = SnapshotEncoder.encodeDelta(snapshot, prevEntityMap, preEncodedPlayers, staticEntries, staticMap, staticIds)
    ackedBaseline.recordSent(snapshot.tick || 0, r.entityMap)
    return r
  }

  static encode(snapshot) {
    const players = (snapshot.players || []).map(encodePlayer)
    const entities = (snapshot.entities || []).map(encodeEntity)
    return { tick: snapshot.tick || 0, serverTime: snapshot.serverTime, players, entities }
  }

  // Decodes the FULL (non-delta) wire array shape produced by encode() above -- players/entities are
  // 7/6-element arrays whose numeric fields live in a packed 23-byte Uint8Array at a fixed slot
  // (player[1], entity[2]; see packBinRecord/unpackBinRecord). Delta ([id,mask,...]) records are not
  // handled here -- SnapshotProcessor.fillEntityArr is the live decode path for those, mirroring this
  // layout; this method exists for the initial-connect/reconnect full-snapshot path and stays a pure
  // function of `data` (no persistent-track-slot side effects, unlike the streaming client decoder).
  static decode(data) {
    if (!data.players || !Array.isArray(data.players)) return data
    const bin = {}
    // drop truncated wire arrays (player<7, entity<6 fields) rather than read past the end into NaN
    const players = data.players.map(p => {
      if (!Array.isArray(p)) return p
      if (p.length < 7) return null
      unpackBinRecord(p[1], bin)
      const rot = unpackQuat(bin.qrot, [0,0,0,0])
      return { id:p[0], position:[bin.px,bin.py,bin.pz], rotation:rot, velocity:[bin.vx,bin.vy,bin.vz], onGround:p[2]===1, health:p[3], inputSequence:p[4], crouch:p[5]||0, lookPitch:(((p[6]||0)>>8)&0xFF)/255*Math.PI-HALF_PI, lookYaw:((p[6]||0)&0xFF)/256*TAU, expr:p[7]||0, weapon:p[8]||0 }
    }).filter(p => p !== null)
    const entities = (data.entities||[]).map(e => {
      if (!Array.isArray(e)) return e
      if (e.length < 6) return null
      unpackBinRecord(e[2], bin)
      const rot = unpackQuat(bin.qrot, [0,0,0,0])
      return { id:e[0], model:e[1], position:[bin.px,bin.py,bin.pz], rotation:rot, velocity:[bin.vx,bin.vy,bin.vz], bodyType:e[3], custom:e[4], scale:[bin.sx,bin.sy,bin.sz], sleeping:e[5]===1 }
    }).filter(e => e !== null)
    return { tick:data.tick, serverTime:data.serverTime, players, entities, delta:data.delta, removed:data.removed }
  }
}
