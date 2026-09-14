const POLL_MS = 500

function _resolveBridge() {
  if (typeof window === 'undefined') return null
  return window.__app?.wireweave || null
}

function _resolveHostMigration() {
  if (typeof window === 'undefined') return null
  return window.__app?.hostMigration || null
}

function snapshot() {
  const bridge = _resolveBridge()
  if (!bridge?.data?.debug) {
    return { connected: false, reason: bridge ? 'bridge.data.debug not available' : 'no wireweave bridge on window.__app' }
  }
  const d = bridge.data.debug()
  const hm = _resolveHostMigration()
  const hmState = hm?.getState?.() || null
  return {
    connected: true,
    selfPubkey: bridge.pubkey ? bridge.pubkey.slice(0, 12) : null,
    room: d.room,
    roomId: d.roomId,
    sessionFsm: d.fsm,
    peers: d.peers,
    peerCount: d.peers.length,
    openEdges: d.peers.filter(p => p.dcState === 'open').length,
    participants: d.participants,
    retrySchedule: d.retrySchedule,
    hostMigration: hmState ? {
      phase: hmState.phase,
      hostPubkeyFull: hmState.hostPubkey || null,
      hostPubkey: hmState.hostPubkey ? hmState.hostPubkey.slice(0, 12) : null,
      newHostPubkey: hmState.newHostPubkey ? hmState.newHostPubkey.slice(0, 12) : null,
      isSelfHost: !!(hmState.hostPubkey && bridge.pubkey && hmState.hostPubkey === bridge.pubkey),
      lastElection: hmState.lastElection ? {
        winner: hmState.lastElection.winner ? hmState.lastElection.winner.slice(0, 12) : null,
        candidateCount: hmState.lastElection.candidates?.length || 0
      } : null
    } : null,
    ts: Date.now()
  }
}

export function installMeshDebug() {
  if (typeof window === 'undefined') return null
  if (window.__meshDebug) return window.__meshDebug

  let _last = snapshot()
  let _listeners = new Set()
  const _tick = () => {
    _last = snapshot()
    for (const fn of _listeners) { try { fn(_last) } catch (e) { console.warn('[mesh-debug] listener threw', e?.message || e) } }
  }
  const _iv = setInterval(_tick, POLL_MS)

  function list() {
    const s = _last
    if (!s.connected) { console.log(`[mesh-debug] ${s.reason}`); return s }
    const lines = [
      `\n== P2P mesh topology (room ${s.room || '?'}) ==`,
      `  self: ${s.selfPubkey}  session-fsm: ${JSON.stringify(s.sessionFsm)}  peers: ${s.peerCount} (${s.openEdges} open)`
    ]
    if (s.hostMigration) {
      lines.push(`  host: ${s.hostMigration.hostPubkey}${s.hostMigration.isSelfHost ? ' (this tab)' : ''}  phase: ${s.hostMigration.phase}`)
      if (s.hostMigration.lastElection) lines.push(`  last election: winner=${s.hostMigration.lastElection.winner} candidates=${s.hostMigration.lastElection.candidateCount}`)
    } else {
      lines.push('  host-migration: not installed on this tab (see client/HostMigration.js)')
    }
    for (const p of s.peers) {
      lines.push(`  - ${p.pubkey}  fsm=${JSON.stringify(p.fsmState)}  conn=${p.connState}  dc=${p.dcState}  candidates=${p.candidates} buffered=${p.buffered}${s.hostMigration?.hostPubkeyFull === p.pubkey ? '  [HOST]' : ''}`)
    }
    const text = lines.join('\n')
    console.log(text)
    return text
  }

  const api = {
    snapshot: () => _last,
    list,
    onUpdate(fn) { _listeners.add(fn); return () => _listeners.delete(fn) },
    stop() { clearInterval(_iv) },
    POLL_MS
  }
  window.__meshDebug = api
  return api
}
