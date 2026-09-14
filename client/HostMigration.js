const CTRL_PREFIX = 'wwmigrate:'
const HOST_REANNOUNCE_COUNT = 5
const HOST_REANNOUNCE_INTERVAL_MS = 1000
const NEW_HOST_BOOT_GRACE_MS = 4000
const NOSTR_APP_DATA_KIND = 30078

function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

function encodeFullWorldDef(worldDef) { return encodeCtrl({ type: 'full-worlddef', worldDef }) }

function electWinner(candidates) {
  let best = null
  for (const c of candidates) {
    const rtt = Number.isFinite(c.rtt) ? c.rtt : Infinity
    if (!best) { best = { ...c, rtt }; continue }
    if (rtt < best.rtt || (rtt === best.rtt && c.pubkey < best.pubkey)) best = { ...c, rtt }
  }
  return best
}

function buildMigrationSnapshot(client, pubkeyOf) {
  const players = []
  for (const [pid, st] of client.getAllStates()) {
    const pubkey = pubkeyOf(pid)
    if (!pubkey) continue
    players.push({ pubkey, position: [...st.position], rotation: [...st.rotation], health: st.health })
  }
  const entities = []
  for (const [eid, st] of client.getAllEntities()) {
    entities.push({ id: eid, position: [...st.position], rotation: [...st.rotation], velocity: [...st.velocity] })
  }
  return { players, entities }
}

export function installHostMigration({ client, bridge, worldDef, apps, ctxRoot, uiRoot, room, namespace, iceServers, onNewHost }) {
  let electing = false
  let electedWinnerPubkey = null
  let fullWorldDef = worldDef
  const state = { phase: 'connected', hostPubkey: client._hostPubkey, newHostPubkey: null, lastElection: null }

  function pubkeyOf(playerId) {
    if (playerId === client.playerId) return bridge.pubkey
    return client._msgHandler.getPeerRttTable().pubkeys[playerId] || null
  }

  function announceAsNewHost() {
    installHostAnnouncer(bridge, fullWorldDef)
    const payload = encodeCtrl({ type: 'host-announce', pubkey: bridge.pubkey })
    let n = 0
    const iv = setInterval(() => {
      bridge.data.broadcast(payload)
      if (++n >= HOST_REANNOUNCE_COUNT) clearInterval(iv)
    }, HOST_REANNOUNCE_INTERVAL_MS)
  }

  async function becomeNewHost() {
    state.phase = 'electing-self'
    const snapshot = buildMigrationSnapshot(client, pubkeyOf)
    client._hostPubkey = null
    client.connected = false
    const { BrowserServer } = await import('./BrowserServer.js')
    const newServer = new BrowserServer({ ...ctxRoot, worldDef: fullWorldDef, migrationSnapshot: snapshot, localPubkey: bridge.pubkey })
    await newServer.connect()
    const attached = new Set()
    const attachIfReady = pk => {
      if (attached.has(pk) || pk === bridge.pubkey) return
      const dc = bridge.data.peers.get(pk)?.dc
      if (!dc || dc.readyState !== 'open') return
      attached.add(pk)
      newServer.attachWireweavePeer(pk, dc)
    }
    bridge.data.addEventListener('peer-open', ({ detail }) => attachIfReady(detail.peerPubkey))
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') attachIfReady(pk)
    bridge.data.addEventListener('peer-close', ({ detail }) => {
      attached.delete(detail.peerPubkey)
    })
    state.phase = 'hosting'
    state.newHostPubkey = bridge.pubkey
    announceAsNewHost()
    onNewHost?.({ becameHost: true, server: newServer })
    return newServer
  }

  function repointToNewHost(newHostPubkey) {
    state.phase = 're-pointing'
    client._hostPubkey = newHostPubkey
    const dc = bridge.data.peers.get(newHostPubkey)?.dc
    if (dc && dc.readyState === 'open') {
      client._dc = dc
      client.connected = true
      if (client._pendingSends.length) { const q = client._pendingSends; client._pendingSends = []; for (const buf of q) client._rawSend(buf) }
    } else {
      client.connected = false
    }
    state.phase = 'reconnected'
    state.hostPubkey = newHostPubkey
    onNewHost?.({ becameHost: false, hostPubkey: newHostPubkey })
  }

  function handleHostAnnounce(fromPubkey, msg) {
    if (state.phase === 'hosting') return
    if (msg.pubkey !== fromPubkey) return
    repointToNewHost(msg.pubkey)
  }

  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg) return
    if (msg.type === 'host-announce') handleHostAnnounce(detail.peerPubkey, msg)
    else if (msg.type === 'full-worlddef' && detail.peerPubkey === state.hostPubkey && msg.worldDef && typeof msg.worldDef === 'object') {
      fullWorldDef = msg.worldDef
    }
  })

  async function runElection() {
    if (electing) return
    electing = true
    state.phase = 'electing'
    try {
      const rttTable = client._msgHandler.getPeerRttTable()
      const myRtt = client.getRTT()
      const candidates = [{ pubkey: bridge.pubkey, rtt: myRtt }]
      for (const [pk] of bridge.data.peers) {
        if (pk === state.hostPubkey) continue
        let rtt = null
        for (const [pid, pubkey] of Object.entries(rttTable.pubkeys)) { if (pubkey === pk) { rtt = rttTable.rtt[pid]; break } }
        candidates.push({ pubkey: pk, rtt })
      }
      const winner = electWinner(candidates)
      state.lastElection = { candidates, winner: winner?.pubkey }
      electedWinnerPubkey = winner?.pubkey || null
      if (!electedWinnerPubkey) { state.phase = 'election-failed-no-candidates'; return }
      if (electedWinnerPubkey === bridge.pubkey) {
        await becomeNewHost()
      } else {
        state.phase = 'awaiting-new-host-announce'
        setTimeout(() => {
          if (state.phase === 'awaiting-new-host-announce' && state.hostPubkey !== electedWinnerPubkey) {
            const dc = bridge.data.peers.get(electedWinnerPubkey)?.dc
            if (dc?.readyState === 'open') repointToNewHost(electedWinnerPubkey)
          }
        }, NEW_HOST_BOOT_GRACE_MS)
      }
    } finally {
      electing = false
    }
  }

  const onPeerGone = ({ detail }) => {
    if (detail.peerPubkey !== state.hostPubkey) return
    if (state.phase === 'hosting') return
    runElection()
  }
  bridge.data.addEventListener('peer-close', onPeerGone)
  bridge.data.addEventListener('peer-closed', onPeerGone)

  return {
    getState() { return { ...state } },
    forceElection: runElection,
    _electWinner: electWinner,
    _buildMigrationSnapshot: () => buildMigrationSnapshot(client, pubkeyOf)
  }
}

export function installHostAnnouncer(bridge, worldDef) {
  const hostPayload = encodeCtrl({ type: 'host-announce', pubkey: bridge.pubkey })
  const worldPayload = worldDef ? encodeFullWorldDef(worldDef) : null
  const announce = () => { bridge.data.broadcast(hostPayload); if (worldPayload) bridge.data.broadcast(worldPayload) }
  bridge.data.addEventListener('peer-open', announce)
  announce()
}

export function waitForExistingHost(bridge, graceMs = 1500) {
  return new Promise(resolve => {
    let done = false
    const finish = pubkey => { if (done) return; done = true; bridge.data.removeEventListener('data', onData); clearTimeout(timer); resolve(pubkey) }
    const onData = ({ detail }) => {
      const msg = decodeCtrl(detail.data)
      if (msg && msg.type === 'host-announce' && msg.pubkey === detail.peerPubkey) finish(msg.pubkey)
    }
    bridge.data.addEventListener('data', onData)
    const timer = setTimeout(() => finish(null), graceMs)
  })
}

export function claimHostViaRelay(bridge, roomId, graceMs = 800) {
  return new Promise(resolve => {
    const dTag = 'wireweave-hostclaim:' + roomId
    const subId = 'hostclaim-' + Math.random().toString(36).slice(2, 10)
    let done = false
    let sawCompeting = null
    const finish = () => {
      if (done) return
      done = true
      try { bridge.pool.unsubscribe(subId) } catch (_) {}
      clearTimeout(timer)
      if (sawCompeting && sawCompeting !== bridge.pubkey) {
        const winner = electWinner([{ pubkey: bridge.pubkey, rtt: null }, { pubkey: sawCompeting, rtt: null }])
        resolve(winner?.pubkey === bridge.pubkey ? { shouldDefer: false, winnerPubkey: null } : { shouldDefer: true, winnerPubkey: sawCompeting })
      } else {
        resolve({ shouldDefer: false, winnerPubkey: null })
      }
    }
    const onEvent = (evt) => {
      const dt = Array.isArray(evt?.tags) ? evt.tags.find(t => t[0] === 'd') : null
      if (!dt || dt[1] !== dTag) return
      const claimerPubkey = evt.pubkey
      if (claimerPubkey === bridge.pubkey) return
      if (!sawCompeting || claimerPubkey < sawCompeting) sawCompeting = claimerPubkey
    }
    bridge.pool.subscribe(subId, [{ kinds: [NOSTR_APP_DATA_KIND], '#d': [dTag] }], onEvent)
    const timer = setTimeout(finish, graceMs)
    bridge.auth.sign({
      kind: NOSTR_APP_DATA_KIND, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag]],
      content: JSON.stringify({ pubkey: bridge.pubkey, ts: Date.now() }),
    }).then(signed => { bridge.pool.publish(signed) }).catch(() => {})
  })
}

export const _test = { electWinner, encodeCtrl, decodeCtrl, buildMigrationSnapshot, waitForExistingHost, claimHostViaRelay }
