// Room-wide voice chat HUD widget. Wraps wireweave's VoiceSession (mesh/SFU
// with automatic hub election + speaker-activity detection, see
// node_modules/wireweave/src/voice.js) and reuses the SAME auth+relayPool
// the room's data/text bridge already established (window.__app.wireweave,
// created host-side in client/app.js and join-side in WireweaveJoinClient.js
// — both now expose it identically, see client/WireweaveBridge.js).
//
// Floor: one shared room-wide channel, join/leave + mute toggle, a green dot
// per actively-speaking participant driven by VoiceSession's own
// 'speaker'/'participants' events (RMS + hysteresis, no re-implementation
// here), PLUS actual remote-audio playback (createVoiceSession is called
// WITHOUT onAudioTrack by the caller here -- without it, ontrack fires but
// nothing ever plays the stream) routed through a per-peer GainNode so gain
// is programmatically controllable.
//
// Proximity attenuation: VoiceSession itself has no notion of world position
// (its peer key is a nostr pubkey, unrelated to the game's own sequential
// player.id used by pm.playerMeshes) -- getEngineCtx() bridges the two. Each
// peer announces its own pubkey once connected via a client->server
// APP_EVENT{type:'voice_identity',pubkey} (see src/sdk/ServerHandlers.js),
// broadcast back as {type:'voice_identity',playerId,pubkey} to every client
// including late joiners (resent on connect). client/app.js's onAppEvent
// handler forwards that type (and 'scoreboard', for team channels below)
// straight into this module's onVoiceIdentity/onScoreboard methods via
// window.__app.voiceIndicator, the same registry app.js already uses for
// window.__app.wireweave/chatHUD.
//
// Team channels: apps/_lib/teams.js's defineTeams broadcasts a 'scoreboard'
// APP_EVENT ({scores:[{id,label,color,score,members}]}) whenever an app
// calls it -- purely optional, no world in this codebase calls it yet. When
// present, this module derives the LOCAL player's team from `members` and
// mutes (gain 0) any peer not on the same team while team-channel mode is
// on; when absent (no scoreboard message ever arrives), team mode is simply
// unavailable (toggle hidden) rather than fabricating a team system.
import { components as C, h, applyDiff } from 'anentrypoint-design'

// Proximity falloff: full volume within NEAR_M, linearly attenuated to 0 at
// FAR_M. Plain values (not inverse-square) so a designer can eyeball/tune
// them against real gameplay distances without a curve-fitting exercise.
const PROXIMITY_NEAR_M = 6
const PROXIMITY_FAR_M = 45
const PROXIMITY_TICK_MS = 100 // 10 Hz is plenty for a gain ramp; every-render-frame would be wasted work

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

// channel name is room-scoped so every participant in the same wireweave room
// (host + all joiners share one room id, see client/app.js's _wwRoom) lands
// in the same voice channel without any extra signaling of their own.
const VOICE_CHANNEL = 'room-voice'

// engineCtx and MSG are optional (a caller that doesn't pass them still gets the
// pre-existing join/mute/speaker-dot UI, minus proximity/team/audio-playback) so
// this stays usable in a context with no game-position data (e.g. a bare voice-only
// embed), but every real spoint call site (client/app.js) passes both.
export function createVoiceIndicator(uiRoot, getBridge, engineCtx = null, MSG = null) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 vi-card'
  uiRoot.appendChild(card)

  let session = null
  let joined = false
  let muted = true
  let destroyed = false

  // pubkey <-> playerId, built from voice_identity APP_EVENTs (see onVoiceIdentity
  // below, called from client/app.js's onAppEvent). Two maps kept in lockstep
  // rather than derived on read, since both directions are looked up every
  // proximity tick (peer pubkey -> playerId to read a mesh position) and every
  // local self-announce (need to know our own playerId's pubkey is already sent).
  const pubkeyToPlayerId = new Map()
  const playerIdToPubkey = new Map()
  // Per-peer Web Audio graph: pubkey -> { gainNode, source, stream }. Built once
  // per connected peer in onAudioTrack, torn down on peer-closed/disconnected.
  const peerAudio = new Map()
  let audioCtx = null
  // Latest scoreboard (apps/_lib/teams.js broadcast), if this world ever calls
  // defineTeams. null = no team system in this world; team-channel toggle stays hidden.
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

  // Local player's team id, or null if no scoreboard has arrived yet (no defineTeams
  // in this world) or the local player isn't on any team's members list yet.
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

  // Wire a remote peer's real MediaStream into an actually-audible graph: a
  // MediaStreamSource -> a per-peer GainNode (the ONLY reachable point to apply
  // proximity/team gain, since VoiceSession's own audioEl path is never used
  // here) -> destination. Without this, ontrack fires but the peer is silent.
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

  // Real per-tick proximity + team gain update: reads LIVE mesh positions
  // (engineCtx.players.getMesh, same accessor client/app.js's own render code
  // uses) for the local player and every connected voice peer whose pubkey has
  // been resolved to a playerId, and sets each peer's GainNode.gain.value from
  // distance (and, when team-channel mode is on, zeroed for a different team).
  // Guarded against every degenerate case: no engineCtx, no local mesh yet, a
  // peer with no known playerId yet (identity broadcast hasn't arrived), a
  // missing remote mesh, and zero connected peers (loop body simply never runs
  // -- no division happens at all in that case, let alone by a zero denominator).
  function updateProximity() {
    if (destroyed || !engineCtx || !peerAudio.size) return
    const lid = engineCtx.playerId
    const localMesh = lid != null ? engineCtx.players.getMesh(lid) : null
    const localTeam = teamChannelOn ? getLocalTeam() : null
    for (const [peerPubkey, a] of peerAudio) {
      const pid = pubkeyToPlayerId.get(peerPubkey)
      let gain = 1
      if (pid == null || !localMesh) {
        // Identity not resolved yet, or our own mesh isn't spawned yet: hold
        // at full volume rather than guessing -- silently muting a real
        // speaker because of a timing gap is worse than a brief non-attenuated period.
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

  // Announce our own pubkey to the server once (see src/sdk/ServerHandlers.js's
  // voice_identity APP_EVENT branch) so every other client can resolve it to
  // our playerId for their own proximity calc. Sent via the same client->server
  // APP_EVENT channel BaseClient.js's sendEmote/sendLaunch already use.
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
      // VoiceSession joins muted by default (push-to-talk gate) -- flip to
      // room-wide always-on so a bare "wire it in" flow is actually audible
      // without a separate PTT keybind; setMuted(false) mirrors toggleMic().
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
    if (!teamChannelOn) updateProximity() // immediately restore full-team-gain peers instead of waiting for the next tick
    render()
  }

  render()

  return {
    node: card,
    get joined() { return joined },
    // Called from client/app.js's onAppEvent for type:'voice_identity' (both a fresh
    // broadcast and the resend-to-late-joiners sweep land here identically).
    onVoiceIdentity(playerId, pubkey) {
      if (playerId == null || !pubkey) return
      pubkeyToPlayerId.set(pubkey, playerId)
      playerIdToPubkey.set(playerId, pubkey)
    },
    // Called from client/app.js's onAppEvent for type:'scoreboard' (apps/_lib/teams.js
    // broadcast). Presence of even one call is what makes the team-channel toggle appear.
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
