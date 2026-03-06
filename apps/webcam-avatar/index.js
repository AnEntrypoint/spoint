// WebCam AFAN Avatar App
// Using WebJSX with Ripple UI for the GUI overlay
// And lazy-loaded WebcamAFANTracker logic

import * as THREE from 'three'

export default {
    server: {
        setup(ctx) {
            ctx.entity.custom = {
                mesh: 'box',
                color: 0xff00ff,
                label: 'Webcam Avatar',
            }
            ctx.physics.setStatic(true)
            ctx.physics.addBoxCollider([0.5, 0.5, 0.5])
            ctx.state.isWebcamActive = false
        },
        onMessage(ctx, msg) {
            if (msg.type === 'toggle_webcam') {
                ctx.state.isWebcamActive = msg.active
                ctx.network.broadcast({ type: 'webcam_status', active: msg.active, entityId: ctx.entity.id })
            } else if (msg.type === 'afan_data') {
                // Forward AFAN data to clients near the entity
                ctx.network.broadcast({ type: 'afan_data_broadcast', entityId: ctx.entity.id, data: msg.data })
            }
        }
    },

    client: {
        setup(engine) {
            this.enabled = false
            this.tracker = null
        },

        onEvent(payload, engine) {
            if (payload.type === 'webcam_status') {
                if (payload.entityId === this.entityId) {
                    this.serverEnabled = payload.active
                }
            } else if (payload.type === 'afan_data_broadcast' && payload.entityId === this.entityId) {
                // Here we apply morph targets if we had a facial model
                // engine.updateMorphTargets(this.entityId, payload.data)
            }
        },

        async toggleWebcam(ctx) {
            if (this.enabled) {
                if (this.tracker) {
                    this.tracker.stop()
                    this.tracker = null
                }
                this.enabled = false
            } else {
                // dynamically load the webcam module
                if (!window.enableWebcamAFAN) {
                    await import('/webcam-afan.js')
                }
                this.tracker = await window.enableWebcamAFAN((afanData) => {
                    ctx.network.send({ type: 'afan_data', data: Array.from(afanData) })
                })
                this.enabled = !!this.tracker
            }

            ctx.network.send({ type: 'toggle_webcam', active: this.enabled })
        },

        render(ctx) {
            this.entityId = ctx.entity.id
            let ui = null

            // We lean heavily into WebJSX matching ThreeJS + Ripple UI aesthetics
            if (ctx.h) {
                ui = ctx.h('div', { class: 'card w-64 bg-slate-800 shadow-xl pointer-events-auto mt-4' },
                    ctx.h('div', { class: 'card-body text-white' },
                        ctx.h('h2', { class: 'card-title text-lg font-bold' }, 'Avatar Controller'),
                        ctx.h('p', { class: 'text-sm mb-4' }, 'Streams audio2afan to nearby players'),
                        ctx.h('div', { class: 'card-actions justify-end' },
                            ctx.h('button', {
                                class: \`btn \${this.enabled ? 'btn-error' : 'btn-primary'}\`,
                onclick: () => this.toggleWebcam(ctx)
              }, this.enabled ? 'Stop Webcam' : 'Start Webcam')
            )
          )
        )
      }

      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom,
        ui: ui ? ctx.h('div', { style: 'position:absolute;top:20px;left:20px;' }, ui) : null
      }
    }
  }
}
