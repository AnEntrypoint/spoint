import { defineTutorialFoe } from '../_lib/tutorial-rpg-kit.js'

export default {
  server: {
    setup(ctx) {
      ctx._foe = defineTutorialFoe(ctx, {
        kind: 'rat',
        name: 'Rat',
        maxHp: 10,
        look: { mesh: 'box', sx: 0.35, sy: 0.3, sz: 0.6, color: 0x6b5a4a, roughness: 0.9 },
        halfExtents: [0.175, 0.15, 0.3],
        mass: 5,
        reach: 2.5,
        wanderSpeed: 1.2,
        leashRadius: 5,
        wanderSeconds: 2,
      })
    },
    onInteract(ctx, player) { ctx._foe.onInteract(ctx, player) },
  },
}
