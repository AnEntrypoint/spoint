// Visual P2P mesh topology panel (p2p-mesh-topology-live-debug-view). Thin DOM view over
// client/core/MeshDebug.js's live poller -- shows the real peer list, connection states, and current
// app-layer host at a glance, instead of requiring a console call. Uses anentrypoint-design kit
// primitives same as client/hud/PeerHostUI.js (this file's styling twin).
import { h, applyDiff } from 'anentrypoint-design'
import { installMeshDebug } from '../core/MeshDebug.js'

function ensureStyle() {
  if (document.getElementById('mesh-debug-panel-style')) return
  const s = document.createElement('style')
  s.id = 'mesh-debug-panel-style'
  s.textContent = `
    .mdp-card{position:fixed;bottom:max(8px,env(safe-area-inset-bottom));left:max(8px,env(safe-area-inset-left));z-index:1000;width:min(360px,calc(100vw - 16px));max-height:50vh;overflow-y:auto;pointer-events:all;display:flex;flex-direction:column;gap:6px;padding:10px;font:11px/1.4 var(--ff-mono, ui-monospace, monospace)}
    .mdp-card .mdp-h{font-size:12px;font-weight:600;color:var(--panel-text);font-family:var(--ff-body, inherit)}
    .mdp-card .mdp-row{display:flex;justify-content:space-between;gap:8px;color:var(--panel-text-3)}
    .mdp-card .mdp-peer{border-top:1px solid var(--rule);padding-top:4px;margin-top:2px}
    .mdp-card .mdp-peer .mdp-pk{color:var(--panel-text);font-weight:600}
    .mdp-card .mdp-host{color:var(--accent)}
    .mdp-card .mdp-dc-open{color:#4caf50}
    .mdp-card .mdp-dc-other{color:#e0a030}
    .mdp-card .mdp-empty{color:var(--panel-text-3)}
  `
  document.head.appendChild(s)
}

// Mounts the live mesh-topology panel into uiRoot and starts polling. Returns {node, destroy()}
// matching createRoomCodeUI/createPeerHostUI's own return shape. Safe to call before the wireweave
// bridge connects (MeshDebug.js lazily resolves window.__app.wireweave every poll tick).
export function createMeshDebugPanel(uiRoot) {
  ensureStyle()
  const mesh = installMeshDebug()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 mdp-card'
  uiRoot.appendChild(card)

  function render(s) {
    if (!s || !s.connected) {
      applyDiff(card, [
        h('div', { class: 'mdp-h' }, 'P2P Mesh Topology'),
        h('div', { class: 'mdp-empty' }, s?.reason || 'no wireweave session')
      ])
      return
    }
    const rows = [
      h('div', { class: 'mdp-h' }, `P2P Mesh Topology — room ${s.room || '?'}`),
      h('div', { class: 'mdp-row' }, [h('span', {}, 'self'), h('span', {}, s.selfPubkey)]),
      h('div', { class: 'mdp-row' }, [h('span', {}, 'peers'), h('span', {}, `${s.peerCount} (${s.openEdges} open)`)])
    ]
    if (s.hostMigration) {
      rows.push(h('div', { class: 'mdp-row' }, [
        h('span', {}, 'host'),
        h('span', { class: 'mdp-host' }, `${s.hostMigration.hostPubkey}${s.hostMigration.isSelfHost ? ' (you)' : ''}`)
      ]))
      rows.push(h('div', { class: 'mdp-row' }, [h('span', {}, 'phase'), h('span', {}, s.hostMigration.phase)]))
    }
    if (!s.peers.length) {
      rows.push(h('div', { class: 'mdp-empty' }, 'no peers connected yet'))
    } else {
      for (const p of s.peers) {
        const isHost = s.hostMigration?.hostPubkeyFull === p.pubkey
        const dcClass = p.dcState === 'open' ? 'mdp-dc-open' : 'mdp-dc-other'
        rows.push(h('div', { class: 'mdp-peer' }, [
          h('div', { class: 'mdp-row' }, [
            h('span', { class: 'mdp-pk' }, p.pubkey + (isHost ? ' [HOST]' : '')),
            h('span', { class: dcClass }, p.dcState || 'none')
          ]),
          h('div', { class: 'mdp-row' }, [
            h('span', {}, `conn: ${p.connState || '?'}`),
            h('span', {}, `fsm: ${typeof p.fsmState === 'string' ? p.fsmState : JSON.stringify(p.fsmState)}`)
          ])
        ]))
      }
    }
    applyDiff(card, rows)
  }

  render(mesh?.snapshot())
  const unsubscribe = mesh?.onUpdate(render)

  return {
    node: card,
    destroy() { unsubscribe?.(); card.remove() }
  }
}
