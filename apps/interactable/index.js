export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0x00ff88, sx: 1.5, sy: 0.5, sz: 1.5, label: 'INTERACT' }
      ctx.state.interactionCount = 0

      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.75, 0.25, 0.75])
      ctx.physics.setInteractable(3.5)
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
    setup(engine) {
      this._lastMessage = null
      this._messageExpire = 0
      this._canInteract = false
      this._wasRegistered = false
    },

    onFrame(dt, engine) {
      const ent = engine.client?.state?.entities?.find(e => e.app === 'interactable')
      const pos = ent?.position
      const local = engine.client?.state?.players?.find(p => p.id === engine.playerId)
      if (!pos || !local?.position) {
        if (this._wasRegistered) { engine.mobileControls?.unregisterInteractable(this._wasRegistered); this._wasRegistered = false }
        return
      }
      const dx = pos[0]-local.position[0], dy = pos[1]-local.position[1], dz = pos[2]-local.position[2]
      const canInteract = dx*dx+dy*dy+dz*dz < 3.5*3.5
      if (canInteract && !this._wasRegistered) { engine.mobileControls?.registerInteractable(ent.id, 'INTERACT'); this._wasRegistered = ent.id }
      else if (!canInteract && this._wasRegistered) { engine.mobileControls?.unregisterInteractable(this._wasRegistered); this._wasRegistered = false }
      this._canInteract = canInteract
    },

    teardown(engine) {
      if (this._wasRegistered) { engine.mobileControls?.unregisterInteractable(this._wasRegistered); this._wasRegistered = false }
    },

    onEvent(payload, engine) {
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
      const custom = { ...ctx.entity.custom }
      if (this._canInteract) { custom.glow = true; custom.glowColor = 0x00ff88; custom.glowIntensity = 0.5 }
      return { position: pos, rotation: ctx.entity.rotation, custom, ui: ui.length > 0 ? h('div', null, ...ui) : null }
    }
  }
}
