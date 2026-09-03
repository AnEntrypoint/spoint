// server-scale-persistent-world-snapshot-restart-survival: periodic tick-budgeted full-world-state
// snapshot to ctx.storage (the already-constructed FSAdapter every server.js/WorkerEntry.js boot builds,
// see src/storage/FSAdapter.js) + a real restore-on-boot path, so a room survives a process restart --
// distinct from the ALREADY-SHIPPED ctx.placedModelStorage debounced persist (src/sdk/server.js), which
// only captures editor-authored placed-entity DEFINITIONS (model/position/app/custom at PLACE time), not
// the live simulation state a running world accumulates (dynamic body positions/velocities that have
// since moved under physics, app-owned custom/appState mutated by update()/onCollision, respawn/interact
// timer countdowns). Reuses the SAME two already-shipped, already-audited primitives named by this row's
// own guidance rather than re-deriving a third state-capture format:
//   - AppRuntime.snapshotGameState/restoreGameState (rollback-entity-gamestate-snapshot): JS-side entity
//     transform + custom + appState + timers, with its own audited safe/unsafe field list (see that
//     method's header comment in AppRuntime.js for the full audit -- this module inherits that audit
//     unchanged, it does not re-litigate which fields are safe to round-trip).
//   - PhysicsWorld.snapshotBodies/restoreBodies (rollback-netcode-ggpo-style-input-rollback): Jolt dynamic
//     body position/rotation/velocity/angularVelocity, keyed by the engine's internal body id.
//
// KEY DIFFERENCE from the in-process rollback use of these primitives: rollback restores into a world
// that never stopped running (the entities and their physics bodies already exist, restoreBodies just
// needs to find them by the SAME body id it saved). A restart is not that -- the process exited and a
// fresh boot rebuilds every entity via stageLoader.loadFromDefinition()+placed-models.json replay, which
// assigns FRESH Jolt body ids (World.js's own body-id counter starts over each process). So a body-id-
// keyed snapshot cannot be restored directly post-restart: this module re-keys physics state by ENTITY id
// (stable across restarts, unlike the raw Jolt body id) at snapshot time, and re-resolves entity id ->
// the entity's freshly-assigned _physicsBodyId at restore time before calling PhysicsWorld.restoreBodies
// with a body-id-keyed map assembled fresh from the live post-boot world.
//
// FORMAT/VERSIONING DECISION (this row's own open question #3): a flat {version, world, tick, savedAt,
// entities:[...], respawnTimers:[...], timers:[...], interactCooldowns:[...]} JSON document (Maps
// serialized to entry-arrays, since JSON has no Map type and FSAdapter round-trips via JSON.stringify/
// parse). `version` is a bare integer bumped only on a real incompatible shape change (matching the
// existing GLBTransformer.js/SnapshotEncoder.js precedent of an explicit format version rather than
// duck-typing); `world` is worldDef.name||process.env.WORLD, checked at restore time so a snapshot taken
// under one world def is never silently applied against a different one (e.g. an operator switching
// WORLD= between restarts) -- a mismatch is treated as "no snapshot", not a crash, since a stale/foreign
// snapshot is strictly worse than a fresh boot. A version or world mismatch degrades to a clean fresh-boot
// world, matching this codebase's own full->degraded->safe-fail discipline (never a silent corruption, never
// a hard crash over a stale save file). No cross-server-code-update FIELD migration exists yet (the sibling
// hot-reload migrate-function row this row's own detail text calls out as "connects to" is a distinct,
// larger scope: per-app data migration on a version bump) -- a version bump here means "discard and reboot
// clean", not "translate old shape to new", which is an honest, explicitly scoped-out follow-up.
export const WORLD_SNAPSHOT_FORMAT_VERSION = 1

function mapToEntries(m) { return m ? [...m.entries()] : [] }
function entriesToMap(e) { return new Map(e || []) }

// Builds the full persistable document from a live AppRuntime + PhysicsWorld. includeStatic:true is
// required here (unlike the in-process rollback default) -- a restart-survival snapshot must be able to
// restore a static prop an editor moved at runtime (placedModelStorage already covers PLACE-time position,
// but not a subsequent in-place drag that only mutated the live entity, not a re-PLACE), and the extra
// per-tick cost of including static entities is irrelevant here since this only runs once per
// AUTO_SAVE_INTERVAL (5 real minutes today), never per-tick.
export function buildWorldSnapshot(appRuntime, physics, worldName) {
  const game = appRuntime.snapshotGameState({ includeStatic: true })
  const entities = []
  for (const [id, s] of game.entities) {
    const e = appRuntime.entities.get(id)
    const bodyId = e && e._physicsBodyId !== undefined ? e._physicsBodyId : undefined
    let body = null
    if (bodyId !== undefined && physics && typeof physics.getBodyVelocity === 'function') {
      // Re-derive a fresh per-body dynamics read keyed by ENTITY id (not Jolt body id, which is not
      // restart-stable -- see module header). Only meaningful for a genuinely simulated body (dynamic/
      // kinematic); a static body's transform is already fully captured by s.position/s.rotation above,
      // and PhysicsWorld.snapshotBodies itself already skips static bodies for the identical reason.
      if (e.bodyType !== 'static') {
        body = {
          position: physics.getBodyPosition(bodyId),
          rotation: physics.getBodyRotation(bodyId),
          velocity: physics.getBodyVelocity(bodyId),
          angularVelocity: physics.getBodyAngularVelocity ? physics.getBodyAngularVelocity(bodyId) : [0, 0, 0]
        }
      }
    }
    entities.push({ id, ...s, body })
  }
  return {
    version: WORLD_SNAPSHOT_FORMAT_VERSION,
    world: worldName || null,
    tick: game.tick,
    savedAt: Date.now(),
    entities,
    respawnTimers: mapToEntries(game.respawnTimers),
    // _timers.fn is a live JS closure (the callback an app's ctx.addTimer captured) -- it cannot survive
    // a process restart (no closure serialization), unlike the in-process rollback use of this same
    // snapshot shape where `fn` is still the SAME live reference across a save/restore within one process.
    // Recording remaining/repeat/interval here with no `fn` field is intentionally NOT restored on the
    // read side either (see restoreWorldSnapshot below, which drops timers outright rather than restoring
    // a state that would throw "t.fn is not a function" the next time AppRuntimeTick's timer-drain calls
    // it) -- an honest, documented gap: a countdown timer in flight at snapshot time is lost on restart,
    // matching the same fail-loud-not-silently-wrong discipline this row's own guidance calls for over a
    // half-working restore. Kept in the written document (informational/debuggable) even though the
    // restore path ignores it, so an operator inspecting a snapshot file can see what was in flight.
    timers: mapToEntries(game.timers).map(([id, list]) => [id, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval }))]),
    interactCooldowns: mapToEntries(game.interactCooldowns)
  }
}

// Tick-budgeted write: builds the snapshot (a synchronous, bounded-by-live-entity-count JS walk -- no
// Jolt calls beyond the already-cheap per-dynamic-entity getBodyPosition/Rotation/Velocity reads, the
// SAME calls syncDynamicBody already performs every tick in production for every active dynamic body, so
// this adds no new per-body cost CLASS) then hands the write itself to storage.set(), which is already
// async (FSAdapter: temp-file write + atomic rename, matching placedModelStorage's own atomicity
// discipline) -- the actual disk I/O never blocks the tick that triggered it. Errors are caught and
// logged, never thrown into the tick loop (a failed periodic save must not crash a live server).
//
// server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: the build's real
// MAGNITUDE, not just its cost class, was measured live before deciding whether a tighter-than-5-minute
// cadence is safe. buildWorldSnapshot's own synchronous JS walk (measured via direct Node execution, real
// AppRuntime+PhysicsWorld, 5-run avg/max per scale): N=200 dynamic entities 2.4/3.2ms, N=1000 10.0/11.8ms,
// N=3000 21.6/25.6ms. Because saveWorldSnapshot is `async`, calling it (even fire-and-forget, uncaught by
// the caller) still runs its OWN body SYNCHRONOUSLY up to the first `await` -- so at N=3000 the prior
// version of this function genuinely blocked the calling tick for ~31ms (live-measured via the exact
// server.js onAutoSave() fire-and-forget call convention), not zero as the "I/O never blocks the tick"
// framing above implied (that framing is still correct for the DISK WRITE specifically, just not for the
// JS build that precedes it). Fix: yield to the event loop via setImmediate BEFORE calling
// buildWorldSnapshot, so the synchronous walk runs as its own macrotask after the current tick's
// synchronous work (and any pending I/O callbacks) have already had a chance to run, instead of stealing
// time from the tick that happened to cross the AUTO_SAVE_INTERVAL boundary. This does not change build
// cost, only WHEN it's paid -- a real, evidenced, low-risk improvement over "block whichever tick is
// unlucky enough to hit the modulo". CADENCE DECISION: given the measured magnitude (single-digit-to-
// low-tens of ms even at a 3000-entity stress scale, vs the 200ms-class overrun collider-streamer-fresh-
// territory-tick-stall treats as tick-loop-concerning), AUTO_SAVE_INTERVAL=300s is NOT tightened by this
// row -- a shorter interval multiplies this exact cost more often for a benefit (bounding the crash-loss
// window) that the ALREADY-IMMEDIATE graceful-shutdown flushAll() path already covers for the common
// (SIGINT/SIGTERM) case; only an ungraceful crash/power-loss is exposed to the up-to-5-minute window, and
// evidence-based guidance (not a guess) is that the setImmediate deferral is the correct, cheap
// improvement here, not a cadence change with no measured floor below which it stops being safe.
export async function saveWorldSnapshot(ctx) {
  const { appRuntime, physics, storage } = ctx
  if (!appRuntime || !storage) return false
  try {
    await new Promise(resolve => setImmediate(resolve))
    const worldName = ctx.currentWorldDef?.name || (typeof process !== 'undefined' ? process.env.WORLD : null) || null
    const snap = buildWorldSnapshot(appRuntime, physics, worldName)
    await storage.set('world-snapshot', snap)
    console.log(`[world-persistence] saved snapshot: tick=${snap.tick} entities=${snap.entities.length}`)
    return true
  } catch (e) {
    console.error('[world-persistence] save error:', e.message)
    return false
  }
}

// Restore-on-boot: MUST be called after stageLoader.loadFromDefinition()+placed-models.json replay have
// both finished spawning every entity (ServerAPI.js's loadWorld does this synchronously for world-def
// entities and the placed-model replay loop, both BEFORE this is invoked) -- restoreGameState/restoreBodies
// both use the "restore only what still exists live" defensive-membership discipline (see AppRuntime.js's
// restoreGameState header comment), so calling this before an entity has been (re)spawned silently drops
// that entity's saved state, not a crash but a real gap. A dynamic entity's physics body specifically needs
// its owning app's setup() to have already run addBody/addStaticTrimeshAsync -- autoTrimesh is fire-and-
// forget async (see AppRuntime.spawnEntity's own comment), so a body created via that path may not exist
// yet the instant stageLoader.loadFromDefinition() returns. server-scale-worldpersistence-async-trimesh-
// race-and-in-flight-flush-frequency closed the common-case version of this gap: ServerAPI.js's loadWorld
// now awaits appRuntime.waitForPendingTrimeshBuilds() (bounded, default 5s) between the spawn loops and
// this call, so every trimesh build already in flight at that point gets a real chance to settle its
// entity._physicsBodyId assignment before restoreBodies runs. This function's own defensive
// bodiesSkippedNotFound accounting stays as the honest residual-gap reporter for whatever the bounded wait
// still missed (a pathologically slow build past the timeout, or a body created by some other async path
// not routed through trackTrimeshBuild) -- never silently assumed zero. A version or world-name mismatch
// (or no snapshot at all -- first boot, or storage cleared) is a clean no-op: the world stays exactly as
// freshly booted.
export async function restoreWorldSnapshot(ctx) {
  const { appRuntime, physics, storage } = ctx
  if (!appRuntime || !storage) return { restored: false, reason: 'no-runtime' }
  let snap
  try { snap = await storage.get('world-snapshot') } catch (e) { console.error('[world-persistence] load error:', e.message); return { restored: false, reason: 'load-error' } }
  if (!snap) return { restored: false, reason: 'no-snapshot' }
  if (snap.version !== WORLD_SNAPSHOT_FORMAT_VERSION) {
    console.warn(`[world-persistence] snapshot format version mismatch (saved=${snap.version} current=${WORLD_SNAPSHOT_FORMAT_VERSION}) -- discarding, booting clean`)
    return { restored: false, reason: 'version-mismatch' }
  }
  const worldName = ctx.currentWorldDef?.name || process.env.WORLD || null
  if (snap.world !== worldName) {
    console.warn(`[world-persistence] snapshot world mismatch (saved="${snap.world}" current="${worldName}") -- discarding, booting clean`)
    return { restored: false, reason: 'world-mismatch' }
  }
  // Rehydrate the plain-array wire shape back into the Map shape restoreGameState expects.
  const entities = new Map()
  const bodySnap = new Map() // entity-scoped body-id -> body-state, assembled fresh against the LIVE post-boot world
  let bodiesRestored = 0, bodiesSkippedNotFound = 0
  for (const e of snap.entities) {
    const { id, body, ...s } = e
    entities.set(id, s)
    if (body) {
      const live = appRuntime.entities.get(id)
      const liveBodyId = live && live._physicsBodyId !== undefined ? live._physicsBodyId : undefined
      if (liveBodyId !== undefined) { bodySnap.set(liveBodyId, body); bodiesRestored++ }
      else bodiesSkippedNotFound++
    }
  }
  appRuntime.restoreGameState({
    tick: snap.tick,
    entities,
    respawnTimers: entriesToMap(snap.respawnTimers),
    // Deliberately NOT restoring snap.timers -- see buildWorldSnapshot's header comment on why a timer's
    // `fn` closure cannot survive a restart; passing an empty Map here is a correct, documented no-op
    // rather than restoring a `fn:null` state AppRuntimeTick's own timer-drain would throw calling.
    timers: new Map(),
    interactCooldowns: entriesToMap(snap.interactCooldowns)
  })
  if (physics && typeof physics.restoreBodies === 'function' && bodySnap.size) physics.restoreBodies(bodySnap)
  console.log(`[world-persistence] restored snapshot: tick=${snap.tick} entities=${entities.size} bodies=${bodiesRestored}${bodiesSkippedNotFound ? ` (skipped ${bodiesSkippedNotFound}, body not yet created)` : ''}`)
  return { restored: true, tick: snap.tick, entityCount: entities.size, bodiesRestored, bodiesSkippedNotFound }
}
