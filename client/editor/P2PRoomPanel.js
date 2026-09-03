/**
 * P2PRoomPanel.js -- Wireweave P2P room management panel for the spoint editor.
 *
 * Flagship demo first slice: "Host P2P Room" button creates a wireweave room,
 * displays the room ID, and generates a shareable join link. "Join Room" button
 * lets a friend paste a room ID and join.
 *
 * Uses the existing WireweaveBridge.js + WireweaveJoinClient.js infrastructure.
 * Dual-import safe (browser-only, no Node path).
 */

import { createWireweaveBridge } from '../WireweaveBridge.js'

/**
 * Create a P2P room panel. Returns { host, onHost, onJoin, onDestroy, setRoomId }.
 *
 * @param {Object} opts
 * @param {string} [opts.namespace] - wireweave namespace (default 'spoint')
 * @param {string} [opts.room] - room ID to join (if joining)
 * @param {string} [opts.displayName] - display name (default 'editor-host')
 * @param {Function} [opts.onRoomCreated] - called with { roomId, pubkey, joinUrl } when room is created
 * @param {Function} [opts.onPeerJoined] - called with { pubkey } when a peer connects
 * @param {Function} [opts.onPeerLeft] - called with { pubkey } when a peer disconnects
 * @param {Function} [opts.onError] - called with Error
 * @returns {{ host: HTMLElement, hostRoom: Function, joinRoom: Function, destroy: Function, getRoomState: Function }}
 */
export function createP2PRoomPanel(opts = {}) {
  const {
    namespace = 'spoint',
    room: initialRoom,
    displayName = 'editor-host',
    onRoomCreated,
    onPeerJoined,
    onPeerLeft,
    onError
  } = opts

  let _bridge = null
  let _roomId = initialRoom || null
  let _pubkey = null
  let _peerCount = 0
  let _status = 'idle' // 'idle' | 'connecting' | 'hosting' | 'joining' | 'joined' | 'error'

  const host = document.createElement('div')
  host.style.cssText = 'display:flex;flex-direction:column;height:100%;font:12px var(--ff-mono,monospace);color:var(--panel-text,var(--fg))'

  // --- DOM elements ---
  const statusEl = document.createElement('div')
  statusEl.style.cssText = 'padding:10px 12px;background:var(--panel-2,var(--bg-2));border-bottom:1px solid var(--panel-3,var(--bg-3));font-weight:600'

  const bodyEl = document.createElement('div')
  bodyEl.style.cssText = 'flex:1;display:flex;flex-direction:column;padding:12px;gap:10px;overflow-y:auto'

  const roomInfoEl = document.createElement('div')
  roomInfoEl.style.cssText = 'display:none;flex-direction:column;gap:6px;padding:8px;background:var(--panel-2,var(--bg-2));border-radius:6px'

  const roomIdRow = document.createElement('div')
  roomIdRow.style.cssText = 'display:flex;align-items:center;gap:8px'
  const roomIdLabel = document.createElement('span')
  roomIdLabel.textContent = 'Room:'
  roomIdLabel.style.cssText = 'color:var(--panel-text-2,var(--fg-2))'
  const roomIdValue = document.createElement('code')
  roomIdValue.style.cssText = 'font:11px monospace;word-break:break-all'
  const copyBtn = document.createElement('button')
  copyBtn.textContent = 'Copy link'
  copyBtn.style.cssText = 'flex-shrink:0;padding:2px 8px;font:11px monospace;cursor:pointer;background:var(--panel-3,var(--bg-3));color:var(--panel-text,var(--fg));border:1px solid var(--panel-3,var(--bg-3));border-radius:4px'
  roomIdRow.append(roomIdLabel, roomIdValue, copyBtn)

  const joinUrlRow = document.createElement('div')
  joinUrlRow.style.cssText = 'display:flex;align-items:center;gap:8px'
  const joinUrlLabel = document.createElement('span')
  joinUrlLabel.textContent = 'Join URL:'
  joinUrlLabel.style.cssText = 'color:var(--panel-text-2,var(--fg-2))'
  const joinUrlValue = document.createElement('code')
  joinUrlValue.style.cssText = 'font:10px monospace;word-break:break-all;flex:1'
  roomInfoEl.append(roomIdRow, joinUrlRow)

  const peersEl = document.createElement('div')
  peersEl.style.cssText = 'display:none;flex-direction:column;gap:4px'
  const peersHeader = document.createElement('div')
  peersHeader.textContent = 'Connected peers:'
  peersHeader.style.cssText = 'color:var(--panel-text-2,var(--fg-2));margin-bottom:4px'
  const peersList = document.createElement('div')
  peersList.style.cssText = 'display:flex;flex-direction:column;gap:2px'
  peersEl.append(peersHeader, peersList)

  const actionsEl = document.createElement('div')
  actionsEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px'

  // --- Host section ---
  const hostSection = document.createElement('div')
  hostSection.style.cssText = 'display:flex;flex-direction:column;gap:6px'
  const hostLabel = document.createElement('div')
  hostLabel.textContent = 'Host a new P2P room:'
  hostLabel.style.cssText = 'font-weight:600;margin-bottom:2px'
  const hostBtn = document.createElement('button')
  hostBtn.textContent = '🚀 Host P2P Room'
  hostBtn.style.cssText = 'padding:8px 16px;font:13px var(--ff-mono,monospace);cursor:pointer;background:var(--accent,var(--fg));color:var(--bg);border:none;border-radius:6px;width:100%'

  hostSection.append(hostLabel, hostBtn)

  // --- Join section ---
  const joinSection = document.createElement('div')
  joinSection.style.cssText = 'display:flex;flex-direction:column;gap:6px'
  const joinLabel = document.createElement('div')
  joinLabel.textContent = 'Join an existing room:'
  joinLabel.style.cssText = 'font-weight:600;margin-bottom:2px'
  const joinInputRow = document.createElement('div')
  joinInputRow.style.cssText = 'display:flex;gap:6px'
  const joinInput = document.createElement('input')
  joinInput.type = 'text'
  joinInput.placeholder = 'Paste room ID or URL...'
  joinInput.style.cssText = 'flex:1;padding:6px 8px;font:12px monospace;background:var(--panel-0,var(--bg));color:var(--panel-text,var(--fg));border:1px solid var(--panel-3,var(--bg-3));border-radius:4px'
  const joinBtn = document.createElement('button')
  joinBtn.textContent = 'Join'
  joinBtn.style.cssText = 'padding:6px 12px;font:12px monospace;cursor:pointer;background:var(--panel-3,var(--bg-3));color:var(--panel-text,var(--fg));border:1px solid var(--panel-3,var(--bg-3));border-radius:4px'
  joinInputRow.append(joinInput, joinBtn)
  joinSection.append(joinLabel, joinInputRow)

  // --- Disconnect button ---
  const disconnectBtn = document.createElement('button')
  disconnectBtn.textContent = 'Disconnect'
  disconnectBtn.style.cssText = 'display:none;padding:6px 12px;font:12px monospace;cursor:pointer;background:var(--panel-3,var(--bg-3));color:var(--fg-2);border:1px solid var(--panel-3,var(--bg-3));border-radius:4px;margin-top:8px'

  actionsEl.append(hostSection, joinSection, disconnectBtn)
  bodyEl.append(roomInfoEl, peersEl, actionsEl)
  host.append(statusEl, bodyEl)

  // --- Helpers ---
  function _setStatus(text) {
    statusEl.textContent = text
  }

  function _showRoomInfo() {
    roomInfoEl.style.display = 'flex'
    roomIdValue.textContent = _roomId || ''
    const joinUrl = _buildJoinUrl()
    joinUrlValue.textContent = joinUrl
    if (_bridge) {
      _peerCount = _bridge.data?.peers?.size || 0
      _updatePeersList()
    }
  }

  function _hideRoomInfo() {
    roomInfoEl.style.display = 'none'
    peersEl.style.display = 'none'
  }

  function _updatePeersList() {
    peersList.innerHTML = ''
    if (!_bridge?.data?.peers) return
    const peers = _bridge.data.peers
    if (peers.size === 0) {
      const empty = document.createElement('div')
      empty.textContent = '(no peers connected yet)'
      empty.style.cssText = 'color:var(--panel-text-3,var(--fg-3))'
      peersList.appendChild(empty)
      peersEl.style.display = 'flex'
      return
    }
    peersEl.style.display = 'flex'
    for (const [pk, peer] of peers) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font:10px monospace'
      const dot = document.createElement('span')
      const connected = peer?.dc?.readyState === 'open'
      dot.textContent = connected ? '●' : '○'
      dot.style.cssText = `color:${connected ? '#4caf50' : '#888'}`
      const pkShort = pk.slice(0, 12) + '...'
      row.append(dot, document.createTextNode(pkShort))
      peersList.appendChild(row)
    }
  }

  function _buildJoinUrl() {
    if (!_roomId) return ''
    const base = location.origin + location.pathname
    const sep = base.includes('?') ? '&' : '?'
    return `${base}${sep}room=${encodeURIComponent(_roomId)}`
  }

  function _parseRoomId(input) {
    // Accept either a raw room ID or a URL containing ?room= or &room=
    const trimmed = input.trim()
    if (!trimmed) return null
    try {
      const url = new URL(trimmed)
      const room = url.searchParams.get('room')
      if (room) return room
    } catch (_) {}
    // Treat as raw room ID
    if (trimmed.length >= 3 && trimmed.length <= 128) return trimmed
    return null
  }

  async function hostRoom() {
    if (_status === 'connecting' || _status === 'hosting') return
    _status = 'connecting'
    _setStatus('Creating P2P room...')
    hostBtn.disabled = true
    joinBtn.disabled = true

    try {
      // Generate a human-readable room ID
      _roomId = _roomId || _generateRoomId()

      _bridge = await createWireweaveBridge({
        namespace,
        room: _roomId,
        displayName,
        freshKey: true
      })
      await _bridge.connect()
      _pubkey = _bridge.pubkey
      _bridge.roomId = _roomId

      // Expose on window for debugging
      if (typeof window !== 'undefined') {
        window.__app = window.__app || {}
        window.__app.wireweave = _bridge
      }

      _wirePeerEvents()
      _status = 'hosting'
      _setStatus(`Hosting room: ${_roomId}`)
      _showRoomInfo()
      hostSection.style.display = 'none'
      joinSection.style.display = 'none'
      disconnectBtn.style.display = 'block'

      onRoomCreated?.({ roomId: _roomId, pubkey: _pubkey, joinUrl: _buildJoinUrl() })
    } catch (e) {
      _status = 'error'
      _setStatus('Error: ' + e.message)
      hostBtn.disabled = false
      joinBtn.disabled = false
      onError?.(e)
    }
  }

  async function joinRoom(roomInput) {
    const roomId = _parseRoomId(roomInput)
    if (!roomId) {
      _setStatus('Invalid room ID or URL')
      return
    }
    if (_status === 'connecting' || _status === 'joining') return
    _status = 'joining'
    _setStatus(`Joining room: ${roomId}...`)
    hostBtn.disabled = true
    joinBtn.disabled = true

    try {
      _roomId = roomId
      _bridge = await createWireweaveBridge({
        namespace,
        room: roomId,
        displayName,
        freshKey: false
      })
      await _bridge.connect()
      _pubkey = _bridge.pubkey
      _bridge.roomId = roomId

      if (typeof window !== 'undefined') {
        window.__app = window.__app || {}
        window.__app.wireweave = _bridge
      }

      _wirePeerEvents()
      _status = 'joined'
      _setStatus(`Joined room: ${roomId}`)
      _showRoomInfo()
      hostSection.style.display = 'none'
      joinSection.style.display = 'none'
      disconnectBtn.style.display = 'block'

      onRoomCreated?.({ roomId, pubkey: _pubkey, joinUrl: _buildJoinUrl() })
    } catch (e) {
      _status = 'error'
      _setStatus('Error: ' + e.message)
      hostBtn.disabled = false
      joinBtn.disabled = false
      onError?.(e)
    }
  }

  function _wirePeerEvents() {
    if (!_bridge?.data) return
    _bridge.data.addEventListener('peer-open', ({ detail }) => {
      _updatePeersList()
      onPeerJoined?.({ pubkey: detail.peerPubkey })
      _setStatus(`Room: ${_roomId} (${_bridge.data?.peers?.size || 0} peers)`)
    })
    _bridge.data.addEventListener('peer-close', ({ detail }) => {
      _updatePeersList()
      onPeerLeft?.({ pubkey: detail.peerPubkey })
      _setStatus(`Room: ${_roomId} (${_bridge.data?.peers?.size || 0} peers)`)
    })
    _bridge.data.addEventListener('peer-closed', ({ detail }) => {
      _updatePeersList()
      onPeerLeft?.({ pubkey: detail.peerPubkey })
      _setStatus(`Room: ${_roomId} (${_bridge.data?.peers?.size || 0} peers)`)
    })
  }

  async function destroy() {
    if (_bridge) {
      try { await _bridge.destroy() } catch (_) {}
      _bridge = null
    }
    _status = 'idle'
    _roomId = null
    _pubkey = null
    _peerCount = 0
    _setStatus('Disconnected')
    _hideRoomInfo()
    hostSection.style.display = 'flex'
    joinSection.style.display = 'flex'
    disconnectBtn.style.display = 'none'
    hostBtn.disabled = false
    joinBtn.disabled = false
  }

  function getRoomState() {
    return {
      roomId: _roomId,
      pubkey: _pubkey,
      status: _status,
      peerCount: _bridge?.data?.peers?.size || 0,
      joinUrl: _buildJoinUrl()
    }
  }

  // --- Event listeners ---
  hostBtn.addEventListener('click', hostRoom)
  joinBtn.addEventListener('click', () => joinRoom(joinInput.value))
  joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(joinInput.value) })
  disconnectBtn.addEventListener('click', destroy)
  copyBtn.addEventListener('click', () => {
    const url = _buildJoinUrl()
    if (!url) return
    navigator.clipboard.writeText(url).then(() => {
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy link' }, 2000)
    }).catch(() => {
      // Fallback: select and copy
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy link' }, 2000)
    })
  })

  // If initialRoom was provided, auto-join
  if (initialRoom) {
    // Defer to next tick so the DOM is attached
    setTimeout(() => joinRoom(initialRoom), 100)
  }

  return {
    host,
    hostRoom,
    joinRoom,
    destroy,
    getRoomState,
    get bridge() { return _bridge },
    get roomId() { return _roomId }
  }
}

/**
 * Generate a human-readable room ID: two words + 4 digits.
 * Deterministic from timestamp so two hosts generating at the same ms get the same ID
 * (they'd be in the same room), but different enough to avoid collisions.
 */
function _generateRoomId() {
  const words = [
    'blue', 'red', 'gold', 'cyber', 'neo', 'pixel', 'quantum', 'hyper',
    'swift', 'brave', 'wild', 'calm', 'dark', 'lunar', 'solar', 'cosmic',
    'zen', 'flux', 'nova', 'apex', 'prime', 'void', 'echo', 'spark'
  ]
  const now = Date.now()
  const w1 = words[now % words.length]
  const w2 = words[Math.floor(now / 1000) % words.length]
  const digits = String(now % 10000).padStart(4, '0')
  return `${w1}-${w2}-${digits}`
}