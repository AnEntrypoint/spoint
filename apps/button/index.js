export default {
  description: 'Wireable button: press E to fire an event at a target entity (the in-editor "A triggers B" primitive).',
  server: {
    editorProps: [
      { key: 'target', label: 'Target entity', type: 'entity' },
      { key: 'channel', label: 'Channel', type: 'text', default: 'button.press' },
      { key: 'prompt', label: 'Prompt', type: 'text', default: 'Press E' },
      { key: 'radius', label: 'Interact radius', type: 'range', min: 0.5, max: 10, step: 0.5, default: 3 },
      { key: 'color', label: 'Color', type: 'color', default: '#e0b030' },
      { key: 'once', label: 'Fire once', type: 'checkbox', default: false },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#e0b030', sx: 0.8, sy: 0.2, sz: 0.8 }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.4, 0.1, 0.4] })
      ctx.interactable({ prompt: c.prompt ?? 'Press E', radius: c.radius ?? 3 })
      ctx.state._fired = false
      ctx.onConfigChange?.((cfg) => { ctx.interactable({ prompt: cfg.prompt ?? 'Press E', radius: cfg.radius ?? 3 }) })
    },
    onInteract(ctx, player) {
      const c = ctx.config || {}
      if (c.once && ctx.state._fired) return
      ctx.state._fired = true
      const channel = c.channel || 'button.press'
      const targets = Array.isArray(c.targets) ? c.targets.filter(t => t != null).map(String) : (c.target != null ? [String(c.target)] : [])
      ctx.bus.emit(channel, { by: player?.id ?? null, source: ctx.entity.id, target: targets[0] ?? null, targets })
    },
  },
}
