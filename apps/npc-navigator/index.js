const EYE_HEIGHT = 1

export default {
  description: 'NPC navigator: follows navmesh paths from the world\'s baked navmesh (ctx.navmesh) or a fixed patrol route',
  server: {
    bodyType: 'dynamic',
    editorProps: [
      { key: 'speed', label: 'Movement speed', type: 'range', min: 0.5, max: 10, step: 0.5, default: 3 },
      { key: 'stoppingDistance', label: 'Stopping distance', type: 'range', min: 0.1, max: 5, step: 0.1, default: 0.5 },
      { key: 'avoidanceRadius', label: 'Avoidance radius', type: 'range', min: 0.5, max: 5, step: 0.5, default: 2 },
    ],

    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'capsule', color: '#4488dd', sx: 0.5, sy: 1.7, sz: 0.5 }
      ctx.state.waypoints = []
      ctx.state.follow = { i: 0 }
      ctx.state.isMoving = false
      ctx.state.targetPos = null
      ctx.state.lastPath = null
      ctx.state.navmeshError = null
      ctx.state.avoidanceRadius = c.avoidanceRadius ?? 2
      ctx.state.steering = ctx.defineSteering({
        speed: c.speed ?? 3,
        arriveRadius: c.stoppingDistance ?? 0.5,
        clampToTerrain: true,
        yOffset: 0.9,
      })
      ctx.navmesh().then(
        () => { ctx.state.navmeshError = null },
        e => { ctx.state.navmeshError = e.message; ctx.debug.warn(`npc-navigator: ${e.message}`) }
      )
    },

    update(ctx, dt) {
      const st = ctx.state
      if (!st.isMoving) return
      const pos = ctx.entity.position
      const r = st.steering.followPath(pos, st.waypoints, dt, st.follow)
      if (r.done) { _stop(st); return }
      ctx.entity.position = _avoid(ctx, pos, r.position, st.avoidanceRadius)
    },

    onMessage(ctx, msg) {
      const st = ctx.state
      if (!msg || (msg.npcId != null && msg.npcId !== ctx.entity.id)) return
      if (msg.type === 'setTarget' && Array.isArray(msg.position)) {
        const from = [...ctx.entity.position], to = [...msg.position]
        ctx.navmesh().then(nav => {
          const path = nav.findPath(from, to)
          st.lastPath = { from, to, waypoints: path }
          if (!path) { ctx.debug.warn(`npc-navigator: no navmesh path from ${_fmt(from)} to ${_fmt(to)}`); return }
          ctx.debug.log(`npc-navigator: path ${_fmt(from)} -> ${_fmt(to)}: ${path.length} waypoints ${path.map(_fmt).join(' ')}`)
          _start(st, path, to)
        }, e => { st.navmeshError = e.message; ctx.debug.warn(`npc-navigator: setTarget ignored, ${e.message}`) })
      } else if (msg.type === 'stop') {
        _stop(st)
      } else if (msg.type === 'startPatrol' && Array.isArray(msg.route) && msg.route.length) {
        _start(st, msg.route.map(p => [...p]), null)
      }
    },
  },
}

function _fmt(p) { return `[${p.map(v => v.toFixed(2)).join(',')}]` }

function _start(st, waypoints, target) {
  st.waypoints = waypoints
  st.follow = { i: 0 }
  st.targetPos = target
  st.isMoving = true
}

function _stop(st) {
  st.isMoving = false
  st.waypoints = []
  st.follow = { i: 0 }
}

function _avoid(ctx, from, to, radius) {
  const dx = to[0] - from[0], dz = to[2] - from[2]
  const d = Math.hypot(dx, dz)
  if (d < 1e-4) return to
  const dir = [dx / d, 0, dz / d]
  const hit = ctx.raycast([from[0], from[1] + EYE_HEIGHT, from[2]], dir, radius)
  if (!hit?.hit || hit.entityId === ctx.entity.id) return to
  const sidestep = 0.3
  return [to[0] - dir[2] * sidestep, to[1], to[2] + dir[0] * sidestep]
}
