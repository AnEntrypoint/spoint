const MAX_OPS = 10000
const PRUNE_HEADROOM = 1000

export function createEditOpLog() {
  let _ops = []
  let _seq = 0

  function record(type, payload, editorId, broadcastFn) {
    _seq++
    const op = { seq: _seq, type, payload, editorId, ts: Date.now() }
    _ops.push(op)

    if (_ops.length > MAX_OPS) {
      _ops = _ops.slice(-PRUNE_HEADROOM)
    }

    if (typeof broadcastFn === 'function') {
      try { broadcastFn(_seq, op) } catch {}
    }

    return _seq
  }

  function getOpsSince(sinceSeq) {
    const since = typeof sinceSeq === 'number' && sinceSeq >= 0 ? sinceSeq : 0
    const matching = _ops.filter(op => op.seq > since)
    return { ops: matching, latestSeq: _seq }
  }

  function latestSeq() { return _seq }

  function opCount() { return _ops.length }

  function clear() {
    _ops = []
    _seq = 0
  }

  return { record, getOpsSince, latestSeq, opCount, clear }
}