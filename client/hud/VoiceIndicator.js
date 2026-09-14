import { components as C, h, applyDiff } from 'anentrypoint-design'

const PROXIMITY_NEAR_M = 6
const PROXIMITY_FAR_M = 45
const PROXIMITY_TICK_MS = 100

function ensureStyle() {
  if (document.getElementById('voice-indicator-style')) return
  const s = document.createElement('style')
  s.id = 'voice-indicator-style'
  s.textContent = `
    .vi-card{position:fixed;bottom:max(8px,env(safe-area-inset-bottom));right:max(8px,env(safe-area-inset-right));z-index:1000;width:min(220px,calc(100vw - 16px));pointer-events:all;display:flex;flex-direction:column;gap:6px;padding:10px}
    .vi-card .vi-h{font-size:12px;font-weight:600;color:var(--panel-text);display:flex;align-items:center;justify-content:space-between;gap:8px}
    .vi-card .vi-list{display:flex;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto}
    .vi-card .vi-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--panel-text-2, var(--panel-text))}
    .vi-card .vi-dot{width:8px;height:8px;border-radius:50%;background:var(--panel-text-3, #666);flex-shrink:0;transition:background-color .12s}
    .vi-card .vi-dot.speaking{background:#3ecf6a;box-shadow:0 0 4px #3ecf6a}
    .vi-card .vi-row.muted .vi-name{opacity:.55}
    .vi-card .vi-mutei{font-size:10px;opacity:.7}
    .vi-card .vi-sub{font-size:10px;color:var(--panel-text-3)}
    @media (prefers-reduced-motion: reduce){ .vi-card .vi-dot{transition:none} }
  `
  document.head.appendChild(s)
}

const VOICE_CHANNEL = 'room-voice'

export function createVoiceIndicator(uiRoot, getBridge, engineCtx = null, MSG = null) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 vi-card'
  uiRoot.appendChild(card)

  let session = null
  let joined = false
  let muted = true
  let destroyed = false

  const pubkeyToPlayerId = new Map()
  const playerIdToPubkey = new Map()
  const peerAudio = new Map()
  let audioCtx = null
  let latestScores = null
  let teamChannelOn = false
  let proximityTimer = null

  const render = () => {
    if (destroyed) return
    const participants = session ? session.getParticipants() : []
    const localTeam = getLocalTeam()
    applyDiff(card, [
      h('div', { class: 'vi-h' }, [
        h('span', {}, 'Voice'),
        joined && localTeam != null
          ? C.Btn({ onClick: onToggleTeamChannel, children: [teamChannelOn ? 'Team only' : 'Everyone'] })
          : null,
        joined
          ? C.Btn({ onClick: onToggleMute, children: [muted ? 'Unmute' : 'Mute'] })
          : C.Btn({ primary: true, onClick: onJoin, children: ['Join Voice'] })
      ]),
      joined
        ? h('div', { class: 'vi-list' }, participants.map(p =>
            h('div', { class: 'vi-row' + (p.isMuted ? ' muted' : '') }, [
              h('span', { class: 'vi-dot' + (p.isSpeaking ? ' speaking' : '') }),
              h('span', { class: 'vi-name' }, p.isLocal ? `${p.identity} (you)` : p.identity),
              p.isMuted ? h('span', { class: 'vi-mutei' }, '🔇') : null
            ])
          ))
        : h('div', { class: 'vi-sub' }, 'Join to talk with everyone in this room.')
    ])
  }

  function getLocalTeam() {
    if (!latestScores || !engineCtx) return null
    const lid = engineCtx.playerId
    if (lid == null) return null
    for (const t of latestScores) if (Array.isArray(t.members) && t.members.includes(lid)) return t.id
    return null
  }

  function ensureAudioCtx() {
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx
    const Ctx = (typeof AudioContext !== 'undefined') ? AudioContext : (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null
    if (!Ctx) return null
    audioCtx = new Ctx()
    return audioCtx
  }

  function onAudioTrack({ peerPubkey, stream }) {
    const ctx = ensureAudioCtx()
    if (!ctx || !stream) return
    if (peerAudio.has(peerPubkey)) return
    try {
      const source = ctx.createMediaStreamSource(stream)
      const gainNode = ctx.createGain()
      gainNode.gain.value = 1
      source.connect(gainNode)
      gainNode.connect(ctx.destination)
      peerAudio.set(peerPubkey, { gainNode, source, stream })
    } catch (err) { console.warn('[voice] onAudioTrack graph failed:', err?.message || err) }
  }

  function teardownPeerAudio(peerPubkey) {
    const a = peerAudio.get(peerPubkey); if (!a) return
    try { a.source.disconnect() } catch (_) {}
    try { a.gainNode.disconnect() } catch (_) {}
    peerAudio.delete(peerPubkey)
  }

  function updateProximity() {
    if (destroyed || !engineCtx || !peerAudio.size) return
    const lid = engineCtx.playerId
    const localMesh = lid != null ? engineCtx.players.getMesh(lid) : null
    const localTeam = teamChannelOn ? getLocalTeam() : null
    for (const [peerPubkey, a] of peerAudio) {
      const pid = pubkeyToPlayerId.get(peerPubkey)
      let gain = 1
      const identityOrLocalMeshPending = pid == null || !localMesh
      if (identityOrLocalMeshPending) {
        gain = 1
      } else {
        const remoteMesh = engineCtx.players.getMesh(pid)
        if (remoteMesh && localMesh) {
          const dx = remoteMesh.position.x - localMesh.position.x
          const dy = remoteMesh.position.y - localMesh.position.y
          const dz = remoteMesh.position.z - localMesh.position.z
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (dist <= PROXIMITY_NEAR_M) gain = 1
          else if (dist >= PROXIMITY_FAR_M) gain = 0
          else gain = 1 - (dist - PROXIMITY_NEAR_M) / (PROXIMITY_FAR_M - PROXIMITY_NEAR_M)
        }
      }
      if (teamChannelOn && localTeam != null && pid != null) {
        const scores = latestScores || []
        const peerTeam = scores.find(t => Array.isArray(t.members) && t.members.includes(pid))?.id
        if (peerTeam !== localTeam) gain = 0
      }
      if (Number.isFinite(gain)) {
        try { a.gainNode.gain.value = gain } catch (_) {}
      }
    }
  }

  function startProximityLoop() {
    stopProximityLoop()
    proximityTimer = setInterval(updateProximity, PROXIMITY_TICK_MS)
  }
  function stopProximityLoop() {
    if (proximityTimer) { clearInterval(proximityTimer); proximityTimer = null }
  }

  async function ensureSession() {
    if (session) return session
    const bridge = getBridge()
    if (!bridge) throw new Error('voice: no wireweave bridge for this room yet')
    const ww = await import('wireweave')
    const xstate = await import('xstate')
    session = ww.createVoiceSession({
      fsm: bridge.fsm,
      xstate,
      relayPool: bridge.pool,
      auth: bridge.auth,
      mediaDevices: navigator.mediaDevices,
      serverId: bridge.roomId || '',
      onAudioTrack
    })
    session.addEventListener('participants', render)
    session.addEventListener('speaker', render)
    session.addEventListener('mic', ({ detail }) => { muted = detail.muted; render() })
    session.addEventListener('error', ({ detail }) => { console.warn('[voice]', detail.message) })
    session.addEventListener('peer-closed', ({ detail }) => teardownPeerAudio(detail.peerPubkey))
    session.addEventListener('disconnected', () => {
      joined = false; muted = true
      stopProximityLoop()
      for (const pk of Array.from(peerAudio.keys())) teardownPeerAudio(pk)
      render()
    })
    return session
  }

  function announceIdentity() {
    if (!engineCtx || !MSG || engineCtx.playerId == null) return
    const bridge = getBridge()
    const pubkey = bridge?.pubkey
    if (!pubkey) return
    playerIdToPubkey.set(engineCtx.playerId, pubkey)
    pubkeyToPlayerId.set(pubkey, engineCtx.playerId)
    try { engineCtx.network.send({ type: 'voice_identity', pubkey }) } catch (err) { console.warn('[voice] announceIdentity failed:', err?.message || err) }
  }

  async function onJoin(e) {
    e?.preventDefault?.()
    try {
      const s = await ensureSession()
      await s.connect(VOICE_CHANNEL, { displayName: getBridge()?.pubkey?.slice(0, 8) || 'Guest' })
      joined = true
      s.setMuted(false)
      muted = false
      announceIdentity()
      startProximityLoop()
      render()
    } catch (err) {
      console.warn('[voice] join failed:', err?.message || err)
    }
  }

  function onToggleMute(e) {
    e?.preventDefault?.()
    if (!session) return
    session.toggleMic()
  }

  function onToggleTeamChannel(e) {
    e?.preventDefault?.()
    teamChannelOn = !teamChannelOn
    if (!teamChannelOn) updateProximity()
    render()
  }

  render()

  return {
    node: card,
    get joined() { return joined },
    onVoiceIdentity(playerId, pubkey) {
      if (playerId == null || !pubkey) return
      pubkeyToPlayerId.set(pubkey, playerId)
      playerIdToPubkey.set(playerId, pubkey)
    },
    onScoreboard(scores) {
      latestScores = Array.isArray(scores) ? scores : null
      render()
    },
    async destroy() {
      destroyed = true
      stopProximityLoop()
      for (const pk of Array.from(peerAudio.keys())) teardownPeerAudio(pk)
      if (audioCtx && audioCtx.state !== 'closed') { try { audioCtx.close() } catch (_) {} }
      try { await session?.disconnect() } catch (_) {}
      card.remove()
    }
  }
}
