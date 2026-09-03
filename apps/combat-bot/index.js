// A placeable server-driven combat bot: seeks the nearest visible player, shoots when in range + LOS,
// wanders when no player is visible. Roadmap #83 (bots) -- utility-AI tier (target selection scored by
// distance + LOS), not a full behavior tree, and steers via apps/_lib/steering.js (seek/arrive kinematics)
// rather than a real navmesh (no navmesh bake exists in this engine yet -- see
// navmesh-bake-and-utility-ai-bots PRD row for the fuller pathfinding follow-on; this app is the
// immediately-shippable slice: real target acquisition, real LOS gating, real hitscan combat, real
// wander-when-idle, entirely playable today against real players).
//
// Placed like any other app (drop via the editor's Add menu, or worldDef.entities). editorProps let a
// maker tune the bot's stats per-instance without touching code.

const WANDER_RADIUS = 25
const WANDER_ARRIVE = 2
const ENGAGE_RANGE = 60
const RETARGET_INTERVAL_S = 0.5

export default {
  description: 'A combat bot: seeks + shoots the nearest visible player, wanders when idle. Empty-server backfill.',
  server: {
    // Must be dynamic, not the spawnEntity default 'static' -- a static entity's per-tick position write
    // is never encoded into the snapshot at all (see SnapshotEncoder.js's bodyType==='static' skip), so a
    // wandering/chasing bot would silently never appear to move to any connected client. See EditorHandlers.js
    // PLACE_APP's new bodyType-from-appDef read.
    bodyType: 'dynamic',
    editorProps: [
      { key: 'health', label: 'Health', type: 'range', min: 20, max: 300, step: 10, default: 100 },
      { key: 'speed', label: 'Move speed', type: 'range', min: 1, max: 10, step: 0.5, default: 3.5 },
      { key: 'damage', label: 'Weapon damage', type: 'range', min: 5, max: 60, step: 5, default: 20 },
      { key: 'fireRateMs', label: 'Fire rate (ms)', type: 'range', min: 60, max: 2000, step: 20, default: 250 },
      { key: 'range', label: 'Weapon range (m)', type: 'range', min: 10, max: 200, step: 10, default: 80 },
      { key: 'aggro', label: 'Aggro radius (m)', type: 'range', min: 10, max: 300, step: 10, default: 100 },
      { key: 'color', label: 'Color', type: 'color', default: '#dd3344' },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      const home = [...ctx.entity.position]
      ctx.entity.custom = { ...(ctx.entity.custom || {}), mesh: 'capsule', color: c.color ?? '#dd3344', sx: 0.5, sy: 1.7, sz: 0.5, _isBot: true }
      ctx.state.health = ctx.defineHealth({ max: c.health ?? 100, invulnMs: 300, onDeath: () => _onDeath(ctx) })
      ctx.state.steering = ctx.defineSteering({ speed: c.speed ?? 3.5, arriveRadius: 1, clampToTerrain: true, yOffset: 0.9, useNavCost: true })
      ctx.state.weapon = ctx.defineWeapon({ damage: c.damage ?? 20, range: c.range ?? 80, fireRateMs: c.fireRateMs ?? 250, magazine: 0 })
      ctx.state.weaponRange = c.range ?? 80
      ctx.state.home = home
      ctx.state.wanderTarget = null
      ctx.state.targetId = null
      ctx.state.retargetTimer = 0
      ctx.state.aggro = c.aggro ?? 100
      ctx.onConfigChange?.((cfg) => {
        ctx.state.aggro = cfg.aggro ?? ctx.state.aggro
        ctx.entity.custom.color = cfg.color ?? ctx.entity.custom.color
      })
    },

    // Damage entry point: any weapon system attributes a raycast hit to this entity (ctx.raycast's
    // returned entityId) and routes it here via ctx.world.sendToEntity(entityId, {type:'damage', amount}) --
    // e.g. apps/tps-game/server.js's handleFire on its world-geometry raycast fallback. Not a player, so
    // player-only hit-resolution loops (which match against ctx.players.getAll()) never see this bot;
    // sendToEntity is the addressed cross-entity path that makes bots a real hittable target regardless of
    // which game mode's weapon code fired the shot.
    onMessage(ctx, msg) {
      if (msg && msg.type === 'damage' && typeof msg.amount === 'number') ctx.state.health.damage(msg.amount, msg.shooterId ?? null)
    },

    update(ctx, dt) {
      const st = ctx.state
      if (!st.health.alive) return
      st.retargetTimer -= dt
      if (st.retargetTimer <= 0) { st.targetId = _pickTarget(ctx); st.retargetTimer = RETARGET_INTERVAL_S }

      const pos = ctx.entity.position
      const target = st.targetId != null ? ctx.players.getAll().find(p => p.id === st.targetId) : null

      if (target && target.state && target.state.position) {
        // In LOS + weapon range: stop and shoot. Otherwise close the distance. st.weaponRange mirrors the
        // range passed to ctx.defineWeapon above (weapon.js exposes no public .range accessor, so this
        // config value is the source of truth for the bot's own engagement-distance decision).
        const tp = target.state.position
        const dist = Math.hypot(tp[0] - pos[0], tp[1] - pos[1], tp[2] - pos[2])
        const los = ctx.canSee([pos[0], pos[1] + 0.9, pos[2]], [tp[0], tp[1] + 0.9, tp[2]], { maxDistance: ENGAGE_RANGE })
        if (los && dist <= st.weaponRange) {
          if (st.weapon.canFire()) {
            const dir = [(tp[0] - pos[0]) / (dist || 1), (tp[1] + 0.9 - pos[1] - 0.9) / (dist || 1), (tp[2] - pos[2]) / (dist || 1)]
            st.weapon.fire(ctx.entity.id, [pos[0], pos[1] + 0.9, pos[2]], dir, {})
          }
        } else {
          const r = st.steering.step(pos, [tp[0], pos[1], tp[2]], dt)
          ctx.entity.position = r.position
        }
        return
      }

      // No target: wander near home.
      if (!st.wanderTarget || _dist2d(pos, st.wanderTarget) < WANDER_ARRIVE) {
        const ang = Math.random() * Math.PI * 2, r = Math.random() * WANDER_RADIUS
        st.wanderTarget = [st.home[0] + Math.cos(ang) * r, st.home[1], st.home[2] + Math.sin(ang) * r]
      }
      const step = st.steering.step(pos, st.wanderTarget, dt)
      ctx.entity.position = step.position
    },
  },
}

function _dist2d(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]) }

// Nearest LIVE player within aggro radius with clear LOS, or null. Distance-scored, not a full utility-AI
// weighted-consideration system (that's a real follow-on -- this is the honest first tier: "closest visible
// threat wins," which is already a functional, fair, and fun bot).
function _pickTarget(ctx) {
  const pos = ctx.entity.position
  let best = null, bestD = Infinity
  for (const p of ctx.players.getAll()) {
    if (!p.state || !p.state.position) continue
    if ((p.state.health ?? 100) <= 0) continue
    const d = Math.hypot(p.state.position[0] - pos[0], p.state.position[1] - pos[1], p.state.position[2] - pos[2])
    if (d > ctx.state.aggro || d >= bestD) continue
    if (!ctx.canSee([pos[0], pos[1] + 0.9, pos[2]], [p.state.position[0], p.state.position[1] + 0.9, p.state.position[2]], { maxDistance: ctx.state.aggro })) continue
    best = p.id; bestD = d
  }
  return best
}

function _onDeath(ctx) {
  // Bots respawn at home after a short delay rather than despawning -- keeps a placed bot as a
  // persistent world fixture (matching how tps-game respawns players) instead of a one-shot kill.
  ctx.state.health.respawn()
  ctx.entity.position = [...ctx.state.home]
  ctx.state.targetId = null
}
