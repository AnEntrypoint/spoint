import { renderHostJoinLobby } from 'anentrypoint-design'

const UNAMBIGUOUS_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 5
function generateRoomCode() {
  const buf = new Uint32Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += UNAMBIGUOUS_ROOM_CODE_ALPHABET[buf[i] % UNAMBIGUOUS_ROOM_CODE_ALPHABET.length]
  return out
}

function parseRoomCode(raw) {
  const s = (raw || '').trim()
  if (!s) return null
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
        location.href = `${location.pathname}?room=${code}&world=${encodeURIComponent(world)}`
      },
      onJoin: (raw) => {
        const code = parseRoomCode(raw)
        if (!code) { lobby.showError('Invalid room code or link'); return }
        location.href = `${location.pathname}?wwjoin&room=${code}`
      },
      onClose: () => close()
    })
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
