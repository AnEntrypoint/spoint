import { components as C, h, applyDiff } from 'anentrypoint-design'

const PRESENCE_EXPIRY_MS = 90000
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

export function createServerBrowser({ namespace = 'spoint', relays = null } = {}) {
  ensureStyle()
  let overlay = null
  let pool = null
  let subId = null
  const dedicatedRowsByDTag = new Map()
  const p2pRowsByPubkeyRoom = new Map()
  const pingByHostPort = new Map()
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
      if (row.action === 'offline') { dedicatedRowsByDTag.delete(dTag); render(); return }
      const existing = dedicatedRowsByDTag.get(dTag)
      if (!existing || row.ts >= existing.ts) dedicatedRowsByDTag.set(dTag, row)
    } else {
      const key = row.pubkey + ':' + row.room
      if (row.action === 'leave') { p2pRowsByPubkeyRoom.delete(key); render(); return }
      p2pRowsByPubkeyRoom.set(key, row)
    }
    render()
  }

  function liveRows() {
    const now = Date.now()
    const dedicated = Array.from(dedicatedRowsByDTag.values()).filter(r => now - r.ts < PRESENCE_EXPIRY_MS)
    const p2p = collapseP2P(Array.from(p2pRowsByPubkeyRoom.values()).filter(r => now - r.ts < PRESENCE_EXPIRY_MS))
    return [...dedicated, ...p2p].sort((a, b) => b.ts - a.ts)
  }

  function schedulePing(rows) {
    for (const r of rows) {
      if (r.kind !== 'dedicated') continue
      const key = r.host + ':' + r.port
      const cached = pingByHostPort.get(key)
      if (cached && Date.now() - cached.ts < PING_REFRESH_MS) continue
      pingByHostPort.set(key, { ms: cached?.ms ?? null, ts: Date.now(), pending: true })
      const proto = r.port === 443 ? 'wss:' : 'ws:'
      pingWs(`${proto}//${r.host}:${r.port}/ws`).then(ms => {
        pingByHostPort.set(key, { ms, ts: Date.now(), pending: false })
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
    const pingInfo = isDedicated ? pingByHostPort.get(r.host + ':' + r.port) : null
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
