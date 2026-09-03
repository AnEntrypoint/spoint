// Server-side agent edit staging (editor-collaborative-crdt-agent-staging-full-flow).
//
// Extends the client-side AgentEditStaging (client/editor/AgentEditStaging.js, which handles
// the IndexedDB persistence and conflict detection on the client) with a server-side staging
// area for agent-proposed edits. An agent (freddie, claude, etc.) proposes a set of staged
// edits via AGENT_EDIT_PROPOSE. The server stores them in-memory, broadcasts the proposal
// to all connected editors (so they can render ghost previews in-viewport), and waits for
// approval (AGENT_EDIT_APPROVE) or rejection (AGENT_EDIT_REJECT).
//
// Each proposal has a unique id, carries the appName/file/source/baseSource fields matching
// the client-side AgentEditStaging record shape, and can be approved/rejected per-op or
// wholesale (approveAll/rejectAll).
//
// Dual-import safe: zero Node/browser-specific APIs, only uses JS primitives.

function generateId() {
  // Simple timestamp-based id with random suffix; doesn't need to be globally unique
  // across restarts, just unique within the session.
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `agent-${ts}-${rand}`
}

export function createAgentEditServer() {
  // id -> { id, appName, file, source, baseSource, proposedBy, proposedAt, status }
  // status: 'pending' | 'approved' | 'rejected'
  const _proposals = new Map()

  // Propose a set of edits. Each edit is {appName, file, source, baseSource?}.
  // Returns the proposal id.
  function propose(edits, proposedBy) {
    if (!Array.isArray(edits) || edits.length === 0) return null

    const proposalId = generateId()
    const ts = Date.now()

    for (const edit of edits) {
      if (!edit.appName || edit.source == null) continue
      const id = `${proposalId}-${edit.appName}-${edit.file || 'index.js'}`
      _proposals.set(id, {
        id,
        proposalId,
        appName: edit.appName,
        file: edit.file || 'index.js',
        source: edit.source,
        baseSource: edit.baseSource || null,
        proposedBy: proposedBy || 'agent',
        proposedAt: ts,
        status: 'pending',
      })
    }

    return proposalId
  }

  // List all proposals, optionally filtered by status
  function list(filterStatus) {
    const all = Array.from(_proposals.values())
    if (filterStatus === 'pending' || filterStatus === 'approved' || filterStatus === 'rejected') {
      return all.filter(p => p.status === filterStatus)
    }
    return all
  }

  // Get a single proposal by id
  function get(id) {
    return _proposals.get(id) || null
  }

  // Get all proposals for a given proposalId
  function getByProposalId(proposalId) {
    return Array.from(_proposals.values()).filter(p => p.proposalId === proposalId)
  }

  // Approve one specific edit by id. Returns the edit record on success, null if not found.
  function approve(id, approvedBy) {
    const p = _proposals.get(id)
    if (!p || p.status !== 'pending') return null
    p.status = 'approved'
    p.approvedBy = approvedBy || 'editor'
    p.approvedAt = Date.now()
    return p
  }

  // Approve ALL pending edits in a proposal. Returns the approved edits.
  function approveAll(proposalId, approvedBy) {
    const results = []
    for (const p of _proposals.values()) {
      if (p.proposalId === proposalId && p.status === 'pending') {
        p.status = 'approved'
        p.approvedBy = approvedBy || 'editor'
        p.approvedAt = Date.now()
        results.push(p)
      }
    }
    return results
  }

  // Reject one specific edit by id. Returns the edit record on success, null if not found.
  function reject(id, rejectedBy) {
    const p = _proposals.get(id)
    if (!p || p.status !== 'pending') return null
    p.status = 'rejected'
    p.rejectedBy = rejectedBy || 'editor'
    p.rejectedAt = Date.now()
    return p
  }

  // Reject ALL pending edits in a proposal. Returns the rejected edits.
  function rejectAll(proposalId, rejectedBy) {
    const results = []
    for (const p of _proposals.values()) {
      if (p.proposalId === proposalId && p.status === 'pending') {
        p.status = 'rejected'
        p.rejectedBy = rejectedBy || 'editor'
        p.rejectedAt = Date.now()
        results.push(p)
      }
    }
    return results
  }

  // Remove a proposal entirely (e.g. after it's been applied and is no longer needed)
  function remove(id) {
    return _proposals.delete(id)
  }

  function removeAll(proposalId) {
    for (const [id, p] of _proposals) {
      if (p.proposalId === proposalId) _proposals.delete(id)
    }
  }

  function pendingCount() {
    let count = 0
    for (const p of _proposals.values()) { if (p.status === 'pending') count++ }
    return count
  }

  function totalCount() { return _proposals.size }

  function clear() { _proposals.clear() }

  return {
    propose, list, get, getByProposalId,
    approve, approveAll, reject, rejectAll,
    remove, removeAll,
    pendingCount, totalCount, clear,
  }
}