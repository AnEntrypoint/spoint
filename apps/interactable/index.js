// Interactable trigger with E-key prompt and configurable color
export default {
  server: {
    editorProps: [
      { key: 'color', label: 'Color', type: 'color', default: '#00ff88' },
      { key: 'prompt', label: 'Prompt', type: 'text', default: 'Press E to interact' },
      { key: 'radius', label: 'Radius', type: 'number', default: 3.5 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { mesh: 'box', color: c.color ?? 0x00ff88, sx: 1.5, sy: 0.5, sz: 1.5, label: 'INTERACT' }
      ctx.state.interactionCount = 0
      ctx.physics.addColliderFromConfig({ type: 'box', size: [0.75, 0.25, 0.75] })
      ctx.interactable({ prompt: c.prompt ?? 'Press E to interact', radius: c.radius ?? 3.5, cooldown: 500 })
    },

    onInteract(ctx, player) {
      ctx.state.interactionCount++
      const messages = [
        'Hello there!',
        'You found the interact button!',
        'Nice to meet you!',
        'This button works!',
        `Interacted ${ctx.state.interactionCount} times total`
      ]
      const msg = messages[ctx.state.interactionCount % messages.length]
      ctx.players.send(player.id, { type: 'interact_response', message: msg, count: ctx.state.interactionCount })
      ctx.network.broadcast({ type: 'interact_effect', position: ctx.entity.position, playerId: player.id })
    }
  },

  client: {
    onEvent(payload) {
      if (payload.type === 'interact_response') { this._lastMessage = payload.message; this._messageExpire = Date.now() + 3000 }
      if (payload.type === 'interact_effect') { this._lastMessage = 'Someone interacted!'; this._messageExpire = Date.now() + 1500 }
    },

    render(ctx) {
      const h = ctx.h
      const pos = ctx.entity.position
      if (!h || !pos) return { position: pos }
      const ui = []
      if (this._lastMessage && Date.now() < this._messageExpire) {
        const opacity = Math.min(1, ((this._messageExpire - Date.now()) / 3000) * 2)
        ui.push(h('div', { style: `position:fixed;top:30%;left:50%;transform:translate(-50%,-50%);padding:16px 32px;background:rgba(0,0,0,0.8);border-radius:12px;color:#0f0;font-weight:bold;font-size:20px;text-align:center;border:2px solid #0f0;opacity:${opacity}` }, this._lastMessage))
      }
      return { position: pos, rotation: ctx.entity.rotation, custom: ctx.entity.custom, ui: ui.length > 0 ? h('div', null, ...ui) : null }
    }
  }
}
