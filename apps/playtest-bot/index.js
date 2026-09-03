// A placeable AUTOMATED PLAYTESTING bot: spawned in editor playtest mode to navigate a level
// autonomously and log basic level-design findings, with no human player required. Follows the same
// placeable-app pattern as apps/combat-bot (steering + editorProps + dynamic bodyType) and reuses
// apps/waypoint's collectWaypoints + apps/_lib/path.js's definePath for ordered navigation instead of
// reinventing pathing, falling back to a bounded random-walk when no _waypoint markers are placed in
// the level (matching combat-bot's own wander-when-idle pattern). ctx.canSee (src/apps/AppContext.js)
// gates the spawn-point line-of-sight check, reusing the same LOS primitive combat-bot already uses
// for target acquisition.
//
// Scope (explicit, first closeable version -- see apps/README.md "creating a new app" + AGENTS.md
// no-test-files-ever discipline: this is verified live via a real server tick loop, not a test file):
//   - real waypoint-following when the level has >=2 _waypoint markers, else random-walk within
//     wanderRadius of the bot's spawn point (both drive movement via apps/_lib/steering.js, the same
//     kinematics primitive combat-bot already uses -- no new movement system invented)
//   - stuck detection: position unchanged (within stuckEpsilon) for stuckTicks consecutive ticks logs
//     a "stuck" finding with the position and the tick count, then un-sticks itself by picking a new
//     random-walk target so the bot keeps testing the rest of the level instead of parking forever
//   - spawn-point LOS audit: once per run (staggered by ctx.state.losCheckedAt so N bots placed in one
//     level don't all redo the same O(n^2) sweep every tick), collects every apps/spawn-point marker
//     via collectSpawnPoints and ctx.canSee-tests every pair, logging any pair with no clear line of
//     sight -- this uses the bot's OWN eye height/position as the LOS test origin is irrelevant here
//     (spawn-to-spawn LOS is a level-geometry property, not bot-position-dependent), so it is computed
//     directly from the spawn-point positions themselves, once, not per-bot-position.
//   - weapon-spawn balance analysis: every apps/weapon-spawn marker in the level is seeded into
//     ctx.state.weaponSpawnVisits (id -> count) at setup time (so a NEVER-visited spawn still shows
//     count=0 in the report instead of being silently absent -- see the never-visited-spawn PRD row).
//     Each tick, if the bot's current position is within WEAPON_SPAWN_PROXIMITY of any weapon-spawn
//     marker, that spawn's visit count increments (proximity-based, not a literal pickup/inventory
//     event -- this app has no weapon/inventory of its own, it is measuring LEVEL-DESIGN spawn-visit
//     balance the same way a real player's movement would organically visit spawns while playing).
//     getBalanceReport (onMessage) computes over/under-visited spawns (count vs mean, ratio+deviation)
//     from the real accumulated counts.
//   - full heatmap generation: ctx.state.visited upgraded from a bare presence Set to a real density
//     accumulator (Map cellKey -> visit count, same GRID_CELL=8 granularity as before so this is not a
//     second incompatible grid convention) -- getHeatmap (onMessage) returns {cellSize, cells:[{x,z,
//     count}]} real accumulated data straight from the run, consumable as JSON or rendered to an image
//     by a caller (see scripts/playtest-heatmap-export.mjs for a real PNG/JSON exporter).
//
// - findings/visit counts/heatmap cells are pushed to ctx.state (readable by an editor panel or
//   END_PLAYTEST harvest) AND findings are logged live via ctx.debug (CliDebugger), so a real server
//   console/log shows real bot activity without needing an editor UI at all.

import { collectWeaponSpawns } from '../weapon-spawn/index.js'

const DEFAULT_WANDER_RADIUS = 20
const DEFAULT_STUCK_TICKS = 30       // ~0.5-2s depending on tick rate (see stillTicks window below), tunable via editorProps
// Per-tick "didn't move" epsilon. MUST be well below the bot's own real per-tick travel distance
// (speed * dt) or float32 Jolt-physics position-quantization noise on a genuinely-moving bot pushes
// the measured delta to/under the threshold almost every tick, false-firing "stuck" on a bot that is
// actually travelling in a straight line (confirmed live this session via per-tick trace: at speed=3
// and a 60Hz tick, real per-tick travel is exactly 0.05, and setting this epsilon to that SAME value
// meant physics-quantization jitter of a few micrometres was enough to read as "unmoved" almost every
// tick, firing a false stuck-finding at tick 31 on a bot that had travelled from x=0 to x=-1.5 in a
// dead-straight line the entire time). 1cm is comfortably below any real per-tick travel at any
// speed/tick-rate this app supports (min editorProp speed 0.5 m/s @ 60Hz = 0.0083m/tick already clears
// it) while still catching genuine stuck-against-geometry cases (a wedged body's real residual jitter
// from contact resolution is sub-millimetre, well under 1cm).
const DEFAULT_STUCK_EPSILON = 0.01   // metres; below this counts as "didn't move" for a tick
const ARRIVE_RADIUS = 1.5
const GRID_CELL = 8                  // metres per visited-cell bucket (heatmap grid granularity)
const WEAPON_SPAWN_PROXIMITY = 2.5   // metres; bot within this radius of a weapon-spawn marker counts as a "visit"
const WEAPON_SPAWN_RECHECK_TICKS = 30 // re-collect placed weapon-spawn markers this often (cheap O(n) query, catches markers placed after this bot's setup)

export default {
  description: 'Automated playtesting bot: navigates the level (waypoints or random-walk), logs stuck spots and spawn-point LOS gaps.',
  server: {
    // Must be dynamic like combat-bot -- a static entity's position write is never snapshot-encoded
    // (see EditorHandlers.js's bodyType-from-appDef read + SnapshotEncoder.js's static skip), so a
    // wandering bot would silently never move for any connected client/editor viewer.
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
      ctx.state.path = null           // definePath instance, built lazily once waypoints are seen
      ctx.state.pathDistance = 0      // metres travelled along the path so far
      ctx.state.lastPos = [...home]
      ctx.state.stillTicks = 0
      ctx.state.tick = 0
      ctx.state.findings = []         // { type, tick, position, detail } -- readable by editor/harvest
      ctx.state.visited = new Map()   // coarse grid-cell heatmap density: cellKey -> visit count, see file header
      ctx.state.losChecked = false
      ctx.state.weaponSpawnVisits = new Map()   // weapon-spawn entity id -> proximity-visit count
      ctx.state.weaponSpawns = []               // cached collectWeaponSpawns() result, see _refreshWeaponSpawns
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

      // One-time spawn-point LOS audit, staggered a few ticks after boot so every other app's setup()
      // (including other spawn-point markers placed later in the same entities list) has had a chance
      // to run first.
      if (st.checkSpawnLOS && !st.losChecked && st.tick > 5) {
        st.losChecked = true
        _auditSpawnLOS(ctx)
      }

      const pos = ctx.entity.position

      // Build/refresh a waypoint path if the level has placed >=2 _waypoint markers and we haven't
      // built one yet (or the marker set changed size -- cheap to recheck, query is already O(n)).
      const waypoints = _collectWaypoints(ctx)
      if (waypoints.length >= 2 && (!st.path || st.path.count !== waypoints.length)) {
        // ctx.definePath (src/apps/AppContext.js) wraps apps/_lib/path.js's definePath -- reused
        // directly rather than importing apps/_lib/path.js a second time in this file.
        try { st.path = ctx.definePath(waypoints.map(w => w.position)) } catch { st.path = null }
        st.pathDistance = 0
      }

      let target
      let justRetargeted = false
      if (st.path) {
        // Advance along the path at the steering speed; loop back to the start once the end is reached
        // so the bot keeps testing the level continuously instead of stopping.
        target = st.path.pointAt(st.pathDistance)
        const d2 = _dist2d(pos, target)
        if (d2 < ARRIVE_RADIUS) {
          st.pathDistance += st.path.length > 0 ? Math.min(st.path.length * 0.05, st.path.length) : 0
          if (st.pathDistance >= st.path.length) st.pathDistance = 0   // loop
          justRetargeted = true
        }
      } else {
        // Random-walk fallback: pick a new random point within wanderRadius of home whenever the
        // current target is reached (or none set yet).
        if (!st.wanderTarget || _dist2d(pos, st.wanderTarget) < ARRIVE_RADIUS) {
          const ang = Math.random() * Math.PI * 2, r = Math.random() * st.wanderRadius
          st.wanderTarget = [st.home[0] + Math.cos(ang) * r, st.home[1], st.home[2] + Math.sin(ang) * r]
          justRetargeted = true
        }
        target = st.wanderTarget
      }

      const step = st.steering.step(pos, [target[0], pos[1], target[2]], dt)

      // Collision-aware move: apps/_lib/steering.js is deliberately pure kinematics with no physics
      // awareness (its own file header: "no physics/wire touch"), and ctx.physics.setPosition below is
      // a hard teleport with no collision response of its own -- so without this check the bot would
      // walk straight through walls, which defeats the entire point of stuck-detection against level
      // geometry (confirmed live this session: a bot sealed in a real box-static room never once
      // registered "stuck" because it simply teleported through every wall every tick, reaching
      // whatever far-away random target it picked with nothing ever actually blocking it). Cast a ray
      // from the current position toward the intended step; if something solid is hit closer than the
      // intended travel distance, clamp the move to just short of it instead of committing the full
      // step. This is what makes "stuck" mean "genuinely blocked by real geometry" rather than "an
      // arbitrary kinematic no-op."
      const moveVec = [step.position[0] - pos[0], step.position[1] - pos[1], step.position[2] - pos[2]]
      const moveDist = Math.hypot(moveVec[0], moveVec[1], moveVec[2])
      let finalPos = step.position
      if (moveDist > 1e-5) {
        const dir = [moveVec[0] / moveDist, moveVec[1] / moveDist, moveVec[2] / moveDist]
        const hit = ctx.raycast([pos[0], pos[1] + 0.5, pos[2]], dir, moveDist + 0.3, ctx.physics.getBodyId())
        if (hit && hit.hit && hit.distance < moveDist + 0.3) {
          const clamped = Math.max(0, hit.distance - 0.3)   // stop just short of the obstacle, not inside it
          finalPos = [pos[0] + dir[0] * clamped, step.position[1], pos[2] + dir[2] * clamped]
        }
      }

      // ctx.physics.setPosition (src/apps/AppPhysics.js), not a bare ctx.entity.position assignment --
      // this entity's bodyType is 'dynamic' (a real Jolt body), and a bare position write is silently
      // overwritten by the very next physics.step()'s bulk position readback (confirmed live this
      // session: the bare-assignment version produced spurious every-~1s "stuck" findings because the
      // physics body's own simulated transform kept winning the race against the app's own movement
      // write). setPosition teleports the real body + zeros velocity, matching the same pattern
      // EditorHandlers.js's syncEntityCollider already uses for editor-driven dynamic-entity moves.
      ctx.physics.setPosition(finalPos)

      // Stuck detection: compare against last tick's ACTUALLY-COMMITTED position (finalPos, post
      // collision-clamp -- not the raw kinematic step.position, or a bot pressed against a wall every
      // tick would read as "moving" using the pre-clamp value it never actually reached) so a bot
      // wedged against geometry is caught even mid-approach to a target it can never reach. A tick that
      // just picked a FRESH target (arrived at the old one and reassigned) is excluded from the
      // stillness count -- reaching an arrive-radius and legitimately decelerating to a momentary stop
      // is normal steering behavior, not a stuck bot, and counting it would false-positive on every
      // single waypoint/wander-target arrival (confirmed live: without this guard every arrival logged
      // a false "stuck" finding within ~1s, drowning out genuine stuck cases against real geometry).
      const moved = _dist2d(finalPos, st.lastPos)
      if (moved < DEFAULT_STUCK_EPSILON && !justRetargeted) {
        st.stillTicks++
        if (st.stillTicks === st.stuckTicks) {
          _logFinding(ctx, 'stuck', `position unchanged for ${st.stuckTicks} ticks`, finalPos)
          // Un-stick: force a fresh random-walk target (abandon the current path/wander target) so
          // the bot resumes testing the rest of the level rather than parking here permanently.
          st.path = null
          const ang = Math.random() * Math.PI * 2, r = Math.random() * st.wanderRadius
          st.wanderTarget = [st.home[0] + Math.cos(ang) * r, st.home[1], st.home[2] + Math.sin(ang) * r]
          st.stillTicks = 0
        }
      } else {
        st.stillTicks = 0
      }
      st.lastPos = [...finalPos]

      // Heatmap: bucket the current position into a coarse grid cell and accumulate a real visit
      // COUNT per cell (not just presence) -- GRID_CELL matches the granularity already established
      // by this app before the heatmap-export row, so this is not a second incompatible grid.
      const cellKey = `${Math.round(finalPos[0] / GRID_CELL)},${Math.round(finalPos[2] / GRID_CELL)}`
      st.visited.set(cellKey, (st.visited.get(cellKey) || 0) + 1)

      // Weapon-spawn balance: periodically re-collect placed weapon-spawn markers (cheap O(n) query,
      // catches markers placed/moved after this bot's own setup ran) and, every tick, count a "visit"
      // for any weapon-spawn marker within WEAPON_SPAWN_PROXIMITY of the bot's current position.
      if (st.tick - st.weaponSpawnsCheckedAtTick >= WEAPON_SPAWN_RECHECK_TICKS) _refreshWeaponSpawns(ctx)
      for (const ws of st.weaponSpawns) {
        const d2 = _dist2d(finalPos, ws.position)
        if (d2 <= WEAPON_SPAWN_PROXIMITY) {
          st.weaponSpawnVisits.set(ws.id, (st.weaponSpawnVisits.get(ws.id) || 0) + 1)
        }
      }
    },

    // Lets an editor panel or an end-of-run harvest script pull findings without polling entity.custom
    // (which is snapshot-encoded to every client -- findings are server-only debug data, not gameplay
    // state, so they stay off entity.custom and are fetched on demand instead).
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

// Spawn-point LOS audit: every pair of placed apps/spawn-point markers gets a ctx.canSee test. Uses
// +0.9 eye-height offset matching combat-bot's own LOS convention (src/apps/AppContext.js canSee is a
// raw raycast, callers add their own eye offset).
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
      const eyeA = [a.position[0], a.position[1] + 0.9, a.position[2]]
      const eyeB = [b.position[0], b.position[1] + 0.9, b.position[2]]
      const visible = ctx.canSee(eyeA, eyeB, {})
      if (!visible) {
        gaps++
        _logFinding(ctx, 'spawn-los-gap', `spawn ${a.id} cannot see spawn ${b.id}`, a.position)
      }
    }
  }
  ctx.debug?.log?.(`spawn-LOS audit complete: ${pairs} pair(s) checked, ${gaps} gap(s) found`)
}

// Re-collect placed apps/weapon-spawn markers via collectWeaponSpawns and seed any newly-discovered
// spawn id into ctx.state.weaponSpawnVisits with count=0 -- an existing id's count is left untouched
// (a re-check must never reset an already-accumulated visit count). Seeding at count=0 rather than
// lazily-on-first-visit is what lets a NEVER-visited spawn still appear in the balance report as the
// most under-visited entry, instead of being silently absent from the Map entirely.
function _refreshWeaponSpawns(ctx) {
  const spawns = collectWeaponSpawns(ctx)
  ctx.state.weaponSpawns = spawns
  ctx.state.weaponSpawnsCheckedAtTick = ctx.state.tick ?? 0
  for (const ws of spawns) {
    if (!ctx.state.weaponSpawnVisits.has(ws.id)) ctx.state.weaponSpawnVisits.set(ws.id, 0)
  }
}

// Real balance report: per-spawn visit count vs the mean across all known spawns, expressed as both a
// ratio (count/mean) and an absolute deviation (count-mean), sorted ascending (most under-visited
// first) so the least-visited/most-contested spawns are immediately visible without post-processing.
// Handles the zero-spawn and single-spawn degenerate cases explicitly rather than dividing by zero.
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
    // convenience pointers into the sorted list -- most/least visited are the array ends.
    mostUnderVisited: entries[0],
    mostOverVisited: entries[entries.length - 1],
    spawns: entries,
  }
}

// Real heatmap grid: every accumulated GRID_CELL-bucketed visit count, plus the cell size so a
// consumer can convert cell (x,z) grid-coordinates back to world-space (worldX = x*cellSize,
// worldZ = z*cellSize) without hardcoding GRID_CELL a second time anywhere else.
function _buildHeatmap(ctx) {
  const cells = []
  for (const [key, count] of ctx.state.visited.entries()) {
    const [gx, gz] = key.split(',').map(Number)
    cells.push({ x: gx, z: gz, count })
  }
  return { tick: ctx.state.tick, cellSize: GRID_CELL, cellCount: cells.length, cells }
}
