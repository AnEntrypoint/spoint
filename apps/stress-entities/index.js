const COUNT = parseInt(process.env.STRESS_ENTITY_COUNT || '100')
const GRID = Math.ceil(Math.sqrt(COUNT))
const SPACING = 3

export default {
  server: {
    setup(ctx) {
      const cx = ctx.entity.position[0], cz = ctx.entity.position[2]
      for (let i = 0; i < COUNT; i++) {
        const row = Math.floor(i / GRID), col = i % GRID
        const x = cx + (col - GRID / 2) * SPACING
        const z = cz + (row - GRID / 2) * SPACING
        ctx.world.spawn(`se-${i}`, {
          app: 'box-dynamic',
          position: [x, 4, z],
          config: { hx: 0.4, hy: 0.4, hz: 0.4, color: 0xff6600 }
        })
      }
    }
  },
  client: {}
}
