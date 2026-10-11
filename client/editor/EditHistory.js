const CAP = 20
const BATCH_WINDOW_MS = 50

function _now() { return typeof performance !== 'undefined' ? performance.now() : Date.now() }

const TRANSPORT_OPS = 'ops'
const TRANSPORT_SEND = 'send'

function _transportOf(record) {
  if (!record || typeof record !== 'object') return null
  const hasUndo = typeof record.undoOp === 'function'
  const hasRedo = typeof record.redoOp === 'function'
  if (hasUndo !== hasRedo) return null
  return hasUndo ? TRANSPORT_OPS : TRANSPORT_SEND
}

function _describeRecord(r) {
  if (r.desc) return r.desc
  const after = r.after || {}
  const keys = Object.keys(after)
  if (keys.length === 1 && keys[0] === 'custom' && after.custom && typeof after.custom === 'object') {
    const ck = Object.keys(after.custom)
    return ck.length ? 'custom.' + ck.join(',') : 'custom'
  }
  return keys.length ? keys.join(',') : (r.kind || 'change')
}

function _describeGroup(group) {
  const ids = [...new Set(group.map(r => r.entityId))]
  if (ids.length === 1) return ids[0] + ' ' + _describeRecord(group[0])
  return ids.length + ' entities ' + _describeRecord(group[0])
}

let _seq = 0

export function createEditHistory({ send, onToast, onChange, onPush } = {}) {
  const undoStack = [], redoStack = []
  let _lastPushAt = null
  const _toast = (msg) => { try { onToast && onToast(msg) } catch (_) {} }
  const _notify = () => { try { onChange && onChange() } catch (_) {} }
  const _apply = (r, direction) => {
    if (r.transport === TRANSPORT_OPS) (direction === 'undo' ? r.undoOp : r.redoOp)(r)
    else send(r.entityId, direction === 'undo' ? r.before : r.after)
  }
  return {
    push(record) {
      const transport = _transportOf(record)
      if (transport === null) {
        _toast('Refused history record: undoOp and redoOp are either both functions or both absent')
        return false
      }
      record.transport = transport
      const t = _now()
      const top = undoStack[undoStack.length - 1]
      if (top && _lastPushAt !== null && (t - _lastPushAt) <= BATCH_WINDOW_MS) {
        top.records.push(record)
        top.name = _describeGroup(top.records)
      } else {
        const entry = { txnId: ++_seq, records: [record], name: _describeGroup([record]), at: Date.now() }
        undoStack.push(entry)
        if (undoStack.length > CAP) undoStack.shift()
        try { onPush && onPush(entry) } catch (_) {}
      }
      _lastPushAt = t
      redoStack.length = 0
      _notify()
      return true
    },
    undo() {
      const entry = undoStack.pop()
      if (!entry) return false
      _lastPushAt = null
      redoStack.push(entry)
      for (let i = entry.records.length - 1; i >= 0; i--) _apply(entry.records[i], 'undo')
      _toast('Undid: ' + entry.name)
      _notify()
      return true
    },
    redo() {
      const entry = redoStack.pop()
      if (!entry) return false
      _lastPushAt = null
      undoStack.push(entry)
      for (const r of entry.records) _apply(r, 'redo')
      _toast('Redid: ' + entry.name)
      _notify()
      return true
    },
    list() {
      const done = undoStack.map((e, i) => ({ txnId: e.txnId, name: e.name, at: e.at, count: e.records.length, state: 'done', depth: undoStack.length - 1 - i }))
      const undone = redoStack.map((e, i) => ({ txnId: e.txnId, name: e.name, at: e.at, count: e.records.length, state: 'undone', depth: redoStack.length - 1 - i }))
      return [...undone.slice().reverse(), ...done.slice().reverse()]
    },
    jumpTo(txnId) {
      const undoIdx = undoStack.findIndex(e => e.txnId === txnId)
      if (undoIdx !== -1) {
        const stepsBack = undoStack.length - 1 - undoIdx
        for (let i = 0; i < stepsBack; i++) this.undo()
        return true
      }
      const redoIdx = redoStack.findIndex(e => e.txnId === txnId)
      if (redoIdx !== -1) {
        const stepsForward = redoStack.length - redoIdx
        for (let i = 0; i < stepsForward; i++) this.redo()
        return true
      }
      return false
    },
    get undoDepth() { return undoStack.length },
    get redoDepth() { return redoStack.length },
  }
}
