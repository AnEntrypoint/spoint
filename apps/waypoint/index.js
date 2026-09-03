// A placeable WAYPOINT marker: drop several to author an ordered path (race gates, AI patrol route, payload
// track) with no code. Each carries an `order` number; a game app collects every _waypoint-tagged entity via
// ctx.world.query, sorts by order, and feeds their positions to ctx.definePath (apps/_lib/path.js). The exported
// collectWaypoints(ctx) helper does exactly that. Invisible-ish small marker by default.
export function collectWaypoints(ctx) {
  const marks = ctx.world.query(e => e?.custom?._waypoint)
  return marks
    .map(e => ({ order: e.custom.order ?? 0, position: [...e.position], id: e.id }))
    .sort((a, b) => a.order - b.order)
}

export default {
  description: 'Ordered waypoint marker: drop several to author a race/patrol/payload path (read via collectWaypoints).',
  server: {
    editorProps: [
      { key: 'order', label: 'Order #', type: 'number', default: 0 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffcc00' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'sphere', color: c.color ?? '#ffcc00', _waypoint: true, order: c.order ?? 0, sx: 0.6, sy: 0.6, sz: 0.6 }
      ctx.onConfigChange?.((cfg) => { ctx.entity.custom.order = cfg.order ?? 0; ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color })
    },
  },
}
