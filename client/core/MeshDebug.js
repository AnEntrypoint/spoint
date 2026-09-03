// MeshDebug -- live P2P mesh topology introspection surface (p2p-mesh-topology-live-debug-view).
//
// WHY THIS EXISTS: node_modules/wireweave's DataSession.debug() (node_modules/wireweave/src/data.js)
// is a fully-built, ready-to-consume live introspection method -- it already returns
// {fsm, room, roomId, peers:[{pubkey, fsmState, connState, dcState, candidates, buffered}],
// participants, retrySchedule} -- but nothing in this codebase called it anywhere (grep-confirmed zero
// call sites of `.debug()` on a wireweave bridge before this file). A developer debugging a P2P session
// had no visibility into the real mesh topology (how many peers are actually connected, which edges are
// open vs still negotiating, which peer is currently the app-layer host) short of manually poking
// window.__app.wireweave.data in a console. This module is the live registry + poller + optional panel
// that surfaces it, mirroring the existing window.__renderGraph/window.__culling/window.__renderControls
// discovery pattern (see client/core/RenderControls.js's own header for the precedent).
//
// SCOPE: read-only introspection. Never mutates bridge/peer/host-migration state -- polls
// bridge.data.debug() plus (if present) window.__app.hostMigration.getState() on an interval and
// exposes the merged snapshot. Works whether this tab is a wireweave host, a joiner, or (via
// HostMigration.js) a migration-elected new host -- all three share the same underlying bridge shape.

const POLL_MS = 500

function _resolveBridge() {
  if (typeof window === 'undefined') return null
  return window.__app?.wireweave || null
}

function _resolveHostMigration() {
  if (typeof window === 'undefined') return null
  return window.__app?.hostMigration || null
}

// Builds one merged snapshot: DataSession.debug()'s real peer list + connection states, plus
// (when available) which pubkey is the current app-layer host and the migration phase, plus this
// tab's OWN pubkey (bridge.pubkey, not present in DataSession.debug()'s peer list since a session
// only enumerates its REMOTE peers).
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
    peers: d.peers, // [{pubkey, fsmState, connState, dcState, candidates, buffered}]
    peerCount: d.peers.length,
    openEdges: d.peers.filter(p => p.dcState === 'open').length,
    participants: d.participants,
    retrySchedule: d.retrySchedule,
    // Host-layer info, only present once client/HostMigration.js has been installed (both the
    // original host path and any migration-elected replacement host install it identically).
    // hostPubkeyFull is kept UNSLICED so callers (list()/MeshDebugPanel.js) can match it against
    // DataSession.debug()'s own peer[].pubkey entries (also unsliced) to mark the [HOST] peer --
    // hostPubkey (sliced to 12 chars, matching DataSession.debug()'s own peer-pubkey truncation
    // convention) is the display-only value, never usable for equality comparison against a peer.
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

// Installs the window.__meshDebug live accessor. Call once, any time after boot -- it lazily resolves
// window.__app.wireweave/hostMigration on every poll rather than requiring them to exist yet, so it is
// safe to install BEFORE the P2P bridge connects (e.g. from a top-level boot script) and it will simply
// report {connected:false} until a bridge shows up.
export function installMeshDebug() {
  if (typeof window === 'undefined') return null
  if (window.__meshDebug) return window.__meshDebug // idempotent -- a second install (e.g. hot-reload) reuses the running poller

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
    // Subscribe to every poll tick (500ms cadence) -- used by the optional visual panel below, also
    // usable directly from the console/another script for a live log.
    onUpdate(fn) { _listeners.add(fn); return () => _listeners.delete(fn) },
    stop() { clearInterval(_iv) },
    POLL_MS
  }
  window.__meshDebug = api
  return api
}
