export default {
  server: {
    setup(ctx) {
      ctx.entity.custom = { mesh: 'box', color: 0xff00ff, label: 'Webcam' }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
      ctx.state.activeWebcams = ctx.state.activeWebcams || new Map()
    },

    onMessage(ctx, msg) {
      if (!msg) return
      const senderId = msg.senderId || msg.playerId
      if (msg.type === 'webcam_start') {
        ctx.state.activeWebcams.set(senderId, true)
        ctx.network.broadcast({ type: 'webcam_status', playerId: senderId, active: true })
      } else if (msg.type === 'webcam_stop') {
        ctx.state.activeWebcams.delete(senderId)
        ctx.network.broadcast({ type: 'webcam_status', playerId: senderId, active: false })
      } else if (msg.type === 'afan_frame' && msg.data) {
        const sender = ctx.players.getAll().find(p => p.id === senderId)
        if (!sender?.state?.position) return
        const sp = sender.state.position
        const r2 = 900
        for (const p of ctx.players.getAll()) {
          if (!p.state?.position) continue
          const dx = p.state.position[0] - sp[0]
          const dy = p.state.position[1] - sp[1]
          const dz = p.state.position[2] - sp[2]
          if (dx*dx + dy*dy + dz*dz <= r2) {
            ctx.players.send(p.id, { type: 'afan_frame', playerId: senderId, data: msg.data })
          }
        }
      }
    }
  },

  client: {
    setup(engine) {
      this.enabled = false
      this.tracker = null
      this._lastSend = 0
    },

    onEvent(payload, engine) {
      if (payload.type === 'webcam_status' && payload.playerId === engine.playerId) {
        this.enabled = payload.active
      }
    },

    async _toggleWebcam(engine) {
      if (this.enabled) {
        if (this.tracker) { this.tracker.stop(); this.tracker = null }
        engine.network.send({ type: 'webcam_stop' })
        this.enabled = false
        return
      }
      if (!window.enableWebcamAFAN) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script')
          s.type = 'module'
          s.src = '/webcam-afan.js'
          s.onload = resolve
          s.onerror = reject
          document.head.appendChild(s)
          setTimeout(resolve, 2000)
        })
      }
      this.tracker = await window.enableWebcamAFAN((data) => {
        const now = performance.now()
        if (now - this._lastSend < 33) return
        this._lastSend = now
        engine.network.send({ type: 'afan_frame', data: Array.from(data) })
      })
      if (this.tracker) engine.network.send({ type: 'webcam_start' })
    },

    render(ctx) {
      const h = ctx.h
      if (!h) return { position: ctx.entity.position }
      const enabled = this.enabled
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom,
        ui: h('div', { style: 'position:absolute;top:20px;left:20px;pointer-events:auto' },
          h('div', { class: 'card bg-base-200 shadow-xl w-64' },
            h('div', { class: 'card-body' },
              h('h2', { class: 'card-title' }, 'Webcam Avatar'),
              h('p', { class: 'text-sm opacity-70' }, 'Streams face tracking to nearby players'),
              h('div', { class: 'card-actions justify-end' },
                h('button', {
                  class: `btn ${enabled ? 'btn-error' : 'btn-primary'} btn-sm`,
                  onclick: () => this._toggleWebcam(ctx.engine)
                }, enabled ? 'Stop Webcam' : 'Start Webcam')
              )
            )
          )
        )
      }
    }
  }
}
