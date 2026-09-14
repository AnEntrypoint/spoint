import { defineTutorialFoe, TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

export default {
  server: {
    setup(ctx) {
      ctx._foe = defineTutorialFoe(ctx, {
        kind: 'shadow-beast',
        name: 'Shadow Beast',
        maxHp: 100,
        look: { mesh: 'box', sx: 1.4, sy: 2.2, sz: 1.4, color: 0x2a1840, emissive: 0x5a1a8a, emissiveIntensity: 0.35 },
        halfExtents: [0.7, 1.1, 0.7],
        mass: 50,
        reach: 3.5,
        wanderSpeed: 1.5,
        leashRadius: 6,
        wanderSeconds: 3,
        awake: false,
        dormantLabel: 'Shadow Beast (slumbering)',
        dormantPrompt: 'The Shadow Beast slumbers until the Elder sends you',
      })
      ctx.bus.on(TUTORIAL_BUS.bossState, ({ data }) => ctx._foe.setAwake(!!data?.awake))
      ctx.bus.emit(TUTORIAL_BUS.bossQuery, { entityId: ctx.entity.id })
    },
    onInteract(ctx, player) { ctx._foe.onInteract(ctx, player) },
  },
}
