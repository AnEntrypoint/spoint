function peerEvent(type, detail) {
  const e = new Event(type)
  e.detail = detail
  return e
}

export function createWorkerBridgeProxy({ localPubkey, roster, post }) {
  const target = new EventTarget()
  const peers = new Map(roster.filter(pk => pk !== localPubkey).map(pk => [pk, { dc: { readyState: 'open' } }]))
  const data = {
    peers,
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    removeEventListener: (type, fn) => target.removeEventListener(type, fn),
    broadcast(frame) { post({ type: 'BRIDGE_BROADCAST', data: frame }); return peers.size },
    send(pubkey, frame) { post({ type: 'BRIDGE_SEND', to: pubkey, data: frame }); return true }
  }
  return {
    pubkey: localPubkey,
    data,
    deliver(from, frame) { target.dispatchEvent(peerEvent('data', { peerPubkey: from, data: frame })) },
    peerLeft(pubkey) {
      const p = peers.get(pubkey)
      if (p) p.dc.readyState = 'closed'
      target.dispatchEvent(peerEvent('peer-close', { peerPubkey: pubkey }))
    }
  }
}
