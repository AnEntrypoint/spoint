export default {
  description: 'An entity that players can interact with using the E key.',
  server: {
    editorProps: [
      { key: 'prompt', label: 'Interaction prompt', type: 'text', default: 'Press E' },
      { key: 'radius', label: 'Interact radius', type: 'range', min: 0.5, max: 10, step: 0.5, default: 3 }
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        mesh: 'box',
        color: '#00ff88',
        sx: 1,
        sy: 0.5,
        sz: 1
      }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.5, 0.25, 0.5] })
      ctx.interactable?.({ prompt: c.prompt ?? 'Press E', radius: c.radius ?? 3 })
      ctx.state.interactionCount = 0
      ctx.state.lastInteractors = new Map()
      ctx.onConfigChange?.((cfg) => {
        ctx.interactable?.({ prompt: cfg.prompt ?? 'Press E', radius: cfg.radius ?? 3 })
      })
    },

    update(ctx, dt) {
      ctx.debug?.log?.(`TODO: Add timed interactions or distance-based logic. Interactions so far: ${ctx.state.interactionCount}`)
    },

    onInteract(ctx, player) {
      ctx.state.interactionCount++
      ctx.state.lastInteractors.set(player.id, Date.now())
      ctx.debug?.log?.(`Player ${player.id} interacted. Total: ${ctx.state.interactionCount}`)
      ctx.bus?.emit?.('interact.triggered', { entity: ctx.entity.id, player: player.id })
    },

    teardown(ctx) {
      ctx.state.lastInteractors?.clear?.()
    }
  },

  client: {
    setup(engine) {
      this.data = { canInteract: false, lastPrompt: null }
    },

    render(ctx) {
      const custom = { ...ctx.entity.custom }
      if (this.data.canInteract) {
        custom.glow = true
        custom.glowColor = 0x00ff88
      }
      return {
        position: ctx.entity.position,
        rotation: ctx.entity.rotation,
        custom
      }
    }
  }
}