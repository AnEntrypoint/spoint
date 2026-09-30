const LOBBY_PREFIX = 'wwlobby:'
const ANNOUNCE_INTERVAL_MS = 500

function decodeLobby(data) {
  if (typeof data !== 'string' || !data.startsWith(LOBBY_PREFIX)) return null
  try { return JSON.parse(data.slice(LOBBY_PREFIX.length)) } catch { return null }
}

export function formPeerRoster(bridge, minPeers, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const views = new Map()
    const openPeers = () => [...bridge.data.peers.entries()].filter(([, p]) => p?.dc?.readyState === 'open').map(([pk]) => pk)
    const myView = () => [bridge.pubkey, ...openPeers()].sort()
    const key = v => v.join(',')
    let done = false
    const finish = (err, roster) => {
      if (done) return
      done = true
      clearInterval(timer); clearTimeout(deadline)
      bridge.data.removeEventListener('data', onData)
      if (err) reject(err); else resolve(roster)
    }
    const check = () => {
      const view = myView()
      if (view.length < minPeers) return
      const k = key(view)
      for (const pk of view) if (pk !== bridge.pubkey && views.get(pk) !== k) return
      bridge.data.broadcast(LOBBY_PREFIX + JSON.stringify({ roster: view, final: true }))
      finish(null, view)
    }
    const onData = ({ detail }) => {
      const msg = decodeLobby(detail?.data)
      if (!msg || !Array.isArray(msg.roster)) return
      views.set(detail.peerPubkey, key([...msg.roster].sort()))
      check()
    }
    bridge.data.addEventListener('data', onData)
    const announce = () => { bridge.data.broadcast(LOBBY_PREFIX + JSON.stringify({ roster: myView() })); check() }
    const timer = setInterval(announce, ANNOUNCE_INTERVAL_MS)
    const deadline = setTimeout(() => finish(new Error(`[PeerRoster] fewer than ${minPeers} peers agreed on a roster within ${timeoutMs}ms`)), timeoutMs)
    announce()
  })
}

export function peerFrameDelay(profile) {
  if (!profile) return null
  const { latencyMs = 0, jitterMs = 0, lossPct = 0 } = profile
  if (!latencyMs && !jitterMs && !lossPct) return null
  return () => {
    const u = Math.random() || 1e-9, v = Math.random()
    const jitter = jitterMs * Math.abs(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
    const retransmit = lossPct > 0 && Math.random() * 100 < lossPct ? 2 * latencyMs + jitterMs : 0
    return latencyMs + jitter + retransmit
  }
}
