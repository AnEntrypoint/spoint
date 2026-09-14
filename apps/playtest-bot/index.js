import { collectWeaponSpawns } from '../weapon-spawn/index.js'

const DEFAULT_WANDER_RADIUS = 20
const DEFAULT_STUCK_TICKS = 30
const DEFAULT_STUCK_EPSILON = 0.01
const ARRIVE_RADIUS = 1.5
const GRID_CELL = 8
const WEAPON_SPAWN_PROXIMITY = 2.5
const WEAPON_SPAWN_RECHECK_TICKS = 30
const OBSTACLE_STANDOFF = 0.3
const SPAWN_EYE_HEIGHT = 0.9
const LOS_AUDIT_DELAY_TICKS = 5

export default {
  description: 'Automated playtesting bot: navigates the level (waypoints or random-walk), logs stuck spots and spawn-point LOS gaps.',
  server: {
    bodyType: 'dynamic',
    editorProps: [
      { key: 'speed', label: 'Move speed', type: 'range', min: 0.5, max: 10, step: 0.5, default: 3 },
      { key: 'wanderRadius', label: 'Wander radius (m)', type: 'range', min: 5, max: 100, step: 5, default: DEFAULT_WANDER_RADIUS },
      { key: 'stuckTicks', label: 'Stuck threshold (ticks)', type: 'range', min: 5, max: 300, step: 5, default: DEFAULT_STUCK_TICKS },
      { key: 'checkSpawnLOS', label: 'Audit spawn-point LOS', type: 'checkbox', default: true },
      { key: 'color', label: 'Color', type: 'color', default: '#22ddaa' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const home = [...ctx.entity.position]
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'capsule', color: c.color ?? '#22ddaa', sx: 0.45, sy: 1.6, sz: 0.45, _isPlaytestBot: true }
      ctx.state.steering = ctx.defineSteering({ speed: c.speed ?? 3, arriveRadius: ARRIVE_RADIUS, clampToTerrain: true, yOffset: 0.85 })
      ctx.state.home = home
      ctx.state.wanderRadius = c.wanderRadius ?? DEFAULT_WANDER_RADIUS
      ctx.state.stuckTicks = c.stuckTicks ?? DEFAULT_STUCK_TICKS
      ctx.state.checkSpawnLOS = c.checkSpawnLOS !== false
      ctx.state.wanderTarget = null
      ctx.state.path = null
      ctx.state.pathDistance = 0
      ctx.state.lastPos = [...home]
      ctx.state.stillTicks = 0
      ctx.state.tick = 0
      ctx.state.findings = []
      ctx.state.visited = new Map()
      ctx.state.losChecked = false
      ctx.state.weaponSpawnVisits = new Map()
      ctx.state.weaponSpawns = []
      ctx.state.weaponSpawnsCheckedAtTick = -Infinity
      _refreshWeaponSpawns(ctx)
      ctx.onConfigChange?.((cfg) => {
        ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color
        if (cfg.speed != null) ctx.state.steering = ctx.defineSteering({ speed: cfg.speed, arriveRadius: ARRIVE_RADIUS, clampToTerrain: true, yOffset: 0.85 })
        ctx.state.wanderRadius = cfg.wanderRadius ?? ctx.state.wanderRadius
        ctx.state.stuckTicks = cfg.stuckTicks ?? ctx.state.stuckTicks
        ctx.state.checkSpawnLOS = cfg.checkSpawnLOS !== false
      })
      ctx.debug?.log?.(`playtest-bot spawned @ ${home.map(n => n.toFixed(1)).join(',')}`)
    },

    update(ctx, dt) {
      const st = ctx.state
      st.tick++

      if (st.checkSpawnLOS && !st.losChecked && st.tick > LOS_AUDIT_DELAY_TICKS) {
        st.losChecked = true
        _auditSpawnLOS(ctx)
      }

      const pos = ctx.entity.position

      const waypoints = _collectWaypoints(ctx)
      if (waypoints.length >= 2 && (!st.path || st.path.count !== waypoints.length)) {
        try { st.path = ctx.definePath(waypoints.map(w => w.position)) } catch { st.path = null }
        st.pathDistance = 0
      }

      let target
      let justRetargeted = false
      if (st.path) {
        target = st.path.pointAt(st.pathDistance)
        const d2 = _dist2d(pos, target)
        if (d2 < ARRIVE_RADIUS) {
          st.pathDistance += st.path.length > 0 ? Math.min(st.path.length * 0.05, st.path.length) : 0
          if (st.pathDistance >= st.path.length) st.pathDistance = 0
          justRetargeted = true
        }
      } else {
        if (!st.wanderTarget || _dist2d(pos, st.wanderTarget) < ARRIVE_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.random() * st.wanderRadius
          st.wanderTarget = [st.home[0] + Math.cos(ang) * r, st.home[1], st.home[2] + Math.sin(ang) * r]
          justRetargeted = true
        }
        target = st.wanderTarget
      }

      const step = st.steering.step(pos, [target[0], pos[1], target[2]], dt)

      const moveVec = [step.position[0] - pos[0], step.position[1] - pos[1], step.position[2] - pos[2]]
      const moveDist = Math.hypot(moveVec[0], moveVec[1], moveVec[2])
      let finalPos = step.position
      if (moveDist > 1e-5) {
        const dir = [moveVec[0] / moveDist, moveVec[1] / moveDist, moveVec[2] / moveDist]
        const hit = ctx.raycast([pos[0], pos[1] + 0.5, pos[2]], dir, moveDist + OBSTACLE_STANDOFF, ctx.physics.getBodyId())
        if (hit && hit.hit && hit.distance < moveDist + OBSTACLE_STANDOFF) {
          const clamped = Math.max(0, hit.distance - OBSTACLE_STANDOFF)
          finalPos = [pos[0] + dir[0] * clamped, step.position[1], pos[2] + dir[2] * clamped]
        }
      }

      ctx.physics.setPosition(finalPos)

      const moved = _dist2d(finalPos, st.lastPos)
      if (moved < DEFAULT_STUCK_EPSILON && !justRetargeted) {
        st.stillTicks++
        if (st.stillTicks === st.stuckTicks) {
          _logFinding(ctx, 'stuck', `position unchanged for ${st.stuckTicks} ticks`, finalPos)
          st.path = null
          const ang = Math.random() * Math.PI * 2, r = Math.random() * st.wanderRadius
          st.wanderTarget = [st.home[0] + Math.cos(ang) * r, st.home[1], st.home[2] + Math.sin(ang) * r]
          st.stillTicks = 0
        }
      } else {
        st.stillTicks = 0
      }
      st.lastPos = [...finalPos]

      const cellKey = `${Math.round(finalPos[0] / GRID_CELL)},${Math.round(finalPos[2] / GRID_CELL)}`
      st.visited.set(cellKey, (st.visited.get(cellKey) || 0) + 1)

      if (st.tick - st.weaponSpawnsCheckedAtTick >= WEAPON_SPAWN_RECHECK_TICKS) _refreshWeaponSpawns(ctx)
      for (const ws of st.weaponSpawns) {
        const d2 = _dist2d(finalPos, ws.position)
        if (d2 <= WEAPON_SPAWN_PROXIMITY) {
          st.weaponSpawnVisits.set(ws.id, (st.weaponSpawnVisits.get(ws.id) || 0) + 1)
        }
      }
    },

    onMessage(ctx, msg) {
      if (msg && msg.type === 'getFindings') {
        return { findings: ctx.state.findings, visitedCells: ctx.state.visited.size, tick: ctx.state.tick }
      }
      if (msg && msg.type === 'getBalanceReport') {
        return _buildBalanceReport(ctx)
      }
      if (msg && msg.type === 'getHeatmap') {
        return _buildHeatmap(ctx)
      }
    },
  },
}

function _dist2d(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]) }

function _collectWaypoints(ctx) {
  const marks = ctx.world.query(e => e?.custom?._waypoint)
  return marks
    .map(e => ({ order: e.custom.order ?? 0, position: [...e.position], id: e.id }))
    .sort((a, b) => a.order - b.order)
}

function _logFinding(ctx, type, detail, position) {
  const finding = { type, tick: ctx.state.tick, position: [...position], detail }
  ctx.state.findings.push(finding)
  ctx.debug?.warn?.(`[finding:${type}] tick=${finding.tick} pos=${position.map(n => n.toFixed(1)).join(',')} ${detail}`)
}

function _auditSpawnLOS(ctx) {
  const spawns = ctx.world.query(e => e.custom && e.custom._spawnPoint)
  const points = spawns.map(e => ({ id: e.id, position: [...e.position] }))
  if (points.length < 2) {
    ctx.debug?.log?.(`spawn-LOS audit: only ${points.length} spawn-point marker(s) placed, need >=2 to audit pairs -- skipped`)
    return
  }
  let pairs = 0, gaps = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      pairs++
      const a = points[i], b = points[j]
      const eyeA = [a.position[0], a.position[1] + SPAWN_EYE_HEIGHT, a.position[2]]
      const eyeB = [b.position[0], b.position[1] + SPAWN_EYE_HEIGHT, b.position[2]]
      const visible = ctx.canSee(eyeA, eyeB, {})
      if (!visible) {
        gaps++
        _logFinding(ctx, 'spawn-los-gap', `spawn ${a.id} cannot see spawn ${b.id}`, a.position)
      }
    }
  }
  ctx.debug?.log?.(`spawn-LOS audit complete: ${pairs} pair(s) checked, ${gaps} gap(s) found`)
}

function _refreshWeaponSpawns(ctx) {
  const spawns = collectWeaponSpawns(ctx)
  ctx.state.weaponSpawns = spawns
  ctx.state.weaponSpawnsCheckedAtTick = ctx.state.tick ?? 0
  for (const ws of spawns) {
    if (!ctx.state.weaponSpawnVisits.has(ws.id)) ctx.state.weaponSpawnVisits.set(ws.id, 0)
  }
}

function _buildBalanceReport(ctx) {
  const entries = [...ctx.state.weaponSpawnVisits.entries()].map(([id, count]) => {
    const meta = ctx.state.weaponSpawns.find(w => w.id === id)
    return { id, weaponType: meta?.weaponType ?? 'unknown', position: meta?.position ?? null, count }
  })
  if (entries.length === 0) {
    return { tick: ctx.state.tick, spawnCount: 0, totalVisits: 0, meanVisits: 0, spawns: [], note: 'no weapon-spawn markers placed in this level' }
  }
  const totalVisits = entries.reduce((s, e) => s + e.count, 0)
  const meanVisits = totalVisits / entries.length
  for (const e of entries) {
    e.ratioToMean = meanVisits > 0 ? e.count / meanVisits : (e.count > 0 ? Infinity : 0)
    e.deviationFromMean = e.count - meanVisits
  }
  entries.sort((a, b) => a.count - b.count)
  return {
    tick: ctx.state.tick,
    spawnCount: entries.length,
    totalVisits,
    meanVisits,
    mostUnderVisited: entries[0],
    mostOverVisited: entries[entries.length - 1],
    spawns: entries,
  }
}

function _buildHeatmap(ctx) {
  const cells = []
  for (const [key, count] of ctx.state.visited.entries()) {
    const [gx, gz] = key.split(',').map(Number)
    cells.push({ x: gx, z: gz, count })
  }
  return { tick: ctx.state.tick, cellSize: GRID_CELL, cellCount: cells.length, cells }
}
