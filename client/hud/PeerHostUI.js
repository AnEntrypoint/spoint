// WebRTC host/join card. Uses anentrypoint-design kit primitives (Panel, Row, Btn,
// TextField) via the components export. All theming flows through ds-247420 + kit
// CSS variables — no inline rgba() or hardcoded hex colors.
import { components as C, h, applyDiff } from 'anentrypoint-design'

function ensureStyle() {
  if (document.getElementById('peer-host-ui-style')) return
  const s = document.createElement('style')
  s.id = 'peer-host-ui-style'
  s.textContent = `
    .ph-card{position:fixed;top:max(8px,env(safe-area-inset-top));right:max(8px,env(safe-area-inset-right));z-index:1000;width:min(320px,calc(100vw - 16px));pointer-events:all;display:flex;flex-direction:column;gap:8px;padding:12px}
    .ph-card .ph-h{font-size:13px;font-weight:600;color:var(--panel-text)}
    .ph-card .ph-sub{font-size:11px;color:var(--panel-text-3)}
    .ph-card .ph-acc{font-size:11px;color:var(--accent)}
    .ph-card .ph-area{font:11px/1.4 var(--ff-mono, ui-monospace, monospace);background:var(--panel-0, var(--panel-1));color:var(--panel-text);border:1px solid var(--rule);border-radius:var(--r-1, 4px);padding:6px;resize:vertical;width:100%;box-sizing:border-box}
    .ph-card .ph-toast{position:fixed;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);background:var(--panel-1);border:1px solid var(--rule);color:var(--panel-text);padding:8px 14px;border-radius:var(--r-1,6px);font-size:12px;z-index:1100;pointer-events:none;opacity:0;transition:opacity .2s}
    .ph-card .ph-toast.show{opacity:1}
    @media (prefers-reduced-motion: reduce){
      .ph-card .ph-toast{transition:none}
    }
  `
  document.head.appendChild(s)
}

function showToast(msg) {
  const t = document.createElement('div')
  t.className = 'ds-247420 ph-toast'
  t.textContent = msg
  document.body.appendChild(t)
  requestAnimationFrame(() => t.classList.add('show'))
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250) }, 2400)
}

// Minimal always-visible room-code card for the wireweave host flow (?room=CODE).
// createLobby.js's showHosting() renders the code for one frame before the
// page navigates away to host mode -- this re-shows it persistently once the
// host bridge is actually up, with a copy-link button, so the host can find
// and share it at any point during the session (not just the instant before
// navigation).
export function createRoomCodeUI(uiRoot, code, joinLink) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 ph-card'
  card.style.top = 'max(64px,calc(env(safe-area-inset-top) + 56px))' // sit below PeerHostUI/HUD top row
  uiRoot.appendChild(card)
  const onCopy = (e) => { e.preventDefault(); navigator.clipboard.writeText(joinLink); showToast('Join link copied') }
  applyDiff(card, [
    h('div', { class: 'ph-h' }, 'Room Code'),
    h('div', { class: 'ph-acc', style: 'font-size:20px;letter-spacing:2px;font-weight:700' }, code),
    h('div', { class: 'ph-sub' }, 'Share this code or the join link with others.'),
    C.Btn({ onClick: onCopy, children: ['Copy Join Link'] })
  ])
  return { node: card, destroy() { card.remove() } }
}

// iceServers: optional worldDef-supplied RTCIceServer[] (see worldDef.iceServers,
// threaded from client/app.js's onWorldDef). Falls back to the bare public-STUN
// default below when unset/empty, same as BrowserServer.addPeer's own fallback.
const _DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

export function createPeerHostUI(uiRoot, getClient, iceServers) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 ph-card'
  uiRoot.appendChild(card)
  const _ice = Array.isArray(iceServers) && iceServers.length ? iceServers : _DEFAULT_ICE_SERVERS

  const _b64 = obj => btoa(JSON.stringify(obj))
  const _unb64 = s => { try { return JSON.parse(atob(s)) } catch (_) { return null } }

  const _render = (vnodes) => { applyDiff(card, vnodes) }

  function _renderHost() {
    _render([
      h('div', { class: 'ph-h' }, 'Host Session'),
      h('div', { class: 'ph-sub' }, 'Share offer with joiner, paste their answer back.'),
      C.Btn({ primary: true, onClick: (e) => { e.preventDefault(); _generateOffer() }, children: ['Generate Offer'] })
    ])
  }

  async function _generateOffer() {
    _render([h('div', { class: 'ph-sub' }, 'Generating offer...')])
    const pc = new RTCPeerConnection({ iceServers: _ice })
    pc.createDataChannel('reliable', { ordered: true })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve()
      pc.addEventListener('icegatheringstatechange', function h() {
        if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', h); resolve() }
      })
      setTimeout(resolve, 3000)
    })
    const offerB64 = _b64({ type: pc.localDescription.type, sdp: pc.localDescription.sdp })
    let answerVal = ''
    const onAnswerInput = (e) => { answerVal = e.target.value }
    const onConnect = async (e) => {
      e.preventDefault()
      const answer = _unb64(answerVal.trim())
      if (!answer?.sdp) { showToast('Invalid answer'); return }
      await pc.setRemoteDescription(new RTCSessionDescription(answer))
      _render([h('div', { class: 'ph-acc' }, 'Peer connected!')])
      showToast('Peer connected')
      setTimeout(() => card.remove(), 3000)
    }
    const onCopy = (e) => { e.preventDefault(); navigator.clipboard.writeText(offerB64); showToast('Offer copied') }
    _render([
      h('div', { class: 'ph-h' }, 'Your Offer'),
      h('div', { class: 'ph-sub' }, 'Send this to the joiner:'),
      h('textarea', { class: 'ph-area', rows: 3, readonly: true }, offerB64),
      C.Btn({ onClick: onCopy, children: ['Copy'] }),
      h('div', { class: 'ph-sub' }, "Paste joiner's answer:"),
      h('textarea', { class: 'ph-area', rows: 3, placeholder: 'Paste answer here...', oninput: onAnswerInput }),
      C.Btn({ primary: true, onClick: onConnect, children: ['Connect'] })
    ])
    window.__debug.peerHostPc = pc
  }

  async function _runJoin(offerB64) {
    const offer = _unb64(offerB64)
    if (!offer?.sdp) { _render([h('div', { class: 'ph-acc' }, 'Invalid offer in URL')]); return }
    _render([
      h('div', { class: 'ph-h' }, 'Join Session'),
      h('div', { class: 'ph-sub' }, 'Connecting to host offer...')
    ])
    const client = getClient()
    if (!client?.addPeer) { _render([h('div', { class: 'ph-acc' }, 'Must be in singleplayer+host mode')]); return }
    const result = await client.addPeer(offer, _ice)
    const answerB64 = _b64(result.answer)
    const onCopy = (e) => { e.preventDefault(); navigator.clipboard.writeText(answerB64); showToast('Answer copied') }
    _render([
      h('div', { class: 'ph-h' }, 'Answer Ready'),
      h('div', { class: 'ph-sub' }, 'Send this back to the host:'),
      h('textarea', { class: 'ph-area', rows: 3, readonly: true }, answerB64),
      C.Btn({ onClick: onCopy, children: ['Copy'] })
    ])
    window.__debug.peerJoinAnswer = answerB64
  }

  return {
    show(mode, joinOfferB64) {
      if (mode === 'join' && joinOfferB64) _runJoin(joinOfferB64)
      else _renderHost()
    },
    destroy() { card.remove() }
  }
}
