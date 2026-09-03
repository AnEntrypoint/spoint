// ecs-demo — Proof-of-concept app demonstrating @spoint/ecs integration within a spoint app.
// Uses @spoint/ecs for internal entity tracking alongside the AppRuntime context (ctx).
// This is the FIRST SLICE of cross-project-ecs-migrate-spoint-apps-to-shared-package:
// prove that @spoint/ecs can be imported from app code, that entities/tags/queries work,
// and that the ECS world can coexist with the AppRuntime's own entity management.
//
// This app tracks tagged "collectible" entities in an ECS world and uses queries to
// find them. It's a self-contained demo — no gameplay impact on other apps.

import { createWorld, createQuery } from '@spoint/ecs'

export default {
  description: 'ECS demo: tracks entities with tags and queries using @spoint/ecs.',
  server: {
    editorProps: [
      { key: 'logQueries', label: 'Log query results', type: 'checkbox', default: false },
    ],

    setup(ctx) {
      // Create an ECS world for internal entity tracking.
      // This ECS world is SEPARATE from the AppRuntime's own entity map (ctx.world.*)
      // — it's a lightweight, per-app world for this app's own state.
      ctx.state._ecs = createWorld()

      // Register an ECS system that runs every tick, demonstrating system scheduling.
      ctx.state._ecs.registerSystem('demo-tick', (world, dt) => {
        // Systems receive the world and dt — they can query, mutate, etc.
        // This is a no-op demo system; a real app would do work here.
      }, 0)

      // Create some demo entities with tags
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

      // Create a query for all collectibles
      ctx.state._collectibleQuery = createQuery(w, { has: ['color'] })
    },

    update(ctx, dt) {
      const w = ctx.state._ecs
      if (!w || w.destroyed) return

      // Run ECS systems
      w.update(dt)

      // Query collectibles
      const q = ctx.state._collectibleQuery
      if (q) {
        const ids = q.refresh()
        if (ctx.config.logQueries) {
          console.log(`[ecs-demo] ${ids.length} collectibles, ${w.entityCount} total entities`)
        }
      }
    },

    teardown(ctx) {
      // Clean up the ECS world when the app is hot-reloaded or removed
      if (ctx.state._ecs) {
        ctx.state._ecs.destroy()
        ctx.state._ecs = null
      }
    },
  },
}