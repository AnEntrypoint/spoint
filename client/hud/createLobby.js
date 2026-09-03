import { renderHostJoinLobby } from 'anentrypoint-design'

// Easy host/join for tps matches. View comes from the anentrypoint-design
// lobby kit (unpkg); this module owns the wireweave room mechanism:
//   Host -> navigate to ?room=CODE&world=<world>  (BrowserServer host + bridge)
//   Join -> navigate to ?wwjoin&room=CODE          (WireweaveJoinClient)
// A room code is the shareable join key. No manual SDP copy-paste.

// URL-safe room code: 5 chars from an unambiguous alphabet (no 0/O/1/I/L).
const _ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function generateRoomCode() {
  const buf = new Uint32Array(5)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < 5; i++) out += _ALPHABET[buf[i] % _ALPHABET.length]
  return out
}

// Accept a bare code or a full join link; return the normalized code or null.
function parseRoomCode(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  // Full URL / query: pull ?room= or &room=.
  const m = s.match(/[?&]room=([^&\s]+)/i)
  const code = (m ? m[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return code.length >= 3 && code.length <= 12 ? code : null
}

export function createLobby({ world = 'tps-game', onClose: onCloseCb = null } = {}) {
  let lobby = null

  function open() {
    if (lobby) return
    lobby = renderHostJoinLobby({
      onHost: () => {
        const code = generateRoomCode()
        const joinLink = `${location.origin}${location.pathname}?wwjoin&room=${code}`
        lobby.showHosting(code, joinLink)
        // Start hosting: BrowserServer + wireweave bridge advertising the room.
        location.href = `${location.pathname}?room=${code}&world=${encodeURIComponent(world)}`
      },
      onJoin: (raw) => {
        const code = parseRoomCode(raw)
        if (!code) { lobby.showError('Invalid room code or link'); return }
        location.href = `${location.pathname}?wwjoin&room=${code}`
      },
      onClose: () => close()
    })
    // Mount on document.body, not uiRoot — the HUD applyDiff cycle replaces
    // uiRoot's children every frame and would wipe the lobby overlay.
    document.body.appendChild(lobby.node)
  }

  function close() {
    if (!lobby) return
    lobby.dispose()
    lobby = null
    try { onCloseCb?.() } catch (_) {}
  }

  return { open, close, get isOpen() { return !!lobby } }
}
