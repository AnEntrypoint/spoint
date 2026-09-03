import { CliDebugger } from '../debug/CliDebugger.js'
import { buildPhysicsAPI } from './AppPhysics.js'
import { vec3 as _vec3, vec4 as _vec4, vecOK } from '../shared/vecGuard.js'
import { defineGameFSM } from '../../apps/_lib/game-fsm.js'
import { defineGameMode } from '../../apps/_lib/gamemode.js'
import { createBuffStack } from '../../apps/_lib/buffs.js'
import { defineShrinkingZone } from '../../apps/_lib/shrinking-zone.js'
import { defineHealth } from '../../apps/_lib/health.js'
import { defineSteering } from '../../apps/_lib/steering.js'
import { defineCheckpoint } from '../../apps/_lib/checkpoint.js'
import { definePickup } from '../../apps/_lib/pickup.js'
import { createDestructible } from '../../apps/_lib/destructible.js'
import { createSoftbodyCloth } from '../../apps/_lib/softbody.js'
import { createFluidBody } from '../../apps/_lib/fluid.js'
import { createFluid3DBody } from '../../apps/_lib/fluid3d.js'
import { defineBuoyancy } from '../../apps/_lib/buoyancy.js'
import { defineTeams } from '../../apps/_lib/teams.js'
import { defineWeapon } from '../../apps/_lib/weapon.js'
import { definePlayerInventory } from '../../apps/_lib/inventory.js'
import { definePath } from '../../apps/_lib/path.js'

export class AppContext {
  constructor(entity, runtime) {
    this._entity = entity
    this._runtime = runtime
    this._state = entity._appState || {}
    entity._appState = this._state
    this._entityProxy = this._buildEntityProxy()
    this._debugger = new CliDebugger(`[${entity.id}]`)
    this._busScope = runtime._eventBus ? runtime._eventBus.scope(entity.id) : null
  }

  _buildEntityProxy() {
    const ent = this._entity
    const runtime = this._runtime
    const vec3 = _vec3, vec4 = _vec4
    return {
      get id() { return ent.id },
      get model() { return ent.model },
      get bodyType() { return ent.bodyType },
      get position() { return ent.position },
      set position(v) { ent.position = vec3(v, 'position') },
      get rotation() { return ent.rotation },
      set rotation(v) { ent.rotation = vec4(v, 'rotation') },
      get scale() { return ent.scale },
      set scale(v) { ent.scale = vec3(v, 'scale') },
      get velocity() { return ent.velocity },
      set velocity(v) { ent.velocity = vec3(v, 'velocity') },
      get custom() { return ent.custom },
      set custom(v) { if (v !== null && (typeof v !== 'object' || Array.isArray(v))) throw new TypeError('entity.custom must be null or a plain object'); ent.custom = v },
      get parent() { return ent.parent },
      get children() { return [...ent.children] },
      get worldTransform() { return runtime.getWorldTransform(ent.id) },
      destroy: () => runtime.destroyEntity(ent.id)
    }
  }

  get entity() { return this._entityProxy }

  get physics() { return this._physicsAPI || (this._physicsAPI = buildPhysicsAPI(this._entity, this._runtime)) }

  get world() {
    const runtime = this._runtime
    const parentId = this._entity.id
    const _childIds = this._state._childIds || (this._state._childIds = new Set())
    return {
      spawn: (id, cfg) => runtime.spawnEntity(id, cfg),
      spawnChild: (id, cfg) => {
        const e = runtime.spawnEntity(id, { ...cfg, parent: cfg?.parent ?? parentId })
        _childIds.add(id); return e
      },
      destroy: (id) => { _childIds.delete(id); runtime.destroyEntity(id) },
      attach: (eid, app) => runtime.attachApp(eid, app),
      detach: (eid) => runtime.detachApp(eid),
      reparent: (eid, parentId) => runtime.reparent(eid, parentId),
      query: (filter) => runtime.queryEntities(filter),
      getEntity: (id) => runtime.getEntity(id),
      nearby: (pos, radius) => runtime.nearbyEntities(pos, radius),
      // Addressed cross-entity message: deliver `msg` to ONLY that entity's app onMessage hook, instead of
      // the global bus fan-out where every app filters by id (tower->this-enemy, door<-this-button, boss<-phase).
      sendToEntity: (entityId, msg) => runtime.fireEvent?.(entityId, 'onMessage', msg),
      // Cross-entity physics: applies to an ARBITRARY entityId's body, not just this._entity
      // (ctx.physics.addForce/setVelocity are self-only, see AppPhysics.js buildPhysicsAPI).
      // Optional worldPoint applies the impulse off-centre for spin/torque (curveballs, kicks).
      applyImpulse: (entityId, impulse, worldPoint) => runtime.applyImpulseToEntity(entityId, impulse, worldPoint),
      setVelocity: (entityId, velocity) => runtime.setEntityVelocity(entityId, velocity),
      // Per-body gravity: 1 = normal, 0 = float, <0 = anti-gravity (gravity-flip puzzles, floaty props).
      setGravityFactor: (entityId, factor) => runtime.setEntityGravityFactor?.(entityId, factor),
      // Deactivate/reactivate a dynamic entity's Jolt body without destroying it -- the primitive a
      // pooled/instanced spawn pattern needs to genuinely PARK a reused entity (stop it simulating) while
      // it sits idle between uses, vs merely repositioning it (which reactivates and lets it keep falling
      // at the park position -- see apps/_lib/destructible.js's debris pool, the caller this was built for).
      setBodyActive: (entityId, active) => runtime.setEntityBodyActive?.(entityId, active),
      // Kinematic move: update an entity's authoritative position (+optional rotation) AND its collider,
      // so moving platforms / escorted VIPs / elevators carry their physics body with them.
      setPosition: (entityId, position, rotation) => runtime.setEntityPosition?.(entityId, position, rotation),
      // Constrain two entities' bodies. weld = rigid lock; joint({type:'point'|'distance'|'hinge',...}).
      // Returns a constraintId for removeConstraint. Enables welded constructs, vehicles, chains, doors.
      weld: (entityA, entityB, opts) => runtime.addEntityConstraint?.(entityA, entityB, { ...(opts || {}), type: 'fixed' }),
      joint: (entityA, entityB, opts) => runtime.addEntityConstraint?.(entityA, entityB, opts),
      removeConstraint: (constraintId) => runtime.removeConstraint?.(constraintId),
      // Cross-entity physics-LOD: flip an arbitrary entity's body motion type in place (dynamic-simulated
      // -> kinematic-frozen -> static -> despawn via world.destroy) and read its rest state, without the
      // caller owning that entity's own ctx (used by apps/_lib/destructible.js to LOD debris pieces it
      // spawned as separate child entities). See AppRuntimePhysics.js setEntityMotionType/isEntityAtRest.
      setMotionType: (entityId, motionType) => runtime.setEntityMotionType?.(entityId, motionType) ?? false,
      isAtRest: (entityId, eps) => runtime.isEntityAtRest?.(entityId, eps) ?? true,
      get gravity() { return runtime.gravity }
    }
  }

  get players() {
    const runtime = this._runtime
    return {
      getAll: () => runtime.getPlayers(),
      getById: (id) => runtime.getPlayerById(id) || runtime.getPlayers().find(p => p.id === id) || null,
      getNearest: (pos, r) => runtime.getNearestPlayer(pos, r),
      // Per-player message: reaches ONLY that client's app onEvent. This is the server side of a per-player
      // HUD -- push {hud:...} to one player here; the client app stashes it by playerId in onEvent and render()
      // reads it back via renderCtx.playerId (which is that viewer's own id). Score/turn/team panels, private prompts.
      send: (pid, msg) => runtime.sendToPlayer(pid, msg),
      broadcast: (msg) => runtime.broadcastToPlayers(msg),
      broadcastNearby: (pos, radius, msg) => {
        const r2 = radius * radius
        for (const p of runtime.getPlayers()) {
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0]-pos[0], dy = pp[1]-pos[1], dz = pp[2]-pos[2]
          if (dx*dx + dy*dy + dz*dz <= r2) runtime.sendToPlayer(p.id, msg)
        }
      },
      setPosition: (pid, pos) => runtime.setPlayerPosition(pid, pos),
      // Server-authoritative display name (killfeed, winner announce, turn labels, save-game keys).
      // Read via getById(pid).name (defaults to "Player <id>"); set here.
      setName: (pid, name) => runtime.setPlayerName?.(pid, name),
      // Per-player appearance: {tint (hex 0xRRGGBB or null), nameTag}. Stored on the player + broadcast so
      // every client tints that player's mesh + shows a nameplate -- team/class colours, friend/foe labels.
      setAppearance: (pid, appearance) => runtime.setPlayerAppearance?.(pid, appearance),
      // Per-player MODEL swap: replace one player's whole avatar with a VRM/GLB at `url` (skins, unlockable
      // characters, team models, boss transform). Broadcast so every client rebuilds that player's mesh; the
      // player's transform/state is preserved. Heavier than setAppearance's tint -- use for real model changes.
      setModel: (pid, url) => runtime.setPlayerModel?.(pid, url),
      // Server-authoritative equipped-weapon signal (animation-weapon-signal-clientside-wiring): `name`
      // is one of src/shared/WeaponCodes.js's registered weapon names (e.g. 'Pistol'/'Rifle'). Rides the
      // per-tick snapshot wire (not a one-off broadcast like setAppearance/setModel above) so every
      // client's tickPlayerAnimators reads it every frame off the live player track and calls
      // anim.setWeapon(name) -- the entrypoint animation-aim-ik-camera-pitch-layer already built.
      setWeapon: (pid, name) => runtime.setPlayerWeapon?.(pid, name),
      // overrides shallow-merges over the world's base movement config (e.g. {maxSpeed, jumpImpulse}); pass null to clear
      setMovementOverride: (pid, overrides) => runtime.setPlayerMovementOverride(pid, overrides),
      // Server-authoritative lifecycle: 'alive'|'frozen'|'spectator'. 'frozen' neutralizes that client's input,
      // 'spectator' also switches it to a spectate follow-cam (opts.spectateTarget). Elimination / freeze-tag / musical-chairs.
      setLifecycle: (pid, state, opts) => runtime.setPlayerLifecycle?.(pid, state, opts),
      // Force an animation clip on a player's avatar (dance/emote/stagger/death pose). opts.loop/opts.fade.
      playAnimation: (pid, clip, opts) => runtime.playPlayerAnimation?.(pid, clip, opts),
      // Attach an entity so it follows this player each tick at `offset` (flag carry, escorted object, held tool).
      attachEntity: (pid, entityId, offset) => runtime.attachEntityToPlayer?.(entityId, pid, offset),
      detachEntity: (entityId) => runtime.detachEntityFromPlayer?.(entityId),
      // Player-vs-player contact: cb(playerIdA, playerIdB) fires once per tick for every unordered pair of
      // connected players within radius of each other. ONE shared quadratic pair scan for all apps -- the
      // primitive tag/freeze-tag/sumo/dodgeball/hot-potato need, instead of each hand-rolling its own O(n^2)
      // loop. Returns an unsub. Re-calling replaces this app's watch (keyed by the owning entity's app id).
      onPlayerContact: (radius, cb) => {
        if (typeof cb !== 'function') throw new TypeError('[AppContext] onPlayerContact: callback must be a function')
        return runtime.registerPlayerContactWatch(this._entity.id, radius, cb)
      },
      // Nearest OTHER player to the given player (excludes self), within radius; null if none. Convenience over
      // getNearest(pos,r) for the common "who is closest to me" query without re-fetching self's position.
      nearestOtherPlayer: (playerId, radius) => {
        const me = runtime.getPlayerById(playerId) || runtime.getPlayers().find(p => p.id === playerId)
        const pos = me?.state?.position; if (!pos) return null
        const r2 = radius * radius; let best = null, bestD = r2
        for (const p of runtime.getPlayers()) {
          if (p.id === playerId) continue
          const pp = p.state?.position; if (!pp) continue
          const dx = pp[0]-pos[0], dy = pp[1]-pos[1], dz = pp[2]-pos[2], d = dx*dx+dy*dy+dz*dz
          if (d < bestD) { bestD = d; best = p }
        }
        return best
      }
    }
  }

  get time() {
    const runtime = this._runtime
    const entityId = this._entity.id
    return {
      get tick() { return runtime.currentTick },
      get deltaTime() { return runtime.deltaTime },
      get elapsed() { return runtime.elapsed },
      // Authoritative server wall-clock (ms). Apps run server-side so this IS the synced clock every
      // client shares -- broadcast it (or a beat phase derived from it) for rhythm/timed-round games.
      get serverTime() { return Date.now() },
      after: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, false),
      every: (seconds, fn) => runtime.addTimer(entityId, seconds, fn, true)
    }
  }

  // config overlays the entity's authored `custom` bag over its spawn-time `_config`. The editor's
  // editorProps edits land in entity.custom (EditorHandlers applies changes.custom), so overlaying it
  // here makes a value tuned in the editor readable through ctx.config with NO per-app custom->config
  // plumbing -- the boilerplate the editorProps system was supposed to hide. Engine-internal custom
  // keys (leading underscore: _collider/_interior/_interactable/etc.) are excluded so they never leak
  // into an app's config namespace. Pair with ctx.onConfigChange to react to a live edit.
  get config() {
    const base = this._entity._config || {}
    const custom = this._entity.custom
    if (!custom || typeof custom !== 'object') return base
    const out = { ...base }
    for (const k in custom) { if (k.charCodeAt(0) !== 95) out[k] = custom[k] }   // skip '_'-prefixed engine keys
    return out
  }

  // Fires (config) whenever the entity's authored config changes (an editor editorProps edit). Lets an
  // app re-derive setup-time state live instead of hand-rolling an onEditorUpdate custom->config mirror.
  onConfigChange(cb) {
    if (typeof cb !== 'function') throw new TypeError('[AppContext] onConfigChange: cb must be a function')
    const set = this._configListeners || (this._configListeners = new Set())
    set.add(cb)
    return () => set.delete(cb)
  }

  _fireConfigChange() {
    if (!this._configListeners) return
    const cfg = this.config
    for (const cb of this._configListeners) { try { cb(cfg) } catch (e) { this._debugger?.warn?.('onConfigChange handler threw: ' + e.message) } }
  }

  // Registers an async (or sync) callback to run on graceful server shutdown (SIGINT/SIGTERM, see
  // src/sdk/server.js boot()). This is the generic registry a debounced-write app (e.g.
  // apps/tps-game/server.js flushScoreboard) uses to guarantee its pending write survives a process
  // kill, instead of the engine hardcoding a per-app list of known flush functions. Mirrors the
  // registration-primitive shape of onConfigChange above. Returns an unsubscribe function.
  onShutdown(cb) {
    if (typeof cb !== 'function') throw new TypeError('[AppContext] onShutdown: cb must be a function')
    return this._runtime.registerShutdownHook(cb)
  }

  get state() { return this._state }
  set state(v) { Object.assign(this._state, v) }

  get network() {
    const runtime = this._runtime
    return {
      broadcast: (msg) => runtime.broadcastToPlayers(msg),
      sendTo: (id, msg) => runtime.sendToPlayer(id, msg)
    }
  }

  get lagCompensator() { return this._runtime._lagCompensator || null }

  get bus() { return this._busScope }

  // Direct write access to the server's EventLog (src/netcode/EventLog.js), the same durable ring buffer
  // AppRuntime._log uses internally for entity_spawn/entity_destroy/bus_event/app_error records. Exposed here
  // so an app can record its OWN domain events (e.g. a resolved hit-registration audit record: attacker,
  // target, rewound position, hitbox, timestamp) alongside the engine's own events, queryable later via
  // ctx.eventLog.query({type:...}) for kill-cam/hit-debug replay. record(type, data, meta) auto-stamps
  // id/timestamp/tick; meta.actor/reason/context/sourceApp/sourceEntity/causalEventId are first-class fields.
  get eventLog() { return this._runtime._eventLog || null }

  get storage() {
    const runtime = this._runtime
    const entity = this._entity
    const ns = entity._appName || entity.id
    if (!runtime._storage) return null
    const adapter = runtime._storage
    return {
      get: (key) => adapter.get(`${ns}/${key}`),
      set: (key, value) => adapter.set(`${ns}/${key}`, value),
      delete: (key) => adapter.delete(`${ns}/${key}`),
      list: (prefix = '') => adapter.list(`${ns}/${prefix}`),
      has: (key) => adapter.has(`${ns}/${key}`)
    }
  }

  get debug() { return this._debugger }

  interactable(config = {}) {
    const ent = this._entity
    if (config.radius != null && (typeof config.radius !== 'number' || !Number.isFinite(config.radius) || config.radius < 0)) throw new TypeError('interactable: radius must be a non-negative finite number')
    if (config.cooldown != null && (typeof config.cooldown !== 'number' || !Number.isFinite(config.cooldown) || config.cooldown < 0)) throw new TypeError('interactable: cooldown must be a non-negative finite number')
    const radius = config.radius ?? 3
    const prompt = config.prompt ?? 'Press E'
    const cooldown = config.cooldown ?? 500
    ent._interactable = true
    ent._interactRadius = radius
    ent._interactCooldown = cooldown
    if (!ent.custom) ent.custom = {}
    ent.custom._interactable = { prompt, radius }
    this._runtime._interactableIds.add(ent.id)
  }

  // callback(entityId-owning-ctx, playerId) fires once per tick per player within radius of this.entity.
  // Returns an unsubscribe function. Replaces a hand-rolled per-app O(n) nearest-player distance scan.
  onPlayerProximity(radius, callback) {
    if (typeof callback !== 'function') throw new TypeError('[AppContext] onPlayerProximity: callback must be a function')
    const self = this
    return this._runtime.registerProximityWatch(this._entity.id, radius, (playerId) => callback(self, playerId))
  }

  // Registers a zero-arg cleanup callback to run when this entity's app is detached (destroyEntity,
  // hot-reload reattach, editor detach -- anywhere AppRuntime.detachApp fires, which already always
  // runs on entity teardown). Component factories that allocate a slot in a shared pool (e.g.
  // health.js's ComponentPool-backed DOD storage) register their slot-release here so a churny
  // spawn/despawn loop (wave-defense bots, respawning pickups) doesn't leak pool slots -- this is the
  // ONE always-fired per-entity lifecycle hook available (apps themselves have no per-instance
  // disposal callback of their own; `teardown` is per-APP, this is per-CALLER-OF-A-DEFINE*-FACTORY).
  _registerDisposer(fn) {
    if (typeof fn !== 'function') return
    (this._disposers || (this._disposers = [])).push(fn)
  }

  // Runs + clears every registered disposer exactly once. Called by AppRuntime.detachApp alongside the
  // existing `teardown` call, before ctx is dropped.
  _runDisposers() {
    const d = this._disposers
    if (!d || d.length === 0) return
    this._disposers = null
    for (const fn of d) { try { fn() } catch (e) { console.error('[AppContext] disposer error:', e?.message || e) } }
  }

  _teardownChildren() {
    const ids = this._state._childIds
    if (!ids) return
    for (const id of [...ids]) this._runtime.destroyEntity(id)
    ids.clear()
  }

  defineGameFSM(spec) { return defineGameFSM(spec, this) }

  defineGameMode(spec) { return defineGameMode(spec, this) }

  defineBuffStack(spec) { return createBuffStack(spec, this) }

  defineShrinkingZone(spec) { return defineShrinkingZone(spec, this) }

  defineHealth(spec) { return defineHealth(spec, this) }

  defineSteering(spec) { return defineSteering(spec, this) }

  defineCheckpoint(spec) { return defineCheckpoint(spec, this) }

  definePickup(spec) { return definePickup(spec, this) }

  defineDestructible(spec) { return createDestructible(spec, this) }

  defineSoftbody(spec) { return createSoftbodyCloth(spec, this) }

  defineFluid(spec) { return createFluidBody(spec, this) }

  defineFluid3D(spec) { return createFluid3DBody(spec, this) }

  defineBuoyancy(spec) { return defineBuoyancy(spec, this) }

  defineTeams(spec) { return defineTeams(spec, this) }

  defineWeapon(spec) { return defineWeapon(spec, this) }

  definePlayerInventory(spec) { return definePlayerInventory(spec, this) }

  definePath(points) { return definePath(points) }

  raycast(origin, direction, maxDistance = 1000, excludeBodyId = null) {
    if (this._runtime._physics) {
      const r = this._runtime._physics.raycast(origin, direction, maxDistance, excludeBodyId)
      // Attribute the hit to an entity: apps get {hit, distance, position, normal, bodyId, entityId}
      // so any shoot/click/grab-a-target game can identify WHAT was hit, not just where.
      if (r && r.hit && r.bodyId != null && this._runtime._physicsBodyToEntityId) {
        r.entityId = this._runtime._physicsBodyToEntityId.get(r.bodyId) ?? null
      } else if (r) r.entityId = null
      return r
    }
    return { hit: false, distance: maxDistance, body: null, bodyId: null, normal: null, position: null, entityId: null }
  }

  // Line-of-sight test: is `toPos` visible from `fromPos` with nothing solid in between? Casts a ray from
  // A toward B and passes if the first hit is at/beyond B (or nothing is hit). The primitive stealth vision
  // cones, hide-and-seek detection, and red-light-green-light "is the mover in view" checks all need.
  // opts.excludeBodyId skips a body (e.g. the looker's own). opts.tolerance (default 0.5m) absorbs the case
  // where the ray hits the target's own collider slightly short of its centre.
  canSee(fromPos, toPos, opts = {}) {
    if (!vecOK(fromPos, 3) || !vecOK(toPos, 3)) return false
    const dx = toPos[0] - fromPos[0], dy = toPos[1] - fromPos[1], dz = toPos[2] - fromPos[2]
    const dist = Math.hypot(dx, dy, dz)
    if (dist < 1e-4) return true                                   // same point
    if (opts.maxDistance != null && dist > opts.maxDistance) return false
    const dir = [dx / dist, dy / dist, dz / dist]
    const r = this.raycast(fromPos, dir, dist, opts.excludeBodyId ?? null)
    if (!r || !r.hit) return true                                 // nothing blocks the line
    const tol = opts.tolerance != null ? opts.tolerance : 0.5
    // Clear if the first thing hit IS the target (matching entity) or lies at/beyond the target distance.
    if (opts.targetEntityId != null && r.entityId === opts.targetEntityId) return true
    return r.distance >= dist - tol
  }

  get terrainBodyId() { return this._runtime._physics?.getTerrainBodyId() ?? null }

  terrainHeightAt(x, z) {
    return this._runtime._physics?.terrainHeightAt(x, z) ?? null
  }

  terrainKindAt(x, z) {
    return this._runtime._physics?._terrainStreamer?.splineCarve?.kindAt(x, z) ?? null
  }

  navCostAt(x, z) {
    const kind = this.terrainKindAt(x, z)
    if (kind === 'road') return 0.5
    if (kind === 'river') return 3
    return 1
  }

  // Real per-world sea-level Y, in the SAME local scene-space entity.position[1]/terrainHeightAt already
  // use. Reuses the identical formula the client's underwater fog-tint shader splices in at terrain-ready
  // (client/core/UnderwaterTint.js setSeaLevelY, fed by client/app.js: `(f.offsetY||0) - (f.anchorHeight||0)`)
  // -- NOT a re-derived/new constant. frame is PlanetFrame.js's createPlanetFrame() result, stored
  // server-side on the physics world by TerrainPhysics.js's setupTerrainStreaming (World.js
  // setTerrainHeightSource(fn, frame, offsetY) -> this._planetFrame = frame). null when no terrain/frame
  // is streaming (e.g. a flat test world), so callers must treat null as "no water".
  get seaLevel() {
    const frame = this._runtime._physics?._planetFrame
    if (!frame || !Number.isFinite(frame.offsetY) || !Number.isFinite(frame.anchorHeight)) return null
    return frame.offsetY - frame.anchorHeight
  }

  get terrain() {
    const runtime = this._runtime
    return {
      startStreaming: async (tcfg) => {
        const physics = runtime._physics, playerManager = runtime._playerManager
        if (!physics || !playerManager) return null
        const { setupTerrainStreaming } = await import('../terrain/TerrainPhysics.js')
        return setupTerrainStreaming({ physics, playerManager, terrain: tcfg })
      }
    }
  }
}
