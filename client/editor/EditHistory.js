// Editor undo/redo stack. A record is { entityId, before, after, kind } -- `before` and `after` are
// EDITOR_UPDATE change-payloads (transform commit or custom.* edit). undo() replays `before`, redo()
// replays `after`, both via the injected send(type, payload). Structural records (spawn/delete/
// duplicate/reparent/rename) instead carry { entityId, desc, undoOp(r), redoOp(r) } -- closures that
// perform the inverse/forward op over the editor protocol -- and bypass the send() replay entirely. Single source for the 20-entry cap and
// the redo-clear-on-new-edit rule that were previously hand-inlined (and duplicated) across app.js.
//
// Batch coalescing: a single user gesture (one drag, one align-click) that fans out into multiple
// EDITOR_UPDATE-shaped records (one per selected entity) must undo/redo as ONE unit, or a multi-select
// batch transform only ever un-does its last-pushed member. push() groups any records arriving within
// BATCH_WINDOW_MS of the first push in a run into a single stack entry (an array of records); undo/redo
// replay every member of that group. A push() called BATCH_WINDOW_MS+ after the last one starts a new
// group (and a new stack entry), so unrelated later edits don't get swept into an old gesture's group.
const CAP = 20
const BATCH_WINDOW_MS = 50

function _now() { return typeof performance !== 'undefined' ? performance.now() : Date.now() }

// Human-readable "what changed" for a single record, e.g. "position" / "custom.color" / "rotation".
// Structural records (spawn/delete/duplicate/reparent/rename) carry no EDITOR_UPDATE-shaped
// before/after at all -- they hold undoOp/redoOp closures and an explicit `desc` instead, so the
// desc short-circuits here before the payload-shape inference below ever runs against {} .
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

// Describes a whole group (array of records) for a toast: single-entity groups name the field, multi-entity
// groups name the count, since per-field detail across N different entities is noisy rather than useful.
function _describeGroup(group) {
  const ids = [...new Set(group.map(r => r.entityId))]
  if (ids.length === 1) return ids[0] + ' ' + _describeRecord(group[0])
  return ids.length + ' entities ' + _describeRecord(group[0])
}

// Monotonic id source for named-transaction identity (history-panel jump-to-state needs a stable
// handle per entry that survives push()es happening around it -- an array index alone would shift
// under the CAP-eviction shift() below, silently retargeting a held "jump to entry #3" reference).
let _seq = 0

export function createEditHistory({ send, onToast, onChange } = {}) {
  const undoStack = [], redoStack = []
  let _lastPushAt = 0
  const _toast = (msg) => { try { onToast && onToast(msg) } catch (_) {} }
  // onChange notifies a subscriber (the history-panel UI) any time the stacks change shape, so the
  // panel can re-render without polling. Fired at the end of every mutating call below.
  const _notify = () => { try { onChange && onChange() } catch (_) {} }
  return {
    // record a new edit; caps the undo stack and clears the redo stack (a new edit forks history).
    // Coalesces into the top-of-stack group when called within BATCH_WINDOW_MS of the previous push,
    // so one gesture (multi-select drag, align/distribute) collapses to one undoable unit.
    push(record) {
      const t = _now()
      const top = undoStack[undoStack.length - 1]
      if (top && (t - _lastPushAt) <= BATCH_WINDOW_MS) {
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
    },
    // pop the last group, apply each member's `before` payload (reverse order, in case of dependent writes), move it to the redo stack.
    // Structural records (spawn/delete/...) replace the EDITOR_UPDATE replay entirely: if the record
    // carries an undoOp closure, that closure is the undo -- send(entityId, before) would be a no-op
    // against a payload that doesn't exist.
    undo() {
      const entry = undoStack.pop()
      if (!entry) return false
      redoStack.push(entry)
      for (let i = entry.records.length - 1; i >= 0; i--) { const r = entry.records[i]; if (r.undoOp) r.undoOp(r); else send(r.entityId, r.before) }
      _toast('Undid: ' + entry.name)
      _notify()
      return true
    },
    // re-apply the last undone group's `after` payload (forward order), move it back to the undo stack
    redo() {
      const entry = redoStack.pop()
      if (!entry) return false
      undoStack.push(entry)
      for (const r of entry.records) { if (r.redoOp) r.redoOp(r); else send(r.entityId, r.after) }
      _toast('Redid: ' + entry.name)
      _notify()
      return true
    },
    // Named-transaction history panel support: a flat, newest-first list of every entry currently on
    // either stack, each tagged with its stable txnId and whether it's still on the undo side ('done')
    // or has been undone ('undone', sitting on redoStack) -- the panel renders both, since a maker
    // browsing history wants to see (and re-apply) an undone entry too, not just the live-undoable ones.
    list() {
      const done = undoStack.map((e, i) => ({ txnId: e.txnId, name: e.name, at: e.at, count: e.records.length, state: 'done', depth: undoStack.length - 1 - i }))
      const undone = redoStack.map((e, i) => ({ txnId: e.txnId, name: e.name, at: e.at, count: e.records.length, state: 'undone', depth: i }))
      // Stack order: undoStack's top (most recent) is its last element; redoStack's top (most recently
      // undone, so the "next" thing chronologically after undoStack's top) is also its last element.
      // Newest-first for the panel: reverse both and put the undone (redo-side) entries first, since
      // they are chronologically MORE recent than whatever now sits on top of the undo stack.
      return [...undone.slice().reverse(), ...done.slice().reverse()]
    },
    // Jump directly to the state AFTER the entry identified by txnId: replays undo()/redo() the
    // minimum number of times needed to move that entry (and everything before it) onto the undo
    // stack with nothing after it still applied, i.e. "the world as of right after this transaction
    // committed". Clicking an already-current top-of-undo-stack entry is a no-op (returns true, no work).
    jumpTo(txnId) {
      const undoIdx = undoStack.findIndex(e => e.txnId === txnId)
      if (undoIdx !== -1) {
        // Entry is already applied (on the undo side); undo everything ABOVE it (i.e. pop back down
        // to it) so it becomes the new top -- "jump to right after this transaction".
        const stepsBack = undoStack.length - 1 - undoIdx
        for (let i = 0; i < stepsBack; i++) this.undo()
        return true
      }
      const redoIdx = redoStack.findIndex(e => e.txnId === txnId)
      if (redoIdx !== -1) {
        // Entry was undone (sitting on the redo side); redo forward through it and everything below
        // it on the redo stack (redoStack's later-pushed = more recently undone = closer to the top).
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
