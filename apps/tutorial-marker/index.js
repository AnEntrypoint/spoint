import { TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

export default {
  server: {
    setup(ctx) {
      const marker = ctx.config.marker
      const radius = ctx.config.radius ?? 4
      if (typeof marker !== 'string' || !marker) throw new TypeError(`[tutorial-marker] ${ctx.entity.id}: config.marker must be a non-empty string`)
      ctx.entity.custom = { mesh: 'cylinder', r: radius, h: 0.06, color: 0x7fd4ff, emissive: 0x3fa0ff, emissiveIntensity: 0.6, label: ctx.config.name ?? marker }
      ctx.interactable({ prompt: `Press E to commune with the ${ctx.config.name ?? marker}`, radius })
      ctx._marker = marker
    },
    onInteract(ctx, player) {
      if (player?.id == null) return
      ctx.bus.emit(TUTORIAL_BUS.reach, { marker: ctx._marker, playerId: player.id })
    },
  },
}
