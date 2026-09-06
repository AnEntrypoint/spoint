// Shared wire-record structures table: every entry here is a fixed field-name list msgpackr
// encodes as a compact record (numeric structure id) instead of spelling out field names on
// the wire. Both client and server import this exact file, so the table stays byte-identical
// on both ends with zero runtime negotiation. maxSharedStructures caps allocation at the
// predefined list length -- an object shape NOT listed here falls back to normal (safe, if
// slightly larger) map encoding rather than the two independent Packr instances silently
// drifting out of structure-id sync and corrupting the next unrelated message.
export const WIRE_STRUCTURES = [
  ['type', 'payload'], // every ConnectionManager/PhysicsNetworkClient/BrowserServer/WireweaveJoinClient envelope
  // TickHandler snapshot payload, the per-client hot path. MUST list every key TickHandler.js's
  // _packPayload object literal carries (seq/tick/serverTime/players/entities/removed/delta/dots) -- msgpackr
  // matches a structure by the object's OWN key list, so an object with one extra key (`dots`, added for
  // the player-LOD crowd aggregate) silently misses the shared structure and re-emits every field name
  // on the wire, on every snapshot (measured live: 174 -> 99 bytes for an empty-entities snapshot once
  // `dots` was appended here). Keys whose value is undefined are still part of the key list.
  ['seq', 'tick', 'serverTime', 'players', 'entities', 'removed', 'delta', 'dots']
]

// Same fnv-1a algorithm as SnapshotEncoder.js's fnv1aStep/StaticHandler.js's contentHashETag (kept
// independent, not imported, since this module must stay dependency-free enough to resolve before any
// other protocol module -- see the lazy-Packr comment below). Derived DIRECTLY from WIRE_STRUCTURES'
// own content (table order + per-structure field order), not a hand-maintained counter -- any edit to
// the table (add/remove/reorder a field, add/remove a structure) changes this hash automatically, so a
// client/server build mismatch is detectable with zero discipline required from whoever next edits
// WIRE_STRUCTURES (unlike WIRE_PROTOCOL_VERSION in MessageTypes.js, which only changes when a human
// remembers to bump it). This is the actual "shared dictionary" both sides negotiate at handshake: msgpackr
// itself never transmits its structures table (that's the whole compression win -- structure ids replace
// field names on the wire), so the only way to catch two sides silently disagreeing on what structure id 0
// or 1 MEANS is to hash the table each side built locally and compare hashes once, at connect time.
function _computeStructHash() {
  let hash = 0x811c9dc5 // fnv-1a 32-bit offset basis
  const step = (str) => { for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619) } }
  for (const fields of WIRE_STRUCTURES) { step('|'); for (const f of fields) { step(f); step(',') } }
  return (hash >>> 0).toString(16)
}

// Computed once at module load (WIRE_STRUCTURES is a static const above, never mutated at runtime) --
// exported so ServerHandlers.js can put it in HANDSHAKE_ACK/RECONNECT_ACK and MessageHandler.js can
// compare its own copy against what the other side sent.
export const WIRE_STRUCT_HASH = _computeStructHash()

const _isNode = typeof process !== 'undefined' && process.versions?.node

// Lazy singleton: avoids a blocking top-level `await import` that stalls the whole module
// graph for every importer before any of them run a line of code. Real usage is always
// inside a function body (pack/unpack are called synchronously by callers, never at their
// own module top level), so resolving the Packr class on first real call -- and caching a
// tiny sync-wrapper queue for the handful of calls that can race the async resolve -- costs
// nothing after warmup and never blocks import().
let _packr = null
let _packrPromise = null

function _makePackr(Packr) {
  return new Packr({
    useFloat32: 3,
    bundleStrings: true,
    structures: WIRE_STRUCTURES.map(s => s.slice()),
    saveStructures: false,
    maxSharedStructures: WIRE_STRUCTURES.length
  })
}

async function _ensurePackr() {
  if (_packr) return _packr
  if (!_packrPromise) {
    // A real Cloudflare Durable Object is neither Node (no process.versions.node, _isNode false) nor
    // a real un-bundled browser (no filesystem to serve a literal '/node_modules/...' URL from) -- see
    // apps/_lib/game-fsm.js's identical xstate fix (same session) for the full rationale. 'msgpackr'
    // is a real bundleable pure-JS npm package with zero Node-native hazard, so the edge-bundled
    // branch uses a REAL literal specifier esbuild can statically resolve+bundle; only the genuine
    // browser (un-bundled) fallback path is built at runtime, so a bundler build never tries to
    // resolve that non-existent-there absolute URL (live-reproduced: a plain _isNode-only ternary
    // sent a real DO down the browser-fallback branch, which crashed with a real workerd runtime
    // error, 'No such module "node_modules/msgpackr/index.js"', BEFORE this fix).
    _packrPromise = (_isNode || typeof globalThis.__SPOINT_EDGE_BUNDLED__ !== 'undefined'
      ? import('msgpackr')
      : import((() => '/node_modules/' + 'msgpackr/index.js')())
    ).then(({ Packr }) => { _packr = _makePackr(Packr); return _packr })
  }
  return _packrPromise
}

// Synchronous fast path once warm (the overwhelming majority of calls, since _ensurePackr
// is kicked off eagerly below and resolves before any real network traffic exists this early
// in boot); a cold call before warmup throws instead of silently returning undefined, which
// is safer than a random empty buffer -- forces the very rare early caller into an explicit fix.
export function pack(obj) {
  if (!_packr) throw new Error('[msgpack] pack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _packr.pack(obj)
}

export function unpack(buf) {
  if (!_packr) throw new Error('[msgpack] unpack() called before Packr resolved -- await ensurePacked() once at boot, or move this call past first tick')
  return _packr.unpack(buf)
}

// Synchronous readiness check for callers that fire from a TIMER rather than from
// an awaitable code path, where `await ensurePacked` is not reachable.
//
// pack() deliberately THROWS when the Packr is not resolved -- failing loudly beats
// silently mis-encoding a frame -- but that makes it unsafe to call from an interval
// whose only guard is "is the socket open". Those are independent conditions: a
// socket can open before the async Packr resolve completes, which is exactly what a
// slower CI machine surfaced (the client heartbeat fired between socket-open and
// Packr-ready and threw an uncaught error during cold load). Such callers should
// skip the tick rather than throw; the next tick a second later will be fine.
export function isPacked() {
  return _packr !== null
}

// Kicked off at module load (non-blocking -- does not use top-level await) so the Packr is
// warm by the time any real pack()/unpack() call happens; callers that need a hard guarantee
// (e.g. a very first test tick) can await this once.
export const ensurePacked = _ensurePackr()
