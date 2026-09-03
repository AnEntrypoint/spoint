export default {
  description: 'A dynamic physics body with collision handling.',
  server: {
    editorProps: [
      { key: 'mass', label: 'Mass (kg)', type: 'number', default: 10 },
      { key: 'color', label: 'Color', type: 'color', default: '#ff8800' }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        mesh: 'box',
        color: c.color ?? '#ff8800',
        sx: 1,
        sy: 1,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({
        type: 'box',
        size: [0.5, 0.5, 0.5],
        mass: c.mass ?? 10,
        dynamic: true
      })
      ctx.state.velocity = [0, 0, 0]
      ctx.state.collisions = 0
    },

    update(ctx, dt) {
      ctx.state.velocity = ctx.entity.linearVelocity || [0, 0, 0]
      ctx.debug?.log?.(`TODO: Implement collision responses or custom physics behavior. Current velocity: ${JSON.stringify(ctx.state.velocity)}`)
    },

    onCollide(ctx, other, manifold) {
      ctx.state.collisions++
      ctx.debug?.log?.(`Collision with ${other.id}: total collisions = ${ctx.state.collisions}`)
    },

    teardown(ctx) {
      ctx.debug?.log?.(`Entity destroyed after ${ctx.state.collisions} collisions`)
    }
  },

  client: {
    render(ctx) {
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom: ctx.entity.custom
      }
    }
  }
}