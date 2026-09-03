export default {
  description: 'Spawns and despawns entities on a timer.',
  server: {
    editorProps: [
      { key: 'spawnInterval', label: 'Spawn interval (sec)', type: 'number', default: 5 },
      { key: 'maxEntities', label: 'Max entities', type: 'number', default: 10 },
      { key: 'entityApp', label: 'Entity app to spawn', type: 'text', default: 'box-dynamic' }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.state.entities = new Set()
      ctx.state.nextId = 0
      ctx.state.spawnCount = 0

      ctx.entity.custom = {
        mesh: 'box',
        color: '#4488ff',
        sx: 1.5,
        sy: 1.5,
        sz: 1.5
      }

      const interval = (c.spawnInterval ?? 5) * 1000
      const maxEntities = c.maxEntities ?? 10
      const entityApp = c.entityApp ?? 'box-dynamic'

      ctx.time?.every?.(interval / 1000, () => {
        if (ctx.state.entities.size >= maxEntities) return

        const id = `spawned_${ctx.state.nextId++}`
        const offset = 3
        const pos = [
          ctx.entity.position[0] + (Math.random() - 0.5) * offset * 2,
          ctx.entity.position[1] + offset,
          ctx.entity.position[2] + (Math.random() - 0.5) * offset * 2
        ]

        ctx.world?.spawn?.(id, { position: pos, app: entityApp })
        ctx.state.entities.add(id)
        ctx.state.spawnCount++
        ctx.debug?.log?.(`Spawned ${id} (total: ${ctx.state.spawnCount})`)
      })
    },

    update(ctx, dt) {
      ctx.debug?.log?.(`Active entities: ${ctx.state.entities.size}; Spawned: ${ctx.state.spawnCount}`)
    },

    onMessage(ctx, msg) {
      if (msg.type === 'entity_destroyed' && ctx.state.entities.has(msg.entityId)) {
        ctx.state.entities.delete(msg.entityId)
        ctx.debug?.log?.(`Entity ${msg.entityId} despawned`)
      }
    },

    teardown(ctx) {
      ctx.state.entities.forEach(id => ctx.world?.destroy?.(id))
      ctx.state.entities.clear()
      ctx.debug?.log?.(`Spawner destroyed; cleaned up ${ctx.state.spawnCount} spawned entities`)
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