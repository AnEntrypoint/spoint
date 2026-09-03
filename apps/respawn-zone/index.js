// A placeable RESPAWN-ZONE: authors a fall-plane + respawn behaviour in-editor. A maker drops it, sets the
// kill-plane Y and the respawn point; any player who falls below minY is teleported back to the respawn point.
// Wraps defineCheckpoint from apps/_lib (the same fall-loop tps-game hand-rolls), so a platformer/parkour/racing
// level gets safe respawn without code. The respawn point defaults to this entity's own position.
import { defineCheckpoint } from '../_lib/checkpoint.js'

export default {
  description: 'Respawn zone: sets a fall-plane height that teleports a fallen player back to their last checkpoint.',
  server: {
    editorProps: [
      { key: 'minY', label: 'Kill-plane Y', type: 'number', default: -50 },
      { key: 'respawn', label: 'Respawn point', type: 'vec3' },
      { key: 'channel', label: 'Respawn channel', type: 'text', default: 'respawn' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const spawn = Array.isArray(c.respawn) && c.respawn.length >= 3
        ? [c.respawn[0], c.respawn[1], c.respawn[2]]
        : [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]]
      const build = (cfg) => defineCheckpoint({
        spawn,
        minY: cfg.minY ?? -50,
        onRespawn: (c2, playerId) => c2.bus.emit(cfg.channel || 'respawn', { by: playerId, source: c2.entity.id }),
      }, ctx)
      ctx.state._cp = build(c)
      ctx.onConfigChange?.((cfg) => { ctx.state._cp = build(cfg) })
    },
    update(ctx, dt) {
      ctx.state._cp?.tick(dt)
    },
  },
}
