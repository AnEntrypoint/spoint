import { TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

export default {
  server: {
    setup(ctx) {
      const npcId = ctx.config.npcId
      const name = ctx.config.name ?? npcId
      if (typeof npcId !== 'string' || !npcId) throw new TypeError(`[tutorial-npc] ${ctx.entity.id}: config.npcId must be a non-empty string`)
      ctx.entity.custom = { mesh: 'capsule', r: 0.35, h: 1.1, color: ctx.config.color ?? 0xc9a36b, label: name }
      ctx.physics.addColliderFromConfig({ type: 'capsule', radius: 0.35, height: 1.1 })
      ctx.interactable({ prompt: `Press E to talk to the ${name}`, radius: 3 })
      ctx._npcId = npcId
    },
    onInteract(ctx, player) {
      if (player?.id == null) return
      ctx.bus.emit(TUTORIAL_BUS.talk, { npcId: ctx._npcId, playerId: player.id })
    },
  },
}
