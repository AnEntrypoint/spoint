const POLL_MS = 500
const POLL_MAX_TICKS = 240
const SETTLE_TICKS = 4

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

function _topologyKey(s) {
  if (!s.connected) return null
  return `${s.peerCount}/${s.openEdges}/${s.hostMigration?.phase ?? '-'}`
}

function _isSettled(s) {
  return s.connected && s.peerCount > 0 && s.openEdges === s.peerCount
}

export function installMeshDebug({ maxTicks = POLL_MAX_TICKS } = {}) {
  if (typeof window === 'undefined') return null
  if (window.__meshDebug) return window.__meshDebug

  const _giveUpMs = maxTicks * POLL_MS
  let _last = snapshot()
  let _listeners = new Set()
  let _ticks = 0
  let _startedAt = Date.now()
  let _settledRun = 0
  let _lastKey = _topologyKey(_last)
  let _verdict = null
  let _iv = null
  const _tick = () => {
    _ticks++
    _last = snapshot()
    const key = _topologyKey(_last)
    _settledRun = _isSettled(_last) && key === _lastKey ? _settledRun + 1 : 0
    _lastKey = key
    for (const fn of _listeners) { try { fn(_last) } catch (e) { console.warn('[mesh-debug] listener threw', e?.message || e) } }
    if (_settledRun >= SETTLE_TICKS && _listeners.size === 0) _finish('settled')
    else if (_ticks >= maxTicks || Date.now() - _startedAt >= _giveUpMs) _finish(_isSettled(_last) ? 'settled' : 'give-up')
  }
  _iv = setInterval(_tick, POLL_MS)

  function _finish(reason) {
    if (_iv === null) return _verdict
    clearInterval(_iv)
    _iv = null
    const s = _last
    _verdict = {
      reason,
      ticks: _ticks,
      ms: Date.now() - _startedAt,
      peerCount: s.connected ? s.peerCount : null,
      openEdges: s.connected ? s.openEdges : null,
      hostPhase: s.hostMigration?.phase ?? null
    }
    const state = s.connected
      ? `peers=${s.peerCount} open=${s.openEdges} host=${s.hostMigration?.hostPubkey ?? '-'} phase=${s.hostMigration?.phase ?? '-'}`
      : `no mesh: ${s.reason}`
    const why = reason === 'give-up' ? ` no settled mesh within ${_giveUpMs}ms;` : ''
    console.log(`[mesh-debug] ${reason} after ${_verdict.ticks} polls / ${_verdict.ms}ms:${why} ${state}; window.__meshDebug.restart() polls again`)
    return _verdict
  }

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
    stop() { return _finish('stopped') },
    restart() {
      if (_iv !== null) return false
      _ticks = 0
      _settledRun = 0
      _startedAt = Date.now()
      _verdict = null
      _last = snapshot()
      _lastKey = _topologyKey(_last)
      _iv = setInterval(_tick, POLL_MS)
      return true
    },
    get stopped() { return _iv === null },
    get verdict() { return _verdict },
    POLL_MS,
    POLL_MAX_TICKS: maxTicks,
    POLL_GIVE_UP_MS: _giveUpMs,
    SETTLE_TICKS
  }
  window.__meshDebug = api
  return api
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapMeshDebug = (next) => {
  installMeshDebug = next.installMeshDebug
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapMeshDebug)
