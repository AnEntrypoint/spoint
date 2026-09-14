import { createWorld, createQuery } from '@spoint/ecs'

export default {
  description: 'ECS demo: tracks entities with tags and queries using @spoint/ecs.',
  server: {
    editorProps: [
      { key: 'logQueries', label: 'Log query results', type: 'checkbox', default: false },
    ],

    setup(ctx) {
      ctx.state._ecs = createWorld()

      ctx.state._ecs.registerSystem('demo-tick', (world, dt) => {
      }, 0)

      const w = ctx.state._ecs
      const red = w.createEntity()
      w.addTag(red, 'collectible')
      w.addComponent(red, 'color', { r: 1, g: 0, b: 0 })

      const blue = w.createEntity()
      w.addTag(blue, 'collectible')
      w.addComponent(blue, 'color', { r: 0, g: 0, b: 1 })

      const green = w.createEntity()
      w.addTag(green, 'collectible')
      w.addComponent(green, 'color', { r: 0, g: 1, b: 0 })

      const obstacle = w.createEntity()
      w.addTag(obstacle, 'obstacle')
      w.addComponent(obstacle, 'size', { w: 2, h: 2, d: 2 })

      ctx.state._collectibleQuery = createQuery(w, { has: ['color'] })
    },

    update(ctx, dt) {
      const w = ctx.state._ecs
      if (!w || w.destroyed) return

      w.update(dt)

      const q = ctx.state._collectibleQuery
      if (q) {
        const ids = q.refresh()
        if (ctx.config.logQueries) {
          console.log(`[ecs-demo] ${ids.length} collectibles, ${w.entityCount} total entities`)
        }
      }
    },

    teardown(ctx) {
      if (ctx.state._ecs) {
        ctx.state._ecs.destroy()
        ctx.state._ecs = null
      }
    },
  },
}