const CTRL_PREFIX = 'wwrelay:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const RELAY_CHECK_MS = 2000
const RELAY_BUFFERED_THRESHOLD = 16 * 1024
const RELAY_TRIGGER_STREAK = 3
const RELAY_FANOUT = 2

const JOINER_MISS_MS = 1000
const JOINER_MISS_STREAK = 3
const JOINER_RELAY_REQUEST_COOLDOWN_MS = 5000

export function installSnapshotRelayHost({ bridge }) {
  const lastSnapshotByPeer = new Map()
  const degradedCheckStreakByPeer = new Map()
  const stats = { relaysSent: 0, lastRelayAt: 0, degradedPeers: [] }

  function onPeerSnapshot(peerPubkey, bytes) {
    lastSnapshotByPeer.set(peerPubkey, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }

  function healthyRelayCandidates(excludePubkey) {
    const out = []
    for (const [pk, peer] of bridge.data.peers) {
      if (pk === excludePubkey) continue
      const dc = peer?.dc
      if (dc?.readyState === 'open' && (dc.bufferedAmount || 0) < RELAY_BUFFERED_THRESHOLD) out.push(pk)
    }
    return out
  }

  function triggerRelay(target) {
    const snap = lastSnapshotByPeer.get(target)
    if (!snap || !snap.length) return false
    const relayers = healthyRelayCandidates(target).slice(0, RELAY_FANOUT)
    if (!relayers.length) return false
    const payload = encodeCtrl({ type: 'relay', forTarget: target, snapshotB64: bytesToB64(snap) })
    for (const rp of relayers) bridge.data.send(rp, payload)
    stats.relaysSent += relayers.length
    stats.lastRelayAt = Date.now()
    return true
  }

  function checkOnce() {
    const degraded = []
    for (const [pk, peer] of bridge.data.peers) {
      const dc = peer?.dc
      if (!dc || dc.readyState !== 'open') { degradedCheckStreakByPeer.delete(pk); continue }
      const buffered = dc.bufferedAmount || 0
      if (buffered >= RELAY_BUFFERED_THRESHOLD) {
        const streak = (degradedCheckStreakByPeer.get(pk) || 0) + 1
        degradedCheckStreakByPeer.set(pk, streak)
        if (streak >= RELAY_TRIGGER_STREAK) degraded.push(pk)
      } else {
        degradedCheckStreakByPeer.delete(pk)
      }
    }
    stats.degradedPeers = degraded
    for (const target of degraded) triggerRelay(target)
  }

  const iv = setInterval(checkOnce, RELAY_CHECK_MS)

  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg || msg.type !== 'relay-request' || !msg.forTarget) return
    triggerRelay(msg.forTarget)
  })

  return {
    onPeerSnapshot,
    getStats() { return { ...stats, degradedPeers: [...stats.degradedPeers] } },
    stop() { clearInterval(iv) }
  }
}

export function installSnapshotRelayJoiner({ getClient, bridge }) {
  const stats = { relayedForwarded: 0, relayedApplied: 0, lastAppliedAt: 0, missStreak: 0, relayRequestsSent: 0, lastRelayRequestAt: 0 }
  let lastSeenTick = -1
  let lastRelayRequestAt = 0

  function sendRelayRequest() {
    const client = getClient()
    const myPubkey = bridge.pubkey
    if (!myPubkey) return
    const payload = encodeCtrl({ type: 'relay-request', forTarget: myPubkey })
    const hostPubkey = client?._hostPubkey
    const hostDc = hostPubkey ? bridge.data.peers.get(hostPubkey)?.dc : null
    if (hostDc?.readyState === 'open') {
      bridge.data.send(hostPubkey, payload)
    } else {
      for (const [pk, peer] of bridge.data.peers) {
        if (pk === myPubkey || pk === hostPubkey) continue
        if (peer?.dc?.readyState === 'open') bridge.data.send(pk, payload)
      }
    }
    stats.relayRequestsSent++
    stats.lastRelayRequestAt = lastRelayRequestAt = Date.now()
  }

  function checkMissedSnapshots() {
    const client = getClient()
    if (!client || client._worker) { lastSeenTick = -1; stats.missStreak = 0; return }
    const tick = client.currentTick || 0
    if (tick !== lastSeenTick) {
      lastSeenTick = tick
      stats.missStreak = 0
      return
    }
    const streak = stats.missStreak + 1
    stats.missStreak = streak
    if (streak >= JOINER_MISS_STREAK && Date.now() - lastRelayRequestAt >= JOINER_RELAY_REQUEST_COOLDOWN_MS) {
      sendRelayRequest()
    }
  }

  const missIv = setInterval(checkMissedSnapshots, JOINER_MISS_MS)

  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg) return
    if (msg.type === 'relay-request' && msg.forTarget && msg.forTarget !== bridge.pubkey) {
      const client = getClient()
      const hostPubkey = client?._hostPubkey
      if (!hostPubkey || hostPubkey === detail.peerPubkey) return
      const dc = bridge.data.peers.get(hostPubkey)?.dc
      if (dc?.readyState === 'open') bridge.data.send(hostPubkey, encodeCtrl(msg))
      return
    }
    if (msg.type === 'relay' && msg.forTarget && msg.snapshotB64) {
      if (msg.forTarget === bridge.pubkey) return
      const dc = bridge.data.peers.get(msg.forTarget)?.dc
      if (!dc || dc.readyState !== 'open') return
      dc.send(encodeCtrl({ type: 'relayed-snapshot', snapshotB64: msg.snapshotB64 }))
      stats.relayedForwarded++
      return
    }
    if (msg.type === 'relayed-snapshot' && msg.snapshotB64) {
      const client = getClient()
      if (!client || typeof client.onMessage !== 'function' || client._worker) return
      try {
        const bytes = b64ToBytes(msg.snapshotB64)
        client.onMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        stats.relayedApplied++
        stats.lastAppliedAt = Date.now()
      } catch (e) { console.warn('[SnapshotRelay] failed to apply relayed snapshot:', e?.message || e) }
    }
  })

  return {
    getStats() { return { ...stats } },
    stop() { clearInterval(missIv) }
  }
}

export const _test = { encodeCtrl, decodeCtrl, bytesToB64, b64ToBytes, RELAY_BUFFERED_THRESHOLD, RELAY_TRIGGER_STREAK, RELAY_FANOUT, JOINER_MISS_MS, JOINER_MISS_STREAK, JOINER_RELAY_REQUEST_COOLDOWN_MS }
