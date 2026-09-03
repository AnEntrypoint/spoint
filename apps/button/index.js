// A placeable, wireable BUTTON: a maker drops it, sets a target entity + channel in the inspector, and on
// press (E) it emits an event to that target's channel over the shared bus. The paired listener is any app
// (e.g. a door) that ctx.bus.on(channel)s. This is the in-editor "A triggers B" primitive -- the target is
// picked with the entity-reference editorProp, no code. Uses only existing ctx primitives (interactable + bus).
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
      // Small visible pad + interact prompt. mesh via custom so the client draws a box; collider static.
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#e0b030', sx: 0.8, sy: 0.2, sz: 0.8 }
      ctx.physics?.addColliderFromConfig?.({ type: 'box', size: [0.4, 0.1, 0.4] })
      ctx.interactable({ prompt: c.prompt ?? 'Press E', radius: c.radius ?? 3 })
      ctx.state._fired = false
      // Re-derive interact config live when the maker edits editorProps.
      ctx.onConfigChange?.((cfg) => { ctx.interactable({ prompt: cfg.prompt ?? 'Press E', radius: cfg.radius ?? 3 }) })
    },
    onInteract(ctx, player) {
      const c = ctx.config || {}
      if (c.once && ctx.state._fired) return
      ctx.state._fired = true
      const channel = c.channel || 'button.press'
      // Emit both on the button's own scoped channel and, if a target is wired, a target-addressed event so a
      // listener can filter by which entity fired it. custom.targets (array, written by BOTH the HookFlow
      // canvas wire-drag AND the Inspector-tab entity-reference field, see EditPanelDOM.js's propField
      // 'entity' branch, editor-node-graph-wire-inspector-field-multi-target-sync) is the real multi-target
      // shape now; `target` here stays a single legacy-shaped scalar (first wired target) so an existing
      // bus.on(channel) listener that reads event.target keeps working unchanged -- see AGENTS.md's
      // editor-node-graph-wire-multi-target-per-source entry for why `target` is per-source metadata only,
      // never used to filter which entities receive the emit (the maker wires N listeners to the SAME
      // channel for that). A future multi-target-aware listener should read `targets` (the full array).
      const targets = Array.isArray(c.targets) ? c.targets.filter(t => t != null).map(String) : (c.target != null ? [String(c.target)] : [])
      ctx.bus.emit(channel, { by: player?.id ?? null, source: ctx.entity.id, target: targets[0] ?? null, targets })
    },
  },
}
