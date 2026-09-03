// A placeable MOVING PLATFORM: a maker drops it and sets a travel offset + period; it ping-pongs between its
// start position and start+offset on a kinematic body, authored entirely with editorProps (the new vec3 type
// makes the direction/distance pickable). Every platformer/obstacle-course needs this and it required code
// before. Drives its authoritative position via ctx.world.setPosition each tick (kinematic move + collider sync).
export default {
  description: 'Moving platform: a kinematic platform that ping-pongs along a travel offset over a set period.',
  server: {
    // MUST be kinematic, not the spawnEntity/PLACE_APP default 'static' -- a static entity's per-tick
    // position write (ctx.world.setPosition, called every update() below) is never encoded into the
    // snapshot at all (SnapshotEncoder.js's bodyType==='static' skip; TickHandler.js's static path only
    // re-sends static entities on a _staticVersion bump [spawn/destroy] or the ~10s keyframe, never on a
    // bare position mutation), so a moving-platform placed as 'static' would silently never appear to
    // move to any already-connected client -- looking placed-and-frozen forever except for a ~10s-interval
    // keyframe teleport. 'kinematic' (not 'dynamic') is the semantically correct motion type: Jolt moves a
    // kinematic body under direct SetPosition control every tick with no force/gravity simulation, and a
    // rider standing on it is carried via CharacterManager's GetGroundVelocity, exactly this app's contract.
    // See apps/combat-bot/index.js for the same fix pattern (bodyType:'dynamic' there, wandering AI) and
    // EditorHandlers.js's PLACE_APP handler, which reads appDef.bodyType (defaulting to 'static' only when
    // absent) to pick the spawned entity's actual bodyType.
    bodyType: 'kinematic',
    editorProps: [
      { key: 'offset', label: 'Travel (x,y,z)', type: 'vec3', default: [0, 3, 0] },
      { key: 'period', label: 'Period (s)', type: 'range', min: 0.5, max: 30, step: 0.5, default: 4 },
      { key: 'color', label: 'Color', type: 'color', default: '#8899aa' },
      { key: 'sx', label: 'Width', type: 'number', default: 3 },
      { key: 'sz', label: 'Depth', type: 'number', default: 3 },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'box', color: c.color ?? '#8899aa', sx: c.sx ?? 3, sy: 0.4, sz: c.sz ?? 3 }
      // Kinematic: moves under script control, not physics forces; a rider stands on it.
      ctx.state._start = [ctx.entity.position[0], ctx.entity.position[1], ctx.entity.position[2]]
      ctx.state._t = 0
    },
    update(ctx, dt) {
      const c = ctx.config || {}
      const offset = Array.isArray(c.offset) ? c.offset : [0, 3, 0]
      const period = (typeof c.period === 'number' && c.period > 0) ? c.period : 4
      ctx.state._t += dt
      // Ping-pong 0..1..0 via a triangle wave over the period, so it eases to a stop at each end and reverses.
      const phase = (ctx.state._t % period) / period          // 0..1
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2    // 0..1..0
      const s = ctx.state._start
      ctx.world.setPosition(ctx.entity.id, [s[0] + offset[0] * tri, s[1] + offset[1] * tri, s[2] + offset[2] * tri])
    },
  },
}
