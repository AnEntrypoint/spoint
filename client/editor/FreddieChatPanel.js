/**
 * FreddieChatPanel.js -- Freddie chat panel for the spoint editor.
 *
 * Flagship demo first slice: wire the freddie chat UI into the spoint editor
 * window layout. Uses the FreddieBridge.js message protocol format for chat
 * messages and agent visualization commands.
 *
 * This panel provides:
 *  - Chat message input/output (text-based chat)
 *  - FreddieBridge message composition (viz.place, viz.update, etc.)
 *  - Integration with the editor's window manager
 *
 * Dual-import safe (browser-only, no Node path).
 */

import {
  KIND_PLACE, KIND_UPDATE, KIND_REMOVE, KIND_CLEAR, KIND_DATASET, KIND_CAMERA,
  ALL_KINDS, validateMessage, computeLayout
} from '/src/sdk/FreddieBridge.js'

/**
 * Create a Freddie chat panel. Returns { host, sendMessage, addMessage, clear }.
 *
 * @param {Object} opts
 * @param {string} [opts.agentId] - freddie agent ID (default 'freddie-editor')
 * @param {Function} [opts.onSendMessage] - called with the freddie bridge message envelope
 * @param {Function} [opts.onReceiveMessage] - called when a message is received from external source
 * @returns {{ host: HTMLElement, sendMessage: Function, addMessage: Function, clear: Function, sendVizCommand: Function }}
 */
export function createFreddieChatPanel(opts = {}) {
  const {
    agentId = 'freddie-editor',
    onSendMessage,
    onReceiveMessage
  } = opts

  let _messageCount = 0
  const _messages = []

  const host = document.createElement('div')
  host.style.cssText = 'display:flex;flex-direction:column;height:100%;font:12px var(--ff-mono,monospace);color:var(--panel-text,var(--fg))'

  // --- Header ---
  const header = document.createElement('div')
  header.style.cssText = 'padding:8px 12px;background:var(--panel-2,var(--bg-2));border-bottom:1px solid var(--panel-3,var(--bg-3));font-weight:600;display:flex;align-items:center;gap:8px'
  const headerDot = document.createElement('span')
  headerDot.textContent = '●'
  headerDot.style.cssText = 'color:#4caf50;font-size:10px'
  const headerTitle = document.createElement('span')
  headerTitle.textContent = `Freddie Chat (${agentId})`
  header.append(headerDot, headerTitle)

  // --- Messages area ---
  const messagesEl = document.createElement('div')
  messagesEl.style.cssText = 'flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px'

  // --- Input area ---
  const inputArea = document.createElement('div')
  inputArea.style.cssText = 'padding:8px;border-top:1px solid var(--panel-3,var(--bg-3));display:flex;gap:6px'

  const inputEl = document.createElement('input')
  inputEl.type = 'text'
  inputEl.placeholder = 'Type a message or /command...'
  inputEl.style.cssText = 'flex:1;padding:6px 8px;font:12px monospace;background:var(--panel-0,var(--bg));color:var(--panel-text,var(--fg));border:1px solid var(--panel-3,var(--bg-3));border-radius:4px'

  const sendBtn = document.createElement('button')
  sendBtn.textContent = 'Send'
  sendBtn.style.cssText = 'padding:6px 12px;font:12px monospace;cursor:pointer;background:var(--accent,var(--fg));color:var(--bg);border:none;border-radius:4px'

  const vizBtn = document.createElement('button')
  vizBtn.textContent = 'Viz'
  vizBtn.title = 'Send a visualization command (viz.place, viz.update, etc.)'
  vizBtn.style.cssText = 'padding:6px 8px;font:11px monospace;cursor:pointer;background:var(--panel-3,var(--bg-3));color:var(--panel-text-2,var(--fg-2));border:1px solid var(--panel-3,var(--bg-3));border-radius:4px'

  inputArea.append(inputEl, sendBtn, vizBtn)

  host.append(header, messagesEl, inputArea)

  // --- Helpers ---
  function _scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function _renderMessage(msg) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:4px 8px;border-radius:4px'

    const meta = document.createElement('div')
    meta.style.cssText = 'display:flex;gap:8px;font:10px monospace;color:var(--panel-text-3,var(--fg-3))'

    const sender = document.createElement('span')
    sender.textContent = msg.sender || 'freddie'
    sender.style.cssText = 'font-weight:600;color:var(--accent,var(--fg))'

    const time = document.createElement('span')
    time.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString()

    const kind = document.createElement('span')
    kind.textContent = msg.kind || 'chat'
    kind.style.cssText = 'opacity:0.6'

    meta.append(sender, time, kind)

    const body = document.createElement('div')
    body.style.cssText = 'font:11px monospace;white-space:pre-wrap;word-break:break-word'

    if (msg.kind && msg.kind !== 'chat') {
      // Viz command: show the payload
      body.textContent = JSON.stringify(msg.payload || msg, null, 2)
      row.style.background = 'var(--panel-2,var(--bg-2))'
    } else {
      body.textContent = msg.text || msg.payload?.text || JSON.stringify(msg)
    }

    row.append(meta, body)
    messagesEl.appendChild(row)
    _scrollToBottom()
  }

  function addMessage(msg) {
    _messages.push(msg)
    _renderMessage(msg)
    _messageCount++
    onReceiveMessage?.(msg)
  }

  function sendMessage(text) {
    if (!text || !text.trim()) return
    const trimmed = text.trim()

    // Check if it's a viz command
    if (trimmed.startsWith('/')) {
      _handleCommand(trimmed)
      return
    }

    const msg = {
      id: _generateId(),
      ts: Date.now(),
      source: `freddie:${agentId}`,
      kind: 'chat',
      payload: { text: trimmed },
      sender: 'user'
    }
    addMessage(msg)
    onSendMessage?.(msg)
    inputEl.value = ''
  }

  function sendVizCommand(kind, payload) {
    const msg = {
      id: _generateId(),
      ts: Date.now(),
      source: `freddie:${agentId}`,
      kind,
      payload,
      sender: 'user'
    }
    addMessage(msg)
    onSendMessage?.(msg)
  }

  function _handleCommand(text) {
    const parts = text.slice(1).split(/\s+/)
    const cmd = parts[0].toLowerCase()

    switch (cmd) {
      case 'place': {
        // /place box 0 0 0 0xff0000
        const primitive = parts[1] || 'box'
        const x = parseFloat(parts[2]) || 0
        const y = parseFloat(parts[3]) || 0
        const z = parseFloat(parts[4]) || 0
        const color = parseInt(parts[5]) || 0xffffff
        sendVizCommand(KIND_PLACE, {
          entityId: _generateId(),
          primitive,
          position: [x, y, z],
          scale: [1, 1, 1],
          color,
          label: `${primitive}@${x},${y},${z}`
        })
        inputEl.value = ''
        return
      }
      case 'clear': {
        sendVizCommand(KIND_CLEAR, {})
        inputEl.value = ''
        return
      }
      case 'camera': {
        const x = parseFloat(parts[1]) || 0
        const y = parseFloat(parts[2]) || 5
        const z = parseFloat(parts[3]) || 10
        sendVizCommand(KIND_CAMERA, {
          position: [x, y, z],
          target: [0, 0, 0],
          transition: 1
        })
        inputEl.value = ''
        return
      }
      case 'help': {
        const helpMsg = {
          id: _generateId(),
          ts: Date.now(),
          source: `freddie:${agentId}`,
          kind: 'chat',
          payload: {
            text: 'Commands:\n' +
              '  /place <primitive> <x> <y> <z> [color] - place a primitive\n' +
              '  /clear - remove all viz entities\n' +
              '  /camera <x> <y> <z> - move camera\n' +
              '  /help - show this help'
          },
          sender: 'system'
        }
        addMessage(helpMsg)
        inputEl.value = ''
        return
      }
      default: {
        // Unknown command, send as text
        const msg = {
          id: _generateId(),
          ts: Date.now(),
          source: `freddie:${agentId}`,
          kind: 'chat',
          payload: { text: trimmed },
          sender: 'user'
        }
        addMessage(msg)
        onSendMessage?.(msg)
        inputEl.value = ''
        return
      }
    }
  }

  function _showVizMenu(anchorEl) {
    // Simple viz command picker
    const menu = document.createElement('div')
    menu.style.cssText = 'position:absolute;background:var(--panel-0,var(--bg));border:1px solid var(--panel-3,var(--bg-3));border-radius:6px;padding:4px;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.3)'
    const rect = anchorEl.getBoundingClientRect()
    menu.style.left = rect.left + 'px'
    menu.style.top = (rect.top - 200) + 'px'

    const commands = [
      { label: 'Place Box', cmd: '/place box 0 0 0 0xff4444' },
      { label: 'Place Sphere', cmd: '/place sphere 0 1 0 0x4444ff' },
      { label: 'Place Capsule', cmd: '/place capsule 0 2 0 0x44ff44' },
      { label: 'Clear All', cmd: '/clear' },
      { label: 'Camera Reset', cmd: '/camera 0 5 10' }
    ]

    for (const item of commands) {
      const row = document.createElement('div')
      row.textContent = item.label
      row.style.cssText = 'padding:6px 12px;cursor:pointer;font:11px monospace;color:var(--panel-text,var(--fg));border-radius:4px'
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--panel-2,var(--bg-2))' })
      row.addEventListener('mouseleave', () => { row.style.background = '' })
      row.addEventListener('click', () => {
        inputEl.value = item.cmd
        inputEl.focus()
        menu.remove()
      })
      menu.appendChild(row)
    }

    document.body.appendChild(menu)
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== vizBtn) {
        menu.remove()
        document.removeEventListener('click', close)
      }
    }
    setTimeout(() => document.addEventListener('click', close), 0)
  }

  function clear() {
    _messages.length = 0
    _messageCount = 0
    messagesEl.innerHTML = ''
  }

  // --- Event listeners ---
  sendBtn.addEventListener('click', () => sendMessage(inputEl.value))
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(inputEl.value)
    }
  })
  vizBtn.addEventListener('click', (e) => {
    e.preventDefault()
    _showVizMenu(vizBtn)
  })

  return {
    host,
    sendMessage,
    addMessage,
    clear,
    sendVizCommand,
    get messages() { return _messages }
  }
}

let _idCounter = 0
function _generateId() {
  _idCounter++
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${ts}-${rand}-${_idCounter}`
}