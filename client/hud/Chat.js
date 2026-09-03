// Room-wide in-game text chat HUD widget. Wraps wireweave's Chat class (see
// node_modules/wireweave/src/chat.js -- kind:42 channel messages + kind:5
// deletes over Nostr relays, rate-limited client-side, profile name resolution).
// Reuses the SAME auth+relayPool the room's voice/data bridge already
// established (window.__app.wireweave, created host-side in client/app.js and
// join-side in WireweaveJoinClient.js -- both expose it identically, see
// client/WireweaveBridge.js), following the same getBridge() convention as
// client/hud/VoiceIndicator.js.
//
// Floor for this row: one shared room-wide channel, send + scrollback history
// + live incoming messages + delete-own-message, driven by the real Chat
// class's send/loadHistory/deleteMessage API and message/messages/rate-limited
// events (no re-implementation of channel/dedup/sort logic here).
import { components as C, h, applyDiff } from 'anentrypoint-design'

function ensureStyle() {
  if (document.getElementById('chat-hud-style')) return
  const s = document.createElement('style')
  s.id = 'chat-hud-style'
  s.textContent = `
    .ch-card{position:fixed;bottom:max(8px,env(safe-area-inset-bottom));left:max(8px,env(safe-area-inset-left));z-index:1000;width:min(320px,calc(100vw - 16px));pointer-events:all;display:flex;flex-direction:column;gap:6px;padding:10px}
    .ch-card .ch-h{font-size:12px;font-weight:600;color:var(--panel-text);display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ch-card .ch-list{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto}
    .ch-card .ch-row{display:flex;gap:6px;font-size:11px;color:var(--panel-text-2, var(--panel-text));align-items:baseline}
    .ch-card .ch-row.mine .ch-name{color:var(--accent)}
    .ch-card .ch-name{font-weight:600;flex-shrink:0}
    .ch-card .ch-body{word-break:break-word;flex:1}
    .ch-card .ch-del{cursor:pointer;opacity:.5;flex-shrink:0;font-size:10px}
    .ch-card .ch-del:hover{opacity:1}
    .ch-card .ch-sub{font-size:10px;color:var(--panel-text-3)}
    .ch-card .ch-form{display:flex;gap:6px}
    .ch-card .ch-input{flex:1;font-size:11px;background:var(--panel-0, var(--panel-1));color:var(--panel-text);border:1px solid var(--rule);border-radius:var(--r-1, 4px);padding:6px;box-sizing:border-box}
  `
  document.head.appendChild(s)
}

// channel name is room-scoped so every participant in the same wireweave room
// (host + all joiners share one room id, see client/app.js's _wwRoom) lands
// in the same text channel without any extra signaling of their own -- mirrors
// VoiceIndicator.js's VOICE_CHANNEL constant.
const TEXT_CHANNEL = 'room-chat'

export function createChatHUD(uiRoot, getBridge) {
  ensureStyle()
  const card = document.createElement('div')
  card.className = 'panel ds-247420 ch-card'
  uiRoot.appendChild(card)

  let chat = null
  let joined = false
  let destroyed = false
  let draft = ''
  let statusMsg = ''

  const render = () => {
    if (destroyed) return
    const messages = chat ? chat.messages : []
    const myPubkey = getBridge()?.pubkey || null
    applyDiff(card, [
      h('div', { class: 'ch-h' }, [
        h('span', {}, 'Chat'),
        !joined ? C.Btn({ primary: true, onClick: onJoin, children: ['Join Chat'] }) : null
      ]),
      joined
        ? h('div', { class: 'ch-list' }, messages.length
            ? messages.map(m => {
                const mine = m.userId === myPubkey
                return h('div', { class: 'ch-row' + (mine ? ' mine' : '') }, [
                  h('span', { class: 'ch-name' }, chat.resolveProfile(m.userId) + ':'),
                  h('span', { class: 'ch-body' }, m.content),
                  mine ? h('span', { class: 'ch-del', title: 'Delete', onClick: (e) => onDelete(e, m.id) }, '✕') : null
                ])
              })
            : [h('div', { class: 'ch-sub' }, 'No messages yet.')])
        : h('div', { class: 'ch-sub' }, 'Join to chat with everyone in this room.'),
      joined
        ? h('form', { class: 'ch-form', onsubmit: onSend }, [
            h('input', { class: 'ch-input', type: 'text', placeholder: 'Message...', value: draft, oninput: (e) => { draft = e.target.value } }),
            C.Btn({ type: 'submit', children: ['Send'] })
          ])
        : null,
      statusMsg ? h('div', { class: 'ch-sub' }, statusMsg) : null
    ])
  }

  async function ensureChat() {
    if (chat) return chat
    const bridge = getBridge()
    if (!bridge) throw new Error('chat: no wireweave bridge for this room yet')
    const ww = await import('wireweave')
    chat = ww.createChat({
      relayPool: bridge.pool,
      auth: bridge.auth,
      getChannelContext: () => ({ channelId: TEXT_CHANNEL, serverId: bridge.roomId || '' })
    })
    chat.addEventListener('messages', render)
    chat.addEventListener('message', render)
    chat.addEventListener('profile', render)
    chat.addEventListener('rate-limited', ({ detail }) => {
      statusMsg = 'Sending too fast, wait ' + Math.ceil((detail.retryAfterMs || 0) / 1000) + 's'
      render()
      setTimeout(() => { statusMsg = ''; render() }, detail.retryAfterMs || 1000)
    })
    return chat
  }

  async function onJoin(e) {
    e?.preventDefault?.()
    try {
      const c = await ensureChat()
      await c.loadHistory(TEXT_CHANNEL)
      joined = true
      render()
    } catch (err) {
      console.warn('[chat] join failed:', err?.message || err)
    }
  }

  async function onSend(e) {
    e?.preventDefault?.()
    if (!chat || !draft.trim()) return
    const toSend = draft
    draft = ''
    render()
    try { await chat.send(toSend) } catch (err) { console.warn('[chat] send failed:', err?.message || err) }
  }

  async function onDelete(e, id) {
    e?.preventDefault?.()
    if (!chat) return
    try { await chat.deleteMessage(id) } catch (err) { console.warn('[chat] delete failed:', err?.message || err) }
  }

  render()

  return {
    node: card,
    get joined() { return joined },
    // Exposes the real wireweave Chat instance once join() has run, so a sibling widget (e.g.
    // hud/ChatQuickWheel.js's pre-canned-message picker) can send through the SAME instance/channel
    // instead of constructing a second Chat against the same room -- see ensureChat()'s TEXT_CHANNEL.
    get chat() { return chat },
    destroy() {
      destroyed = true
      card.remove()
    }
  }
}
