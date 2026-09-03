// Collaborative editor op log (editor-collaborative-crdt-agent-staging-full-flow).
//
// When an editor makes a change (SAVE_SOURCE, PLACE_APP, PLACE_MODEL, etc.), the server
// stores the op in a sequence log and broadcasts it to all OTHER connected editors via
// EDIT_OP_LOG so they can replay it locally. This is the "Figma for game levels" primitive:
// multiple editors working the same world concurrently, each seeing the other's changes
// in real time.
//
// Ops are stored as a simple ordered array (not a full CRDT -- the server is the single
// source of truth, and ops are applied in the order they're received). A late-joining
// editor can request a replay of ops since a given sequence number.
//
// Dual-import safe: zero Node/browser-specific APIs, only uses JS primitives.

const MAX_OPS = 10000 // bound the in-memory log; old ops are pruned
const PRUNE_HEADROOM = 1000 // keep this many ops after pruning

export function createEditOpLog() {
  let _ops = [] // ordered array of {seq, type, payload, editorId, ts}
  let _seq = 0

  // Record an edit operation and return its sequence number. Call broadcastFn(seq, op) to
  // send the op to all other connected editors (the caller wires this to connections.broadcast).
  function record(type, payload, editorId, broadcastFn) {
    _seq++
    const op = { seq: _seq, type, payload, editorId, ts: Date.now() }
    _ops.push(op)

    // Prune old ops if we exceed the cap
    if (_ops.length > MAX_OPS) {
      _ops = _ops.slice(-PRUNE_HEADROOM)
    }

    if (typeof broadcastFn === 'function') {
      try { broadcastFn(_seq, op) } catch {}
    }

    return _seq
  }

  // Get all ops since a given sequence number (exclusive). Returns {ops, latestSeq}.
  // Used for late-join replay: a new editor sends its last known seq and gets everything
  // that happened since.
  function getOpsSince(sinceSeq) {
    const since = typeof sinceSeq === 'number' && sinceSeq >= 0 ? sinceSeq : 0
    const matching = _ops.filter(op => op.seq > since)
    return { ops: matching, latestSeq: _seq }
  }

  function latestSeq() { return _seq }

  function opCount() { return _ops.length }

  // Clear all ops (e.g. on world reset)
  function clear() {
    _ops = []
    _seq = 0
  }

  return { record, getOpsSince, latestSeq, opCount, clear }
}