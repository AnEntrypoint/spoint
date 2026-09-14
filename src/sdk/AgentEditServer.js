function generateId() {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `agent-${ts}-${rand}`
}

export function createAgentEditServer() {
  const _proposals = new Map()

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

  function list(filterStatus) {
    const all = Array.from(_proposals.values())
    if (filterStatus === 'pending' || filterStatus === 'approved' || filterStatus === 'rejected') {
      return all.filter(p => p.status === filterStatus)
    }
    return all
  }

  function get(id) {
    return _proposals.get(id) || null
  }

  function getByProposalId(proposalId) {
    return Array.from(_proposals.values()).filter(p => p.proposalId === proposalId)
  }

  function approve(id, approvedBy) {
    const p = _proposals.get(id)
    if (!p || p.status !== 'pending') return null
    p.status = 'approved'
    p.approvedBy = approvedBy || 'editor'
    p.approvedAt = Date.now()
    return p
  }

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

  function reject(id, rejectedBy) {
    const p = _proposals.get(id)
    if (!p || p.status !== 'pending') return null
    p.status = 'rejected'
    p.rejectedBy = rejectedBy || 'editor'
    p.rejectedAt = Date.now()
    return p
  }

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