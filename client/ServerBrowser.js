// Client-side server browser: discovers BOTH dedicated servers (src/sdk/ServerPresence.js's
// kind:30078 'spoint-server:<ns>:<port>' addressable events) and P2P wireweave-hosted rooms
// (node_modules/wireweave/src/data.js's 'wireweave-data:<roomId>' presence, the same events
// client/HostMigration.js's peer mesh already relies on) into ONE merged list, by subscribing to a
// single nostr filter scoped to the shared `ns` tag both wire shapes carry -- no room/port needs to
// be known ahead of time, which is the whole discovery problem this module solves.
//
// Wire-shape disambiguation (both are kind:30078, both carry ['ns', namespace]):
//   dedicated : ServerPresence.js's payload -- { action, worldName, host, port, mode, players,
//               maxPlayers, tickRate, protocolVersion, ts }, tag ['d','spoint-server:<ns>:<port>']
//   P2P room  : wireweave/data.js's payload -- { action, name, room, ts }, tag
//               ['d','wireweave-data:<roomId>']. Distinguished by the 'd' tag prefix (authoritative,
//               matches each publisher's own dTag scheme) rather than payload-shape sniffing.
//
// Ping semantics differ by kind because the two server shapes expose different network surfaces
// BEFORE a client actually joins:
//   dedicated : a real lightweight WS connect to ws://host:port/ws, timed to the 'open' event, then
//               immediately closed -- src/sdk/ServerAPI.js's wss upgrade accepts the connection with
//               no handshake required, so 'open' fired is a true round-trip measurement.
//   P2P room  : no direct network endpoint exists pre-join (WebRTC signaling itself happens over
//               nostr relays, there is nothing to socket-connect to yet) -- shown as the relay
//               round-trip latency instead (RelayPool.status()'s own measured latencyMs), clearly
//               labeled 'relay' so it is never confused with a real host RTT.
//
// Click-to-join:
//   dedicated : navigates to `${pathname}?connect=host:port` -- client/app.js's _connectParam feeds
//               PhysicsNetworkClient's config.url, overriding the same-origin default.
//   P2P room  : navigates to `${pathname}?wwjoin&room=<id>` -- identical to createLobby.js's existing
//               join flow (WireweaveJoinClient).
//
// Presence rows expire PRESENCE_EXPIRY_MS after their last-seen 'ts' (heartbeat cadence is 30s on
// both publishers) so a crashed/killed process without a graceful 'offline'/'leave' publish still
// drops off the list instead of showing a permanently-live phantom entry.

import { components as C, h, applyDiff } from 'anentrypoint-design'

const PRESENCE_EXPIRY_MS = 90000 // 3x the 30s heartbeat cadence on both publishers
const PING_TIMEOUT_MS = 4000
const PING_REFRESH_MS = 15000

function ensureStyle() {
  if (document.getElementById('server-browser-style')) return
  const s = document.createElement('style')
  s.id = 'server-browser-style'
  s.textContent = `
    .sb-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);pointer-events:all}
    .sb-card{width:min(640px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 64px));display:flex;flex-direction:column;gap:10px;padding:16px;overflow:hidden}
    .sb-card .sb-h{font-size:15px;font-weight:700;color:var(--panel-text)}
    .sb-card .sb-sub{font-size:11px;color:var(--panel-text-3)}
    .sb-list{overflow-y:auto;display:flex;flex-direction:column;gap:6px;flex:1;min-height:0}
    .sb-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--rule);border-radius:var(--r-1,6px);background:var(--panel-0,var(--panel-1));cursor:pointer}
    .sb-row:hover{border-color:var(--accent)}
    .sb-row .sb-name{font-size:13px;font-weight:600;color:var(--panel-text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sb-row .sb-badge{font-size:10px;padding:2px 6px;border-radius:3px;background:var(--panel-1);color:var(--panel-text-3);flex-shrink:0}
    .sb-row .sb-badge.sb-dedicated{color:var(--accent)}
    .sb-row .sb-map{font-size:11px;color:var(--panel-text-3);flex-shrink:0;width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sb-row .sb-players{font-size:11px;color:var(--panel-text-3);flex-shrink:0;width:56px;text-align:right}
    .sb-row .sb-ping{font-size:11px;flex-shrink:0;width:64px;text-align:right;color:var(--panel-text-3)}
    .sb-row .sb-ping.sb-good{color:#4caf50}
    .sb-row .sb-ping.sb-ok{color:#ff9800}
    .sb-row .sb-ping.sb-bad{color:#ff6b6b}
    .sb-empty{padding:24px 8px;text-align:center;font-size:12px;color:var(--panel-text-3)}
    .sb-actions{display:flex;justify-content:flex-end;gap:8px}
  `
  document.head.appendChild(s)
}

function pingWs(url) {
  return new Promise((resolve) => {
    let done = false
    const t0 = performance.now()
    let ws
    try { ws = new WebSocket(url) } catch (_) { resolve(null); return }
    const finish = (ms) => { if (done) return; done = true; try { ws.close() } catch (_) {} ; resolve(ms) }
    const timer = setTimeout(() => finish(null), PING_TIMEOUT_MS)
    ws.onopen = () => { clearTimeout(timer); finish(Math.round(performance.now() - t0)) }
    ws.onerror = () => { clearTimeout(timer); finish(null) }
  })
}

function pingClass(ms) {
  if (ms == null) return ''
  if (ms < 80) return 'sb-good'
  if (ms < 180) return 'sb-ok'
  return 'sb-bad'
}

// Parses a raw nostr kind:30078 event into a normalized row, or null if it's neither shape this
// browser understands (e.g. wireweave's roles/settings/pages/voice/bans namespaces also use
// kind:30078 with their own 'd' tag prefixes -- must not be mistaken for a server/room row).
function parseEvent(event) {
  const dTag = event.tags?.find(t => t[0] === 'd')?.[1] || ''
  let data
  try { data = JSON.parse(event.content) } catch (_) { return null }
  if (dTag.startsWith('spoint-server:')) {
    if (!data.host || !data.port) return null
    return {
      kind: 'dedicated',
      id: event.pubkey + ':' + dTag,
      pubkey: event.pubkey,
      action: data.action,
      name: data.worldName || 'unknown',
      map: data.worldName || 'unknown',
      mode: data.mode || 'default',
      players: data.players ?? 0,
      maxPlayers: data.maxPlayers ?? null,
      host: data.host,
      port: data.port,
      ts: data.ts || 0,
    }
  }
  if (dTag.startsWith('wireweave-data:')) {
    const roomTag = event.tags?.find(t => t[0] === 'room')?.[1]
    const room = data.room || roomTag
    if (!room) return null
    return {
      kind: 'p2p',
      id: event.pubkey + ':' + dTag,
      pubkey: event.pubkey,
      action: data.action,
      name: data.name || 'Guest',
      map: 'P2P room',
      mode: 'p2p',
      players: null,
      maxPlayers: null,
      room,
      ts: data.ts || 0,
    }
  }
  return null
}

// P2P presence is per-PARTICIPANT (one event per peer in a room), not per-room -- collapse to one
// row per room id, tracking a live participant count and the earliest-seen name as the display label.
function collapseP2P(rows) {
  const byRoom = new Map()
  for (const r of rows) {
    if (r.kind !== 'p2p') continue
    const existing = byRoom.get(r.room)
    if (!existing) { byRoom.set(r.room, { ...r, id: 'p2p:' + r.room, players: 1, _members: new Set([r.pubkey]) }); continue }
    if (!existing._members.has(r.pubkey)) { existing._members.add(r.pubkey); existing.players++ }
    if (r.ts > existing.ts) existing.ts = r.ts
  }
  return Array.from(byRoom.values())
}

// namespace: same value the world's presence publisher (server.js/worldDef.presence.namespace) and
// wireweave rooms (createWireweaveBridge's namespace, default 'spoint') use -- must match for
// discovery to find anything, mirroring how a room code / port only matters within one namespace.
export function createServerBrowser({ namespace = 'spoint', relays = null } = {}) {
  ensureStyle()
  let overlay = null
  let pool = null
  let subId = null
  const dedicatedRows = new Map() // dTag -> row
  const p2pParticipants = new Map() // pubkey+dTag -> row
  const pingCache = new Map() // 'host:port' -> {ms, ts}
  let pingTimer = null
  let disposed = false

  async function ensurePool() {
    if (pool) return pool
    const NostrTools = await import('nostr-tools')
    const ww = await import('wireweave')
    pool = ww.createRelayPool({
      relays: relays || undefined,
      verifyEvent: NostrTools.verifyEvent
    })
    pool.connect()
    subId = pool.subscribe('server-browser-' + namespace,
      [{ kinds: [30078], '#ns': [namespace], since: Math.floor((Date.now() - PRESENCE_EXPIRY_MS) / 1000) }],
      (event) => onEvent(event))
    return pool
  }

  function onEvent(event) {
    const row = parseEvent(event)
    if (!row) return
    if (row.kind === 'dedicated') {
      const dTag = event.tags.find(t => t[0] === 'd')[1]
      if (row.action === 'offline') { dedicatedRows.delete(dTag); render(); return }
      const existing = dedicatedRows.get(dTag)
      if (!existing || row.ts >= existing.ts) dedicatedRows.set(dTag, row)
    } else {
      const key = row.pubkey + ':' + row.room
      if (row.action === 'leave') { p2pParticipants.delete(key); render(); return }
      p2pParticipants.set(key, row)
    }
    render()
  }

  function liveRows() {
    const now = Date.now()
    const dedicated = Array.from(dedicatedRows.values()).filter(r => now - r.ts < PRESENCE_EXPIRY_MS)
    const p2p = collapseP2P(Array.from(p2pParticipants.values()).filter(r => now - r.ts < PRESENCE_EXPIRY_MS))
    return [...dedicated, ...p2p].sort((a, b) => b.ts - a.ts)
  }

  function schedulePing(rows) {
    for (const r of rows) {
      if (r.kind !== 'dedicated') continue
      const key = r.host + ':' + r.port
      const cached = pingCache.get(key)
      if (cached && Date.now() - cached.ts < PING_REFRESH_MS) continue
      pingCache.set(key, { ms: cached?.ms ?? null, ts: Date.now(), pending: true })
      const proto = r.port === 443 ? 'wss:' : 'ws:'
      pingWs(`${proto}//${r.host}:${r.port}/ws`).then(ms => {
        pingCache.set(key, { ms, ts: Date.now(), pending: false })
        if (!disposed) render()
      })
    }
  }

  function joinRow(r) {
    if (r.kind === 'dedicated') {
      const u = new URL(location.pathname, location.href)
      u.search = `?connect=${encodeURIComponent(r.host + ':' + r.port)}`
      location.href = u.href
    } else {
      const u = new URL(location.pathname, location.href)
      u.search = `?wwjoin&room=${encodeURIComponent(r.room)}&fresh`
      location.href = u.href
    }
  }

  function rowVNode(r) {
    const isDedicated = r.kind === 'dedicated'
    const pingInfo = isDedicated ? pingCache.get(r.host + ':' + r.port) : null
    const relayPingMs = !isDedicated && pool ? (pool.status().find(s => s.latencyMs != null)?.latencyMs ?? null) : null
    const pingMs = isDedicated ? pingInfo?.ms : relayPingMs
    const pingLabel = isDedicated
      ? (pingInfo?.pending && pingMs == null ? '...' : (pingMs == null ? 'timeout' : pingMs + 'ms'))
      : (pingMs == null ? 'relay ?' : 'relay ' + pingMs + 'ms')
    return h('div', { class: 'sb-row', onClick: () => joinRow(r) },
      h('span', { class: 'sb-badge' + (isDedicated ? ' sb-dedicated' : '') }, isDedicated ? 'SERVER' : 'P2P'),
      h('span', { class: 'sb-name' }, r.name),
      h('span', { class: 'sb-map' }, r.map),
      h('span', { class: 'sb-players' }, r.players == null ? '?' : (r.maxPlayers ? `${r.players}/${r.maxPlayers}` : String(r.players))),
      h('span', { class: 'sb-ping ' + pingClass(pingMs) }, pingLabel)
    )
  }

  function render() {
    if (!overlay) return
    const rows = liveRows()
    schedulePing(rows)
    const card = overlay.querySelector('.sb-card')
    applyDiff(card, [
      h('div', { class: 'sb-h' }, 'Server Browser'),
      h('div', { class: 'sb-sub' }, `${rows.length} live · namespace "${namespace}" · updates in real time`),
      h('div', { class: 'sb-list' },
        rows.length
          ? rows.map(rowVNode)
          : h('div', { class: 'sb-empty' }, 'No servers found yet. Rooms/servers appear here as their presence heartbeat is received (up to a few seconds).')
      ),
      h('div', { class: 'sb-actions' },
        C.Btn({ ghost: true, onClick: () => close(), children: ['Close'] })
      )
    ])
  }

  async function open() {
    if (overlay) return
    overlay = document.createElement('div')
    overlay.className = 'sb-overlay'
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
    const card = document.createElement('div')
    card.className = 'panel ds-247420 sb-card'
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    render()
    await ensurePool()
    render()
    if (!pingTimer) pingTimer = setInterval(() => { if (overlay) render() }, PING_REFRESH_MS)
  }

  function close() {
    if (!overlay) return
    overlay.remove()
    overlay = null
  }

  function dispose() {
    disposed = true
    close()
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    if (pool && subId) { try { pool.unsubscribe(subId) } catch (_) {} }
    if (pool) { try { pool.disconnect() } catch (_) {} }
    pool = null
  }

  return { open, close, dispose, get isOpen() { return !!overlay }, _liveRows: liveRows }
}
