// NPC Navigator app: uses navmesh pathfinding for intelligent movement.
// Placeable app that provides steering with obstacle avoidance and waypoint following.

export default {
  description: 'NPC navigator with navmesh pathfinding and waypoint following',
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

      // Navigation state
      ctx.state.navmesh = null
      ctx.state.navmeshPath = null
      ctx.state.waypoints = []
      ctx.state.currentWaypointIdx = 0
      ctx.state.isMoving = false
      ctx.state.targetPos = null

      // Steering and movement
      ctx.state.steering = ctx.defineSteering({
        speed: c.speed ?? 3,
        arriveRadius: c.stoppingDistance ?? 0.5,
        clampToTerrain: true,
        yOffset: 0.9,
      })

      ctx.state.speed = c.speed ?? 3
      ctx.state.stoppingDistance = c.stoppingDistance ?? 0.5
      ctx.state.avoidanceRadius = c.avoidanceRadius ?? 2

      // Load navmesh if available
      _loadNavmesh(ctx)
    },

    update(ctx, dt) {
      const st = ctx.state

      if (!st.isMoving) return

      if (!st.waypoints || st.waypoints.length === 0) {
        st.isMoving = false
        return
      }

      const pos = ctx.entity.position
      const currentTarget = st.waypoints[st.currentWaypointIdx]

      if (!currentTarget) {
        st.isMoving = false
        return
      }

      // Check if reached current waypoint
      const dx = currentTarget[0] - pos[0]
      const dy = currentTarget[1] - pos[1]
      const dz = currentTarget[2] - pos[2]
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

      if (dist < st.stoppingDistance) {
        st.currentWaypointIdx++

        if (st.currentWaypointIdx >= st.waypoints.length) {
          // Reached final destination
          st.isMoving = false
          st.waypoints = []
          st.currentWaypointIdx = 0
          return
        }
      }

      // Steer toward current waypoint
      const nextTarget = st.waypoints[st.currentWaypointIdx]
      const result = st.steering.step(pos, nextTarget, dt)

      // Simple obstacle avoidance: raycast around current direction
      const avoidPos = _applyLocalAvoidance(ctx, pos, result.position, st.avoidanceRadius)

      ctx.entity.position = avoidPos
    },

    onMessage(ctx, msg) {
      const st = ctx.state
      if (!msg) return

      if (msg.type === 'setTarget' && msg.position) {
        // Start pathfinding to target
        if (!st.navmesh) {
          console.warn('NPC navigator: navmesh not loaded')
          return
        }

        const pos = ctx.entity.position
        const waypoints = st.navmesh.findPath(pos, msg.position)

        if (waypoints && waypoints.length > 0) {
          st.waypoints = waypoints
          st.currentWaypointIdx = 0
          st.isMoving = true
          st.targetPos = msg.position
        } else {
          console.warn('NPC navigator: no path found or target unreachable')
        }
      } else if (msg.type === 'stop') {
        st.isMoving = false
        st.waypoints = []
        st.currentWaypointIdx = 0
      } else if (msg.type === 'startPatrol' && msg.route) {
        // Begin patrol along waypoint sequence
        st.waypoints = msg.route
        st.currentWaypointIdx = 0
        st.isMoving = true
      }
    },
  },
}

async function _loadNavmesh(ctx) {
  try {
    // Load navmesh data from world directory
    // Note: This runs on server-side app, NavmeshQuery module is imported at module level
    const worldName = ctx.world?.name || 'aim_sillos'

    // Import here to keep server-side only (NavmeshQuery is Node.js compatible)
    const { NavmeshQuery } = await import('../../src/pathfinding/NavmeshQuery.js')

    // In a real implementation, this would fetch/load the navmesh JSON from disk
    // For now, we'll try to load it from a relative path (Node.js filesystem)
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const navmeshPath = path.join(process.cwd(), 'apps', 'world', `${worldName}.navmesh.json`)
      const data = fs.readFileSync(navmeshPath, 'utf-8')
      const navmeshData = JSON.parse(data)
      ctx.state.navmesh = new NavmeshQuery(navmeshData)
      console.log(`Loaded navmesh for world: ${worldName}`)
    } catch (e) {
      // Fallback: create a dummy navmesh for testing if file not found
      console.warn(`Navmesh not found: ${worldName}.navmesh.json (run: npm run bake-navmesh --world=${worldName})`)
      // ctx.state.navmesh will remain null, queries will return null
    }
  } catch (e) {
    console.warn('Failed to load NavmeshQuery module:', e.message)
  }
}

function _applyLocalAvoidance(ctx, currentPos, targetPos, avoidanceRadius) {
  // Simple local steering avoidance: check for nearby obstacles
  // If path is blocked, nudge sideways
  const pos = [...currentPos]

  // Raycast forward to check for obstacles
  const dir = [targetPos[0] - currentPos[0], 0, targetPos[2] - currentPos[2]]
  const dist = Math.sqrt(dir[0] * dir[0] + dir[2] * dir[2])
  if (dist > 0.001) {
    dir[0] /= dist
    dir[2] /= dist
  }

  const rayStart = [currentPos[0] + dir[0] * 0.5, currentPos[1] + 1, currentPos[2] + dir[2] * 0.5]
  const rayEnd = [rayStart[0] + dir[0] * avoidanceRadius, rayStart[1], rayStart[2] + dir[2] * avoidanceRadius]

  // Check for obstacles via world raycast (if available)
  try {
    const hits = ctx.world?.raycast?.(rayStart, rayEnd, { maxDistance: avoidanceRadius })
    if (hits && hits.length > 0) {
      // Obstacle detected, nudge sideways
      const lateral = [-dir[2], 0, dir[0]]
      const sidestep = 0.3
      pos[0] += lateral[0] * sidestep
      pos[2] += lateral[2] * sidestep
    }
  } catch (e) {
    // Raycast not available, continue without local avoidance
  }

  return pos
}
