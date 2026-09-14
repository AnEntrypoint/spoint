import { TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

export default {
  server: {
    setup(ctx) {
      const itemId = ctx.config.itemId ?? 'herb'
      ctx.entity.custom = { mesh: 'sphere', r: 0.25, color: 0x3fa34d, emissive: 0x1d5c26, emissiveIntensity: 0.5, spin: 1.5 }
      ctx.interactable({ prompt: 'Press E to pick the herb', radius: 2 })
      ctx._itemId = itemId
      ctx._collected = false
    },
    onInteract(ctx, player) {
      if (player?.id == null || ctx._collected) return
      ctx._collected = true
      ctx.bus.emit(TUTORIAL_BUS.collect, { entityId: ctx.entity.id, itemId: ctx._itemId, playerId: player.id })
      ctx.entity.destroy()
    },
  },
}
