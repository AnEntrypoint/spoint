import { AppContext } from './AppContext.js'
import { HotReloadQueue } from './HotReloadQueue.js'
import { EventBus } from './EventBus.js'
import { createEcsEntityMap } from './EcsEntityMap.js'
import { mulQuat, rotVec } from '../math.js'
import { MSG } from '../protocol/MessageTypes.js'
import { SpatialIndex } from '../spatial/Octree.js'
import { vecOK } from '../shared/vecGuard.js'
import { weaponNameToCode } from '../shared/WeaponCodes.js'
import { mixinPhysics } from './AppRuntimePhysics.js'
import { mixinTick } from './AppRuntimeTick.js'
import { installCustomVersion } from './CustomVersion.js'
import { resolveCCD } from './AppPhysics.js'

import { containedAssetPath, tagAppState, untagAppState, _existsSync, _resolve } from './AppRuntimeState.js'

export class AppRuntime {
  constructor(c = {}) {
    this.entities = createEcsEntityMap(); this.apps = new Map(); this.contexts = new Map(); this._updateList = []; this._staticVersion = 0; this._dynamicEntityIds = new Set(); this._staticEntityIds = new Set()
    this.gravity = c.gravity || [0, -9.81, 0]
    this.currentTick = 0; this.deltaTime = 0; this.elapsed = 0
    this._playerManager = c.playerManager || null; this._physics = c.physics || null; this._physicsIntegration = c.physicsIntegration || null
    this._connections = c.connections || null; this._stageLoader = c.stageLoader || null
    this._nextEntityId = 1; this._appDefs = new Map(); this._timers = new Map(); this._interactCooldowns = new Map(); this._respawnTimer = new Map()
    this._activeDynamicIds = new Set(); this._sleepingDynamicIds = new Set(); this._physicsBodyToEntityId = new Map(); this._suspendedEntityIds = new Set(); this._pendingTrimeshEntities = new Map()
    this._physicsLODRadius = c.physicsRadius || 0; this._lagCompensator = c.lagCompensator || null
    // Global active-Jolt-body cap (0 = unlimited): see _enforceBodyBudget in AppRuntimePhysics.js. Sized so a
    // busy shard's physics.step(dt) cost stays bounded regardless of how many dynamic entities exist total --
    // only the budget's-worth nearest any player stay simulated, the rest sleep (proximity-priority, farthest first).
    this._physicsBodyBudget = c.physicsBodyBudget || 0
    const serverTickRate = c.tickRate || 64, entityTickRate = c.entityTickRate || serverTickRate
    this._entityTickDivisor = Math.max(1, Math.round(serverTickRate / entityTickRate)); this._physicsLODInterval = Math.max(1, Math.round(serverTickRate / 2))
    this._playerIndex = new SpatialIndex(); this._collisionEntities = []; this._interactableIds = new Set(); this._playerIndexIds = new Set()
    this._proximityWatches = new Map() // entityId -> {radius, callback, insidePlayerIds:Set}
    this._playerContactWatches = new Map() // appId -> {radius2, callback} -- player-vs-player pair contact
    this._attachments = new Map() // entityId -> {playerId, offset} -- entity follows a player each tick (flag carry, held tool)
    this._shutdownHooks = new Set() // registered via AppContext.onShutdown -- see runShutdownHooks below
    // Entities whose app.server.setup(ctx) is still in flight (awaited async work, e.g. tps-game's
    // loadScoreboard fs read) -- see _attachApp/fireEvent/_flushPendingEvents. apps.set(entityId,...)
    // happens SYNCHRONOUSLY before `await setup(ctx)` (must, so hasApp()/getSceneGraph() are correct
    // immediately), but that means a fireEvent (onMessage/onInteract/onCollision) reaching this entity
    // before its own setup() resolves would run the handler against a ctx.state that setup() hasn't
    // finished populating yet -- e.g. apps/tps-game/index.js's onMessage does ctx.state.ammo.set(...)
    // but ctx.state.ammo is only assigned AFTER setup's `await loadScoreboard(ctx)`. A fast-connecting
    // client's player_join (ServerHandlers.onClientConnect fires it for every currently-attached app,
    // synchronously, right after the world's entities are spawned at boot) can genuinely win this race
    // in production, not just in a contrived test -- boot()'s `await server.loadWorld(worldDef)` only
    // awaits the SYNCHRONOUS spawn loop, never the fire-and-forget _attachApp promises it kicks off, so
    // httpServer.listen() can start accepting connections while setup() is still pending. Queuing (not
    // dropping) is required: a genuine early player_join getting silently discarded would still be a
    // real gameplay bug (the joining player misses their ammo/stat initialization).
    this._pendingSetupIds = new Set()
    this._pendingSetupQueues = new Map() // entityId -> [{en, a}] queued fireEvent calls, replayed once setup resolves
    this._lastSyncMs = 0; this._lastRespawnMs = 0; this._lastSpatialMs = 0; this._lastCollisionMs = 0; this._lastInteractMs = 0; this._lastProximityMs = 0
    // rollback-entity-population-rewind: queued spawn/destroy requests made while _resimSuppressed is
    // true -- see setResimSuppressed/_flushDeferredPopulationOps below for the full defer-until-final-pass
    // design.
    this._deferredPopulationOps = []; this._resimSuppressed = false
    // rollback-population-inflight-async-commitment-at-suppression-start: population ops that were
    // ALREADY in async flight (an _attachApp setup() await, an autoTrimesh/addTrimeshCollider
    // addStaticTrimeshAsync await) before a suppression window opened are NOT caught by the
    // spawnEntity/destroyEntity gate above -- that gate only inspects _resimSuppressed at CALL time, and
    // these commitments already passed that check on their original (pre-suppression) call. Their
    // eventual .then()/finally mutation (apps.set/contexts.set, entity._physicsBodyId assignment) must
    // instead be checked again at RESOLUTION time -- see _deferOrRun below, the single choke point every
    // such continuation now routes through.
    this._deferredCommitmentOps = []
    // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: real in-flight-promise
    // tracking for every trimesh build kicked off via spawnEntity's autoTrimesh path or AppPhysics.js's
    // addTrimeshCollider (the two Node addStaticTrimeshAsync call sites) -- see trackTrimeshBuild/
    // waitForPendingTrimeshBuilds below. This is a Set of the raw promises themselves (not a bare count),
    // so waitForPendingTrimeshBuilds can Promise.allSettled the exact live set at call time regardless of
    // how many builds start/finish concurrently while it's awaiting.
    this._pendingTrimeshBuilds = new Set()
    mixinPhysics(this); mixinTick(this); if (this._physics) this._registerPhysicsCallbacks()
    this._hotReload = new HotReloadQueue(this); this._eventBus = c.eventBus || new EventBus()
    // server-scale-hotreload-migrate-function-tick-fenced: per-app-name hot-reload version counter,
    // consulted+bumped by HotReloadQueue._execute (the ONE place a live-entity reload happens, never
    // the boot-time registerApp() call below) so an app's optional migrate(oldState,from,to) export
    // sees monotonic version numbers scoped to real reloads only.
    this._appVersions = new Map()
    this._eventLog = c.eventLog||null; this._storage = c.storage||null; this._sdkRoot = c.sdkRoot||null
    this._snapshotCache = null; this._snapshotVersion = 0; this._entityVersions = new Map()
    this._eventBus.on('*', ev => { if (!ev.channel.startsWith('system.')) this._log('bus_event', { channel:ev.channel, data:ev.data }, ev.meta) })
    this._eventBus.on('system.handover', ev => { const {targetEntityId,stateData}=ev.data||{}; if (targetEntityId) this.fireEvent(targetEntityId,'onHandover',ev.meta.sourceEntity,stateData) })
  }

  resolveAssetPath(p) {
    if (!p) return p
    // non-Node (Worker, no fs): must return an origin-absolute path or fetch() resolves against the worker script's own URL, not the page origin
    if (!_resolve) { const rel = p.startsWith('./') ? p.slice(1) : p; return rel.startsWith('/') ? rel : '/' + rel }
    const cwdRoot = _resolve(process.cwd())
    const local = _resolve(p)
    if (_existsSync(local)) {
      const contained = containedAssetPath(local, cwdRoot)
      if (!contained) { console.warn(`[AppRuntime] resolveAssetPath rejected '${p}' -- resolves outside the server root`); return null }
      return contained
    }
    if (this._sdkRoot) {
      const sdk = _resolve(this._sdkRoot, p)
      if (_existsSync(sdk)) {
        const contained = containedAssetPath(sdk, _resolve(this._sdkRoot))
        if (!contained) { console.warn(`[AppRuntime] resolveAssetPath rejected '${p}' -- resolves outside the SDK root`); return null }
        console.debug(`[SDK-DEFAULT] using bundled asset: ${p}`)
        return contained
      }
    }
    return local
  }

  registerApp(name, appDef) { this._appDefs.set(name, appDef) }

  // Generic graceful-shutdown registry: any app's setup(ctx) can call ctx.onShutdown(fn) to guarantee
  // fn runs (and is awaited) before the process actually exits on SIGINT/SIGTERM -- see src/sdk/server.js
  // boot()'s signal handler, which calls runShutdownHooks() below alongside ctx.placedModelStorage.flush().
  // This is what lets apps/tps-game/server.js's flushScoreboard (a debounced write, same shape as
  // placedModelStorage.persist) actually run on shutdown without the engine hardcoding a per-app list.
  // Returns an unsubscribe function, matching every other AppContext registration primitive
  // (onConfigChange, onPlayerProximity, onPlayerContact).
  registerShutdownHook(cb) {
    this._shutdownHooks.add(cb)
    return () => this._shutdownHooks.delete(cb)
  }

  // Awaits every registered shutdown hook. Uses allSettled (not Promise.all) so one hook throwing/
  // rejecting never prevents the others from running -- a bad app's shutdown bug must not eat another
  // app's pending write. Each rejection is logged individually so the failure is visible, not swallowed.
  async runShutdownHooks() {
    if (this._shutdownHooks.size === 0) return
    const hooks = [...this._shutdownHooks]
    const results = await Promise.allSettled(hooks.map(fn => fn()))
    results.forEach((r, i) => { if (r.status === 'rejected') console.error('[shutdown] hook error:', r.reason?.message || r.reason) })
  }

  // rollback-entity-population-rewind: the DEFER design named as the simpler alternative in that row's
  // own PRD detail, chosen over a full spawn/destroy UNDO because undoing an already-run spawn interacts
  // with genuinely async work (_attachApp's awaited setup(), autoTrimesh's awaited addStaticTrimeshAsync)
  // in ways a synchronous rewind cannot cleanly reverse -- reversing a HALF-CONSTRUCTED spawn (setup()
  // still in flight) would mean tearing down an entity whose app context may not exist yet, or racing the
  // in-flight setup() promise's own eventual _pendingSetupIds cleanup. Deferring sidesteps the whole
  // problem: population changes requested DURING a suppressed resimulate pass (see setResimSuppressed)
  // never actually happen while suppressed at all, so there is nothing async-in-flight to undo if a LATER
  // correction supersedes this pass -- they are queued verbatim and replayed, in original call order,
  // exactly once resimulation settles (setResimSuppressed(false), the same "final pass" moment
  // RollbackLoop.resimulateFrom already uses to unsuppress network/EventLog output). This closes the
  // "must not resurrect a since-destroyed entity nor leave a since-spawned one live after a corrective
  // resimulate" gap the sibling rollback-entity-gamestate-snapshot row's same-membership-only restore
  // discipline deliberately left open (see that row's own UNSAFE/excluded audit above).
  //
  // WHY THIS IS SOUND: a resimulate pass exists to replay [fromTick+1, toTick] against corrected input --
  // by construction those ticks already ran once (with a locally-predicted guess) before being discarded.
  // If a real app's update()/onMessage() during those ticks calls ctx.world.spawn/destroy (or the
  // equivalent runtime.spawnEntity/destroyEntity), running it immediately during a SUPPRESSED pass would:
  // (a) resurrect/mutate world population using state that a still-in-flight EARLIER pass over an
  // overlapping range might supersede again (the exact multi-pass hazard rollback-resimulate-duplicate-
  // emission-suppression's own header comment documents for network/EventLog output -- population changes
  // are the same class of hazard, just for entities.set()/entities.delete() instead of a wire send), and
  // (b) fire real side effects (async fetches, physics-body creation) for a population change that may
  // never need to have happened at all once a later correction changes what the FINAL pass's ticks decide.
  // Deferring until the final (unsuppressed) pass means only the LAST, authoritative resimulate's
  // spawn/destroy decisions ever actually execute -- correct-by-construction, no undo machinery needed.
  //
  // Queue is FIFO and entityId-oblivious to insertion order (a destroy queued for an id a QUEUED spawn
  // hasn't created yet is a real possible sequence -- e.g. spawn-then-immediately-destroy within the same
  // suppressed window -- replay preserves original relative order so this resolves identically to how it
  // would have run unsuppressed). Initialized in the constructor (this._deferredPopulationOps = []),
  // matching every other collection field's own init-in-constructor discipline in this class.
  _deferPopulationOp(kind, args) {
    this._deferredPopulationOps.push({ kind, args })
  }

  // Replays every queued spawn/destroy in original order through the REAL runtime methods (not a
  // suppressed re-entry -- setResimSuppressed(false) always runs before this is called, see that method's
  // own call site below, so a spawnEntity queued here that itself has config.app will attach + await
  // setup() normally, exactly as if it had run live and unsuppressed the first time). Returns the count
  // flushed, for a caller/test to assert against.
  _flushDeferredPopulationOps() {
    if (!this._deferredPopulationOps.length) return 0
    const ops = this._deferredPopulationOps
    this._deferredPopulationOps = []
    for (const { kind, args } of ops) {
      if (kind === 'spawn') this.spawnEntity(...args)
      else if (kind === 'destroy') this.destroyEntity(...args)
    }
    return ops.length
  }

  // Discards every queued op without executing it -- for a caller that decides a suppressed pass's
  // intents are moot (e.g. tearing down a rollback session entirely). Not used by the default
  // suppress/unsuppress flow above (which always flushes), kept as an explicit escape hatch matching the
  // same discipline setResimSuppressed's own header comment names for network suppression's "no fire-and-
  // forget default" rule -- a caller that wants to drop queued population ops must say so explicitly.
  _discardDeferredPopulationOps() {
    const n = this._deferredPopulationOps.length
    this._deferredPopulationOps = []
    return n
  }

  // rollback-population-inflight-async-commitment-at-suppression-start: the RESOLUTION-time counterpart to
  // _deferPopulationOp's CALL-time gate. An async population commitment (an _attachApp setup() await, an
  // autoTrimesh/addTrimeshCollider addStaticTrimeshAsync await) that was already running when
  // setResimSuppressed(true) opened a suppression window is invisible to spawnEntity/destroyEntity's own
  // gate -- it already passed that check before suppression started. Left unhandled, its eventual mutation
  // (apps.set/contexts.set in _attachApp, entity._physicsBodyId assignment in the trimesh success/fallback
  // path) would land DURING a suppressed resimulate pass, exactly the same "an earlier, possibly-superseded
  // pass's population decision survives a later correction" hazard _deferPopulationOp already closes for
  // fresh spawn/destroy calls -- just reached from the async-resolution side instead of the call side.
  //
  // Every such continuation (never the async work itself -- cancelling/aborting an in-flight setup() or
  // addStaticTrimeshAsync call is out of scope, matching the sibling row's own documented reasoning: tearing
  // down a half-constructed entity mid-await is a harder problem than deferring its RESULT) routes its final
  // mutation through this one choke point instead of applying it directly. If the runtime is suppressed
  // *at the moment the async work resolves*, `fn` is queued (FIFO, alongside _deferredPopulationOps'
  // discipline) and replayed once setResimSuppressed(false) fires the same flush this class already performs
  // for fresh calls; otherwise `fn` runs immediately, matching what happens today when nothing is suppressed.
  // Checking suppression state at RESOLUTION time (not the generation the work was kicked off under) is
  // deliberately conservative: a commitment that started before suppression and resolves mid-suppression is
  // exactly the race this row exists to close, and a commitment that resolves after unsuppression again
  // (suppression opened and closed entirely while it was in flight) is correctly let through immediately --
  // there is no "later pass" left to supersede it once the runtime is back to unsuppressed/live.
  _deferOrRun(fn) {
    if (this._resimSuppressed) { this._deferredCommitmentOps.push(fn); return }
    fn()
  }

  // Replays every queued in-flight-commitment continuation, in original resolution order, exactly once
  // unsuppression fires -- same call site as _flushDeferredPopulationOps (setResimSuppressed's true->false
  // transition), run AFTER it so a commitment whose entity was itself only deferred-spawned this same flush
  // (see _flushDeferredPopulationOps) already exists in this.entities/this.apps by the time its continuation
  // replays. Each queued fn is a closure that re-checks its own entity's liveness before mutating (see call
  // sites in _attachApp/spawnEntity/AppPhysics.js) so a commitment for an entity destroyed in the meantime
  // is a safe no-op, not a crash on a since-deleted entity.
  _flushDeferredCommitmentOps() {
    if (!this._deferredCommitmentOps.length) return 0
    const ops = this._deferredCommitmentOps
    this._deferredCommitmentOps = []
    for (const fn of ops) fn()
    return ops.length
  }

  // Registers `promise` (a live addStaticTrimeshAsync in flight) in _pendingTrimeshBuilds and auto-removes
  // it on settle -- call this at the SAME call site the promise is created, alongside its existing .then/
  // .catch chain (see spawnEntity's autoTrimesh block and AppPhysics.js's addTrimeshCollider), never instead
  // of them. Returns `promise` unchanged so a call site can wrap-and-chain in one expression.
  trackTrimeshBuild(promise) {
    this._pendingTrimeshBuilds.add(promise)
    const done = () => this._pendingTrimeshBuilds.delete(promise)
    promise.then(done, done)
    return promise
  }

  // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: closes the documented
  // WorldPersistence.js restore-on-boot race (a restart-survival snapshot's dynamic-body state for an
  // autoTrimesh-collidered entity was silently skipped via bodiesSkippedNotFound whenever restoreWorldSnapshot
  // ran before that entity's fire-and-forget addStaticTrimeshAsync had resolved and set entity._physicsBodyId).
  // Waits for every trimesh build IN FLIGHT AT CALL TIME to settle (both the success and fallback-to-box
  // paths route their body-assignment through _deferOrRun, so this is CRASH-safe to call at any resim-
  // suppression state -- no since-deleted entity is ever mutated). NOTE this is not a completeness
  // guarantee if _resimSuppressed happens to be true at the moment a tracked promise settles: _deferOrRun
  // would queue the mutation into _deferredCommitmentOps rather than applying it immediately, and this
  // function's own settle-detection (trackTrimeshBuild's promise.then) fires the instant the OUTER promise
  // resolves regardless of whether the deferred inner mutation has actually applied yet. In practice this
  // never matters for this row's own call site (ServerAPI.js's loadWorld runs at boot, before any rollback
  // resimulation pass could plausibly have set _resimSuppressed) -- documented here so a future caller in a
  // genuinely suppressed context knows to also check _deferredCommitmentOps.length===0, not just this
  // function's return, if completeness (not just crash-safety) matters there. A build kicked off AFTER this
  // call started is NOT waited on (there is no unbounded "wait for the world to go quiet" here, only "wait
  // for what's already in flight right now", matching this codebase's own bounded-wait discipline elsewhere,
  // e.g. LockstepGameLoop's stall poll). timeoutMs bounds total wait so one pathologically slow/never-
  // settling GLB fetch cannot hang server boot forever -- a timeout is a real, loud, logged degraded-not-
  // crashed outcome (the caller proceeds anyway; WorldPersistence.js's own bodiesSkippedNotFound count still
  // reports the resulting gap honestly, this just shrinks how often it's nonzero rather than claiming to
  // eliminate it).
  async waitForPendingTrimeshBuilds(timeoutMs = 5000) {
    const pending = [...this._pendingTrimeshBuilds]
    if (!pending.length) return { waited: 0, timedOut: false }
    let timedOut = false
    const timeout = new Promise(resolve => setTimeout(() => { timedOut = true; resolve() }, timeoutMs))
    await Promise.race([Promise.allSettled(pending), timeout])
    if (timedOut) console.warn(`[AppRuntime] waitForPendingTrimeshBuilds timed out after ${timeoutMs}ms with ${this._pendingTrimeshBuilds.size}/${pending.length} still pending`)
    return { waited: pending.length, timedOut }
  }

  spawnEntity(id, config = {}) {
    if (this._resimSuppressed) { this._deferPopulationOp('spawn', [id, config]); return null }
    const entityId = id || `entity_${this._nextEntityId++}`
    const spawnPos = config.position ? [...config.position] : [0, 0, 0]
    const entity = {
      id: entityId, model: config.model || null,
      position: [...spawnPos],
      rotation: config.rotation || [0, 0, 0, 1],
      scale: config.scale ? [...config.scale] : [1, 1, 1],
      velocity: [0, 0, 0], mass: 1, bodyType: config.bodyType || 'static', collider: null,
      parent: null, children: new Set(),
      _appState: null, _appName: config.app || null, _config: config.config || null, custom: config.custom || null,
      _spawnPosition: spawnPos,
      // Per-entity-class CCD policy (physics-per-entity-class-ccd-policy): 'auto' (default -- CCD on
      // for dynamic bodies, off otherwise, the pre-existing behavior) | 'always' (force on, e.g. a fast
      // projectile/kinematic mover) | 'off' (force off even when dynamic, e.g. slow debris/props paying
      // LinearCast's real per-step cost for no benefit). Read by AppPhysics.js's resolveCCD() at every
      // collider-creation call site; world-def-authored (config.ccd) so a maker can set it per placed
      // entity without app code, same pattern as config.bodyType above.
      _ccdPolicy: (config.ccd === 'always' || config.ccd === 'off') ? config.ccd : 'auto'
    }
    installCustomVersion(entity)
    this.entities.set(entityId, entity)
    this._staticVersion++
    this._snapshotVersion++
    this._entityVersions.set(entityId, 1)
    if (entity.bodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    this._log('entity_spawn', { id: entityId, config }, { sourceEntity: entityId })
    if (config.parent) {
      let cycle = config.parent === entityId
      if (!cycle) { let cur = config.parent; while (cur) { if (cur === entityId) { cycle = true; break } cur = this.entities.get(cur)?.parent } }
      const p = cycle ? null : this.entities.get(config.parent)
      if (p) { entity.parent = config.parent; p.children.add(entityId) }
    }
    // Editor-authored interactable: if custom._interactable is truthy (a maker checked "interactable" on a plain
    // placed prop, or a saved world def carried it), register the entity in the interactable set WITHOUT any app
    // code calling ctx.interactable. Mirrors what ctx.interactable does. Accepts a bare truthy or a {prompt,radius}.
    this._hydrateInteractable(entityId, entity)
    if (config.autoTrimesh && entity.model && this._physics) {
      entity.collider = { type: 'trimesh', model: entity.model }
      // server-scale-worldpersistence-async-trimesh-race-and-in-flight-flush-frequency: the WHOLE chain
      // (success path OR fallback-to-box path, both of which do the real body-assignment mutation) is what
      // trackTrimeshBuild must wait on -- tracking only the bare addStaticTrimeshAsync promise would let
      // waitForPendingTrimeshBuilds return before the fallback box body (or the deferred success mutation)
      // has actually been assigned, reopening the exact race this exists to close. `settled` is the tracked
      // promise; it always resolves (never rejects) once the fallback .catch below has finished its own work.
      const settled = this._physics.addStaticTrimeshAsync(this.resolveAssetPath(entity.model), 0, entity.position || [0,0,0], entity.scale || [1,1,1], entity.rotation || [0,0,0,1])
        // rollback-population-inflight-async-commitment-at-suppression-start: this await can resolve
        // during a LATER suppression window than the one active (or absent) when spawnEntity itself ran --
        // route the mutation through _deferOrRun so a resolution landing mid-suppression queues instead of
        // mutating live state out from under a resimulate pass. entities.has() guards a destroy that
        // raced ahead of this (either a real live destroy, or a deferred one already flushed) from writing
        // onto a since-deleted entity object.
        .then(id => { this._deferOrRun(() => { if (this.entities.has(entityId)) { entity._physicsBodyId = id; this._physicsBodyToEntityId?.set(id, entityId) } }) })
        .catch(e => {
          // a bad GLB must not leave a placed static model with no collider -- fall back to a box
          console.error(`[AppRuntime] trimesh failed for ${entity.model}, falling back to box:`, e.message)
          this._log('app_error', { label: `trimesh(${entity.model})`, message: e.message }, { sourceEntity: entityId })
          this._deferOrRun(() => {
            if (!this.entities.has(entityId)) return
            entity.collider = { type: 'box', size: [0.5, 0.5, 0.5] }
            const bid = this._physics.addBody('box', [0.5, 0.5, 0.5], entity.position, 'static', { rotation: entity.rotation })
            entity._physicsBodyId = bid
            this._physicsBodyToEntityId?.set(bid, entityId)
            // Real error surfaced to every connected editor client (not just the original placer, who may
            // have moved on by the time this async trimesh build settles) instead of console-only silence --
            // matches EditorHandlers.sendError's EDITOR_ERROR shape so the client-side toast plumbing already
            // listening for it picks this up with no new client code.
            this._connections?.broadcast?.(MSG.EDITOR_ERROR, { message: `PLACE_MODEL: trimesh build failed for ${entity.model}, using box collider fallback`, entityId, detail: e.message })
          })
        })
      this.trackTrimeshBuild(settled)
    }
    if (config.app) this._attachApp(entityId, config.app).catch(e => this._logAppError(`attachApp(${config.app})`, e))
    this._spatialInsert(entity)
    return entity
  }

  async _attachApp(entityId, appName) {
    const entity = this.entities.get(entityId), appDef = this._appDefs.get(appName)
    if (!entity) return
    if (!appDef) {
      const msg = `entity ${entityId} references app "${appName}" but it never loaded -- entity will have no server-side app logic (add it to worldDef.placeableApps if it is only ever spawned dynamically)`
      console.error(`[AppRuntime] ${msg}`)
      // Non-fatal by design (production stays up, entity still spawns sans app -- fail LOUD, not fail hard),
      // but must be discoverable somewhere other than server stdout: EventLog is the same channel every
      // other runtime event (entity_spawn/entity_destroy/app_event) already flows through.
      this._log('app_load_missing', { entityId, appName, message: msg }, { sourceEntity: entityId })
      return
    }
    // detach any existing app first, or a re-attach orphans the old context's timers + event scope
    if (this.apps.has(entityId)) this.detachApp(entityId)
    const ctx = new AppContext(entity, this)
    this.contexts.set(entityId, ctx); this.apps.set(entityId, appDef)
    // invariant: apps.has(id) <=> entity._appName != null (read by getEntityWithApp/hasApp/snapshot filter)
    entity._appName = appName
    // setup() is async (real I/O in some apps, e.g. tps-game's loadScoreboard) -- mark this entity
    // pending BEFORE awaiting so any fireEvent landing during the await (a fast player_join is the real
    // production case, see _pendingSetupIds' constructor comment) queues instead of running against a
    // half-initialized ctx.state. Cleared in the finally so a setup() that THROWS still flushes/drops
    // the queue rather than leaving the entity permanently stuck pending (matching _safeCall's own
    // fail-loud-not-fail-hard discipline -- a broken app's setup must not silently swallow every
    // subsequent event forever).
    this._pendingSetupIds.add(entityId)
    try {
      await this._safeCall(appDef.server || appDef, 'setup', [ctx], `setup(${appName})`)
    } finally {
      // rollback-population-inflight-async-commitment-at-suppression-start: this setup() await can have
      // been kicked off before a suppression window opened (e.g. the original non-rolled-back run of the
      // tick that spawned this entity) and resolve WHILE suppressed (a later tick in the same resimulate
      // window is the one that turned out to be mispredicted). Clearing _pendingSetupIds + replaying any
      // queued fireEvent calls makes this app's handlers "live" for the first time -- update()/onCollision
      // become reachable via the next _rebuildUpdateList/_rebuildCollisionList, and _flushPendingEvents can
      // itself invoke onMessage/onInteract handlers that emit broadcasts/EventLog records. Doing that mid-
      // suppression would let an in-flight-since-before-suppression setup surface real output during a pass
      // a later correction may still supersede -- route both post-await steps through _deferOrRun so a
      // resolution landing mid-suppression queues instead, replayed once unsuppressed. entities.has() guards
      // against the entity having been destroyed (live or via a deferred destroy already flushed) while
      // setup() was in flight.
      this._deferOrRun(() => {
        this._pendingSetupIds.delete(entityId)
        if (this.entities.has(entityId)) this._flushPendingEvents(entityId)
        else this._pendingSetupQueues.delete(entityId)
      })
    }
    this._deferOrRun(() => { if (this.entities.has(entityId)) this._scheduleRebuild() })
  }

  // Replays every fireEvent call queued while entityId's setup() was in flight, in original arrival
  // order, through the exact same _safeCall path fireEvent itself uses -- so a queued onMessage gets
  // identical error handling/logging to a normal one. No-op if nothing queued.
  _flushPendingEvents(entityId) {
    const q = this._pendingSetupQueues.get(entityId)
    if (!q || !q.length) { this._pendingSetupQueues.delete(entityId); return }
    this._pendingSetupQueues.delete(entityId)
    const ad = this.apps.get(entityId), c = this.contexts.get(entityId)
    if (!ad || !c) return // detached/destroyed while setup was pending -- nothing to replay against
    const s = ad.server || ad
    for (const { en, a } of q) { if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${entityId})`) }
  }

  _scheduleRebuild() {
    if (this._rebuildScheduled) return
    this._rebuildScheduled = true
    setImmediate(() => { this._rebuildScheduled = false; this._rebuildUpdateList(); this._rebuildCollisionList() })
  }

  async attachApp(entityId, appName) { await this._attachApp(entityId, appName) }
  async spawnWithApp(id, cfg = {}, app) { return await this.spawnEntity(id, { ...cfg, app }) }
  async attachAppToEntity(eid, app, cfg = {}) { const e = this.getEntity(eid); if (!e) return false; e._config = cfg; await this._attachApp(eid, app); return true }
  async reattachAppToEntity(eid, app) { this.detachApp(eid); await this._attachApp(eid, app) }
  // ground truth for "is a real app currently attached" is apps.has(id), not entity._appName (which
  // stays populated as the requested app-name reference even on a failed/not-yet-resolved attach, so
  // HotReloadQueue._execute can still find + attach this entity once that app name registers later)
  hasApp(eid) { return this.apps.has(eid) }
  getEntityWithApp(eid) { const e = this.entities.get(eid); return { entity: e, appName: e?._appName, hasApp: this.apps.has(eid) } }

  detachApp(entityId) {
    const appDef=this.apps.get(entityId), ctx=this.contexts.get(entityId)
    if (ctx?._teardownChildren) ctx._teardownChildren()
    if (appDef && ctx) this._safeCall(appDef.server||appDef, 'teardown', [ctx], 'teardown')
    if (ctx?._runDisposers) ctx._runDisposers()
    this._eventBus.destroyScope(entityId); this.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
    // Drop any events still queued behind an in-flight setup() for this entity -- _flushPendingEvents
    // would no-op on them anyway (apps/contexts just deleted above) but this frees the queue immediately
    // instead of holding it until setup() eventually resolves. _pendingSetupIds itself is left alone: the
    // in-flight setup()'s own await/finally in _attachApp still needs to run its course and clear it.
    this._pendingSetupQueues.delete(entityId)
    this._proximityWatches.delete(entityId)
    const entity = this.entities.get(entityId); if (entity) entity._appName = null
    this._rebuildUpdateList(); this._rebuildCollisionList()
  }

  // Both list builders skip any entity still in _pendingSetupIds: apps.set(entityId,...) happens
  // SYNCHRONOUSLY before `await setup(ctx)` (see _attachApp), so a rebuild triggered by a DIFFERENT
  // entity's setImmediate-coalesced _scheduleRebuild (e.g. entity B's setup resolves fast while entity
  // A's setup is still awaiting real I/O, like tps-game's loadScoreboard) can otherwise find A already
  // in this.apps and start calling A's update()/onCollision() against a ctx.state setup() hasn't
  // finished populating -- e.g. apps/tps-game/index.js's `ctx.state.buffs = new Map()` runs after an
  // await, so update()'s `for (const [pid,buff] of ctx.state.buffs)` throws "not iterable" on
  // ctx.state.buffs being undefined. Once setup() resolves, _flushPendingEvents' caller (_attachApp)
  // already calls _scheduleRebuild again, so the entity is correctly included on the next rebuild.
  _rebuildUpdateList() {
    this._updateList = []
    for (const [id, ad] of this.apps) { if (this._pendingSetupIds.has(id)) continue; const ctx=this.contexts.get(id); if (!ctx) continue; const s=ad.server||ad; if (typeof s.update==='function') this._updateList.push({id,update:s.update.bind(s),ctx}) }
  }

  _rebuildCollisionList() {
    this._collisionEntities = []
    for (const [id, ad] of this.apps) { if (this._pendingSetupIds.has(id)) continue; const e=this.entities.get(id); if (!e) continue; const s=ad.server||ad; if (e.collider && typeof s.onCollision==='function') this._collisionEntities.push(e) }
  }

  destroyEntity(entityId) {
    if (this._resimSuppressed) { this._deferPopulationOp('destroy', [entityId]); return }
    const entity = this.entities.get(entityId); if (!entity) return
    this._staticVersion++
    this._dynamicEntityIds.delete(entityId); this._staticEntityIds.delete(entityId)
    this._activeDynamicIds.delete(entityId); this._sleepingDynamicIds.delete(entityId); this._suspendedEntityIds.delete(entityId)
    this._interactableIds.delete(entityId)
    this._proximityWatches.delete(entityId)
    // Vehicle constraint MUST be torn down before its chassis body -- a VehicleConstraint holds a raw
    // Jolt reference to the chassis body it was built from (createWheeledVehicle(chassisBodyId, ...));
    // removing the body first and leaving the constraint alive would be a dangling native reference
    // (same class of bug the constraint's own removeVehicle already guards against via ref-counted
    // teardown -- see World.js's removeVehicle header comment). Without this, destroying a vehicle
    // entity (e.g. an app's own cleanup, or an editor delete) leaked the constraint+tester Jolt-side
    // forever, found live while wiring apps/vehicle's destroy path this session.
    if (entity._vehicleId != null && this._physics) { this._physics.removeVehicle(entity._vehicleId); entity._vehicleId = null }
    if (entity._physicsBodyId !== undefined) {
      this._physicsBodyToEntityId.delete(entity._physicsBodyId)
      if (this._physics) this._physics.removeBody(entity._physicsBodyId)
      entity._physicsBodyId = undefined
    }
    this._log('entity_destroy', { id: entityId }, { sourceEntity: entityId })
    for (const childId of [...entity.children]) this.destroyEntity(childId)
    if (entity.parent) { const p = this.entities.get(entity.parent); if (p) p.children.delete(entityId) }
    this._eventBus.destroyScope(entityId)
    this.detachApp(entityId); this._spatialRemove(entityId); this.entities.delete(entityId)
  }

  // returns true if the type changed, false if missing or already that type
  changeBodyType(entityId, newBodyType) {
    const entity = this.entities.get(entityId)
    if (!entity || !newBodyType || newBodyType === entity.bodyType) return false
    const old = entity.bodyType
    entity.bodyType = newBodyType
    if (old !== 'static') this._dynamicEntityIds.delete(entityId)
    else this._staticEntityIds.delete(entityId)
    if (newBodyType !== 'static') this._dynamicEntityIds.add(entityId)
    else this._staticEntityIds.add(entityId)
    if (entity._physicsBodyId !== undefined) {
      this._physicsBodyToEntityId?.delete(entity._physicsBodyId)
      if (this._physics) this._physics.removeBody(entity._physicsBodyId)
      entity._physicsBodyId = undefined
      entity._bodyActive = false
    }
    // _tickPhysicsLOD skips any entity without a _bodyDef and rebuilds an existing one from its frozen motionType -- must sync _bodyDef here or the switch is a no-op
    const mt = newBodyType === 'dynamic' ? 'dynamic' : newBodyType === 'kinematic' ? 'kinematic' : 'static'
    this._activeDynamicIds?.delete(entityId)
    this._sleepingDynamicIds?.delete(entityId)
    this._suspendedEntityIds?.delete(entityId)
    if (mt !== 'static') {
      if (entity._bodyDef) {
        entity._bodyDef.motionType = mt
        if (entity._bodyDef.opts) entity._bodyDef.opts.linearCast = resolveCCD(entity, mt)
      } else if (entity.model) {
        const sc = entity.scale || [1, 1, 1]
        const heFallback = [Math.abs(sc[0] || 1) * 0.5, Math.abs(sc[1] || 1) * 0.5, Math.abs(sc[2] || 1) * 0.5]
        entity.collider = entity.collider || { type: 'box', size: heFallback }
        entity._bodyDef = { shapeType: 'box', params: heFallback, motionType: mt, opts: { mass: entity.mass, linearCast: resolveCCD(entity, mt) } }
        const modelPath = this.resolveAssetPath(entity.model)
        if (modelPath) {
          import('../physics/GLBLoader.js').then(({ extractAllVerticesFromGLBAsync }) => extractAllVerticesFromGLBAsync(modelPath)).then(mesh => {
            if (!this.entities.has(entityId) || entity.bodyType !== newBodyType) return
            const raw = mesh.vertices
            const points = (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) ? Array.from(raw) : Array.from(raw).map((v, i) => v * sc[i % 3])
            const bodyMt = entity._bodyDef?.motionType || mt
            entity.collider = { type: 'convex', points }
            entity._bodyDef = { shapeType: 'convex', params: points, motionType: bodyMt, opts: { mass: entity.mass, shapeKey: entity.model, linearCast: resolveCCD(entity, bodyMt) } }
            entity._bodyActive = false
          }).catch(e => { console.warn(`[physics] ${entity.model}: convex-hull collider resize failed (${e.message}), keeping scale-based box fallback`) })
        }
      } else {
        // fallback box sized from scale, matching AppPhysics.fallbackBox half-extents
        const sc = entity.scale || [1, 1, 1]
        const he = [Math.abs(sc[0] || 1) * 0.5, Math.abs(sc[1] || 1) * 0.5, Math.abs(sc[2] || 1) * 0.5]
        entity.collider = entity.collider || { type: 'box', size: he }
        entity._bodyDef = { shapeType: 'box', params: he, motionType: mt, opts: { mass: entity.mass, linearCast: resolveCCD(entity, mt) } }
      }
      // gate is (inRange && _bodyActive===false); undefined (never-had-a-body) would never fire
      entity._bodyActive = false
    }
    // must null both -- _tickPhysicsLOD's real cache is _lodIds (re-snapshots only on length change)
    this._lodIds = null
    this._lodIdArr = null
    this._staticVersion++
    return true
  }

  // rejects cycles (self or descendant parent); returns false if missing or cyclic
  // Register/unregister an entity as interactable from its custom._interactable flag (editor-authored, no app
  // code). Truthy -> add to _interactableIds + set _interactRadius/_interactCooldown from the flag or defaults;
  // falsy -> remove. Idempotent; safe to call on spawn and on every EDITOR_UPDATE that touches custom.
  _hydrateInteractable(entityId, entity) {
    const e = entity || this.entities.get(entityId); if (!e) return
    const flag = e.custom && e.custom._interactable
    if (flag) {
      const cfg = (typeof flag === 'object') ? flag : {}
      e._interactable = true
      e._interactRadius = (typeof cfg.radius === 'number' && cfg.radius >= 0) ? cfg.radius : (e._interactRadius ?? 3)
      e._interactCooldown = (typeof cfg.cooldown === 'number' && cfg.cooldown >= 0) ? cfg.cooldown : (e._interactCooldown ?? 500)
      this._interactableIds.add(entityId)
    } else {
      e._interactable = false
      this._interactableIds.delete(entityId)
    }
  }

  reparent(entityId, newParentId) {
    const e = this.entities.get(entityId); if (!e) return false
    if (newParentId) {
      if (newParentId === entityId) return false
      if (!this.entities.has(newParentId)) return false
      let cur = newParentId
      while (cur) { if (cur === entityId) return false; cur = this.entities.get(cur)?.parent }
    }
    // Preserve the child's WORLD transform across the reparent: capture it before the parent flip, then re-derive
    // the child's LOCAL position/rotation/scale under the new parent so it does not visually jump by the parent's
    // world offset. Inverse of getWorldTransform's parent-compose (scale, rotate, translate): unscale, then rotate
    // by the new parent's inverse rotation (conjugate of a unit quat), then subtract the new parent's world origin.
    const childWorld = this.getWorldTransform(entityId)
    if (e.parent) { const old=this.entities.get(e.parent); if (old) old.children.delete(entityId) }
    e.parent = null
    if (newParentId) {
      const np=this.entities.get(newParentId)
      if (np) {
        e.parent=newParentId; np.children.add(entityId)
        const pw = this.getWorldTransform(newParentId)
        if (pw && childWorld) {
          const sx = pw.scale[0] || 1, sy = pw.scale[1] || 1, sz = pw.scale[2] || 1
          const invRot = [-pw.rotation[0], -pw.rotation[1], -pw.rotation[2], pw.rotation[3]]
          const d = [childWorld.position[0]-pw.position[0], childWorld.position[1]-pw.position[1], childWorld.position[2]-pw.position[2]]
          const dr = rotVec(d, invRot)
          e.position = [dr[0]/sx, dr[1]/sy, dr[2]/sz]
          e.rotation = mulQuat(invRot, childWorld.rotation)
          e.scale = [childWorld.scale[0]/sx, childWorld.scale[1]/sy, childWorld.scale[2]/sz]
        }
      }
    } else if (childWorld) {
      // Reparent to root: local becomes world.
      e.position = [...childWorld.position]; e.rotation = [...childWorld.rotation]; e.scale = [...childWorld.scale]
    }
    this._staticVersion++
    this._markDirty(entityId)
    return true
  }

  // intoId (optional): spawn the copy under a caller-chosen id -- used by the editor's undo history so
  // a re-duplicated entity keeps a stable id across undo/redo cycles. Collisions are impossible here in
  // practice (EditorHandlers._clientSuppliedId collision-checks first), and spawnEntity itself would
  // happily overwrite the map entry, so the id-freedom check stays at the protocol layer.
  duplicateEntity(entityId, offset = [0.5, 0, 0.5], intoId = null) {
    const e = this.entities.get(entityId); if (!e) return null
    const pos = [(e.position?.[0] || 0) + offset[0], (e.position?.[1] || 0) + offset[1], (e.position?.[2] || 0) + offset[2]]
    const copy = this.spawnEntity(intoId, {
      model: e.model || undefined,
      app: e._appName || undefined,
      position: pos,
      rotation: Array.isArray(e.rotation) ? [...e.rotation] : undefined,
      scale: e.scale ? [...e.scale] : undefined,
      config: e._config ? { ...e._config } : undefined,
      parent: e.parent || undefined
    })
    if (copy && e.custom) copy.custom = JSON.parse(JSON.stringify(e.custom))
    return copy
  }

  setLabel(entityId, label) {
    const e = this.entities.get(entityId); if (!e) return false
    e._config = { ...(e._config || {}), label: String(label) }
    return true
  }

  getWorldTransform(entityId) {
    const e = this.entities.get(entityId); if (!e) return null
    const local = { position: [...e.position], rotation: [...e.rotation], scale: [...e.scale] }
    if (!e.parent) return local
    const pt = this.getWorldTransform(e.parent); if (!pt) return local
    const sp = [e.position[0]*pt.scale[0], e.position[1]*pt.scale[1], e.position[2]*pt.scale[2]]
    const rp = rotVec(sp, pt.rotation)
    return { position: [pt.position[0]+rp[0], pt.position[1]+rp[1], pt.position[2]+rp[2]], rotation: mulQuat(pt.rotation, e.rotation), scale: [pt.scale[0]*e.scale[0], pt.scale[1]*e.scale[1], pt.scale[2]*e.scale[2]] }
  }

  _encodeEntity(id, e) { const r=Array.isArray(e.rotation)?[...e.rotation]:[e.rotation.x||0,e.rotation.y||0,e.rotation.z||0,e.rotation.w||1]; return { id, model:e.model, position:[...e.position], rotation:r, scale:[...e.scale], velocity:[...(e.velocity||[0,0,0])], bodyType:e.bodyType, custom:e.custom||null, parent:e.parent||null } }
  _markDirty(id) { this._snapshotVersion++; const v = this._entityVersions.get(id) || 0; this._entityVersions.set(id, v + 1) }
  _snap(entities) { return { tick: this.currentTick, timestamp: Date.now(), entities } }
  getSnapshot() { if (this._snapshotCache && this._snapshotCache._version === this._snapshotVersion) return this._snapshotCache; const e=[]; for (const [id,en] of this.entities) e.push(this._encodeEntity(id,en)); this._snapshotCache = Object.assign(this._snap(e), { _version: this._snapshotVersion }); return this._snapshotCache }
  getStaticSnapshot() { const e=[]; for (const id of this._staticEntityIds) { const en=this.entities.get(id); if (en) e.push(this._encodeEntity(id,en)) } return this._snap(e) }
  // sph-fluid-3d-client-render-verification found+fixed this live: TickHandler.js's relevanceRadius>0
  // path only re-runs SnapshotEncoder.encodeStaticEntities (the real, correct per-entity custom-diff
  // logic) when appRuntime._staticVersion changes -- but _staticVersion only bumps on entity spawn/
  // destroy/body-type-change, NEVER on a plain `entity.custom = {...}` mutation (installCustomVersion's
  // own _customV counter is a completely separate, unrelated counter TickHandler.js never reads for
  // static entities). Any static-bodyType app that republishes entity.custom every tick without ever
  // touching position/velocity/spawning -- both apps/fluid-source (2D, already shipped) and
  // apps/fluid3d-source (3D, this row) are exactly that shape -- silently NEVER reaches a client past
  // its first spawn-tick snapshot, live-reproduced via a real browser-verb witness: a freshly-dropped
  // fluid volume's rendered particles stayed byte-frozen at the spawn-tick position for 5+ real seconds
  // while the server-side entity.custom.fluid.positions (confirmed via a separate direct-Node harness)
  // kept genuinely updating every tick. Cheap O(1)-comparable summary so TickHandler.js can detect a
  // real custom-only static-entity change without paying encodeStaticEntities' full O(staticCount) cost
  // every tick: sums each static entity's own _customV (installCustomVersion, CustomVersion.js) --
  // absent on any entity not built through spawnEntity, contributes 0, matching every other _customV
  // read's own null-safe convention in this codebase (see SnapshotEncoder.js's resolveCustKey).
  getStaticCustomVersionSum() { let s = 0; for (const id of this._staticEntityIds) { const en = this.entities.get(id); if (en && typeof en._customV === 'number') s += en._customV } return s }
  // custom._interior entities are always-relevant regardless of distance (arena/level geometry)
  getSnapshotForPlayer(pos, r, skipStatic=false) { const e=[], rel=new Set(this.relevantEntities(pos,r)); for (const id of (skipStatic?this._dynamicEntityIds:this.entities.keys())) { const en=this.entities.get(id); if (en&&(rel.has(id)||en.custom?._interior)) e.push(this._encodeEntity(id,en)) } return this._snap(e) }
  getDynamicEntitiesRaw() { const o=[]; for (const id of this._activeDynamicIds) { const e=this.entities.get(id); if (e) o.push({ id, model:e.model, position:e.position, rotation:e.rotation, velocity:e.velocity, bodyType:e.bodyType, custom:e.custom, _isEnv:!!e.custom?._interior, _sleeping:false }) } for (const id of this.getUnmanagedDynamicIds()) { const e=this.entities.get(id); if (e) o.push({ id, model:e.model, position:e.position, rotation:e.rotation, velocity:e.velocity, bodyType:e.bodyType, custom:e.custom, _isEnv:!!e.custom?._interior, _sleeping:false }) } for (const id of this._sleepingDynamicIds) o.push({ id, _sleeping:true }); for (const id of this._suspendedEntityIds) o.push({ id, _sleeping:true }); return o }
  getRelevantDynamicIds(pos, r) { return this.relevantEntities(pos, r) }
  // Priority-accumulate starvation guard (roadmap: AOI interest management, Halo/Overwatch-style so
  // starved entities eventually send): wraps getRelevantDynamicIds, marking every returned id as
  // "seen" for viewerKey (a stable per-cell/per-player key, caller's choice) on the stage's spatial
  // index, and unioning in any id that's gone unseen by that SAME viewerKey for maxTicksStarved ticks
  // -- a distant slowly-approaching entity that never enters a cell's relevance radius otherwise stays
  // completely invisible to that viewer forever. No-op (identical to getRelevantDynamicIds) when no
  // active stage/spatial index exists.
  getRelevantDynamicIdsWithStarvation(pos, r, viewerKey, maxTicksStarved = 300) {
    const ids = this.relevantEntities(pos, r)
    const spatial = this._stageLoader?._activeStage?.spatial
    if (!spatial || !viewerKey) return ids
    for (const id of ids) spatial.markSeen(id, viewerKey)
    const starved = spatial.collectStarved(viewerKey, maxTicksStarved)
    if (!starved.length) return ids
    const out = ids instanceof Set ? ids : new Set(ids)
    for (const id of starved) out.add(id)
    return out
  }
  getActiveDynamicIds() { return this._activeDynamicIds }
  getSleepingDynamicIds() { return this._sleepingDynamicIds }
  getSuspendedEntityIds() { return this._suspendedEntityIds }
  // Dynamic (non-static) entities with NO real physics body (app code drives entity.position directly
  // every tick -- e.g. a scripted/kinematic ball with no ctx.physics.addBody call) never fire
  // onBodyActivated/onBodyDeactivated and so are absent from _activeDynamicIds/_sleepingDynamicIds/
  // _suspendedEntityIds, which are populated ONLY by physics callbacks. The relevanceRadius>0 snapshot
  // path (TickHandler.buildAndSendSnapshots) builds its per-player dynamic cache exclusively from those
  // three physics-derived sets, so a purely app-driven dynamic entity was silently invisible to every
  // snapshot sent to a client -- its server position genuinely updated every tick but no snapshot ever
  // carried it (witnessed: server y 3->-42 over 180 ticks, snapshot.entities stayed empty for that id).
  // This set closes that gap: iterated as "always active" (its position can change any tick, same as
  // a truly physics-active body) by refreshDynamicCache/buildDynamicCache.
  getUnmanagedDynamicIds() { const o=[]; for (const id of this._dynamicEntityIds) { if (this._activeDynamicIds.has(id) || this._sleepingDynamicIds.has(id) || this._suspendedEntityIds.has(id)) continue; const e=this.entities.get(id); if (e && e._physicsBodyId===undefined) o.push(id) } return o }
  nearbyPlayerIds(pos, r) { return this._playerIndex.nearby(pos, r) }
  // Hysteresis-ring variant: a player hovering at the exact edge of a cell's relevance radius (walking
  // back and forth across the boundary) stays included until they clear a 15%-wider outer ring, instead
  // of popping in/out of every other nearby player's snapshot every tick. viewerKey scopes the "was
  // included last call" memory to the caller's own subscription unit (a cell key, matching the dynamic-
  // entity starvation guard's viewerKey convention above).
  nearbyPlayerIdsHysteresis(pos, r, viewerKey) { return this._playerIndex.nearbyHysteresis(pos, r, viewerKey) }

  // Player-proximity hook: callback(playerId) fires once per tick for every player within radius of
  // entityId's position -- piggybacks the existing per-tick player-position loop (_tickProximityWatches
  // in AppRuntimeTick.js) rather than each app hand-rolling its own O(n) nearest-player distance scan.
  registerProximityWatch(entityId, radius, callback) {
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) throw new TypeError('[AppRuntime] registerProximityWatch: radius must be a non-negative finite number')
    if (typeof callback !== 'function') throw new TypeError('[AppRuntime] registerProximityWatch: callback must be a function')
    this._proximityWatches.set(entityId, { radius, radius2: radius * radius, callback })
    return () => this._proximityWatches.delete(entityId)
  }

  // Player-vs-player contact hook: callback(playerIdA, playerIdB) fires once per tick for every unordered
  // pair of connected players within radius of each other. Every registered watcher shares ONE O(n^2/2)
  // pair scan per tick (_tickPlayerContactWatches in AppRuntimeTick.js) instead of each app (tag, freeze-tag,
  // sumo, dodgeball, hot-potato) hand-rolling its own quadratic player-pair distance loop. Keyed by appId so
  // an app can register once and re-register replaces cleanly; the unsub removes just that app's watch.
  registerPlayerContactWatch(appId, radius, callback) {
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) throw new TypeError('[AppRuntime] registerPlayerContactWatch: radius must be a non-negative finite number')
    if (typeof callback !== 'function') throw new TypeError('[AppRuntime] registerPlayerContactWatch: callback must be a function')
    this._playerContactWatches.set(appId, { radius2: radius * radius, callback })
    return () => this._playerContactWatches.delete(appId)
  }

  getSceneGraph() {
    const n=[]
    for (const [id,e] of this.entities) if (!e.parent&&(this.apps.has(id)||e.custom||e.model)) n.push(this._buildNode(id,e))
    return n
  }
  // custom included (not just id/appName/label/position/children): SceneHierarchy.js's classify() already
  // reads node.custom.mesh to distinguish a placed primitive from a generic app row, and the editor's
  // Waypoint Timeline panel (moving-platform-keyframe-timeline-followup) filters on node.custom._waypoint --
  // both were silently dead/empty without this field. entity.custom is always a small plain
  // object (color/mesh/order/flags, see apps/waypoint, apps/moving-platform), safe to include whole.
  // `model` (placed-model GLB url) is additive: the editor's undo-of-delete needs it to re-place a
  // deleted placed-model via PLACE_MODEL under the original id; no other scene-graph consumer reads it.
  _buildNode(id, e) { const r1=v=>Math.round(v*10)/10; return { id, appName:e._appName, label:e._config?.label||e._appName||id, position:e.position?[r1(e.position[0]),r1(e.position[1]),r1(e.position[2])]:null, custom:e.custom||null, ...(e.model ? { model: e.model } : {}), children:[...e.children].map(cid=>this._buildNode(cid,this.entities.get(cid))).filter(Boolean) } }

  queryEntities(f) { const r = []; for (const e of this.entities.values()) { if (!f || f(e)) r.push(e) } return r }
  getEntity(id) { return this.entities.get(id) || null }
  fireEvent(eid, en, ...a) {
    const ad = this.apps.get(eid), c = this.contexts.get(eid); if (!ad || !c) return
    this._log('app_event', { entityId: eid, event: en, args: a }, { sourceEntity: eid })
    // setup() still in flight for this entity -- queue rather than run against a half-initialized
    // ctx.state (see _pendingSetupIds' constructor comment + _flushPendingEvents). Logged, not silent,
    // matching AppRuntime's existing app_load_missing-style discoverability discipline.
    if (this._pendingSetupIds.has(eid)) {
      let q = this._pendingSetupQueues.get(eid); if (!q) this._pendingSetupQueues.set(eid, q = [])
      q.push({ en, a })
      this._log('app_event_queued_pending_setup', { entityId: eid, event: en }, { sourceEntity: eid })
      return
    }
    const s = ad.server || ad; if (s[en]) this._safeCall(s, en, [c, ...a], `${en}(${eid})`)
  }
  fireInteract(eid, p) { this.fireEvent(eid, 'onInteract', p) }
  fireMessage(eid, m) { this.fireEvent(eid, 'onMessage', m) }
  // Delivers `m` to EVERY currently-attached app's onMessage (player_join/player_leave/every client
  // APP_EVENT fan out through this). Snapshots the entity-id list into a real array BEFORE iterating --
  // this.apps is a live Map, and an onMessage handler that synchronously spawns a new same-broadcast-
  // eligible app entity (ctx.world.spawn with an app: string attaches + apps.set()s before returning)
  // would otherwise be VISITED WITHIN THE SAME for..of pass once it sorts after the current iteration
  // position, delivering this SAME message a second time to the newly-spawned entity. Live-confirmed:
  // apps/item-pickup/index.js's debug_kill handler spawning a dropped-item marker entity mid-broadcast
  // caused dropOnDeath to fire twice for one client message. Freezing the visited set at broadcast-start
  // closes this hazard for every future onMessage handler, not just ones that remember to self-defer.
  broadcastMessage(m) { for (const entityId of [...this.apps.keys()]) this.fireMessage(entityId, m) }
  addTimer(e, d, fn, r) { if (!this._timers.has(e)) this._timers.set(e, []); this._timers.get(e).push({ remaining: d, fn, repeat: r, interval: d }) }
  clearTimers(eid) { this._timers.delete(eid) }
  setPlayerManager(pm) { this._playerManager = pm }
  setStageLoader(sl) { this._stageLoader = sl }
  // hotreload-migrate-entity-custom-field: wired by server.js/WorkerEntry.js right after ctx.placedModelStorage
  // is built (both construct it in the same closure as `this`, just slightly after this runtime exists), so
  // HotReloadQueue._execute can trigger the SAME debounced persist() an editor edit already triggers whenever
  // a migrate() export actually reshapes entity.custom -- otherwise the migrated in-memory shape would silently
  // diverge from data/placed-models.json until the next unrelated editor edit happened to fire a persist.
  setPlacedModelStorage(pms) { this._placedModelStorage = pms }
  getPlayers() { return this._playerManager ? this._playerManager.getConnectedPlayers() : [] }
  getPlayerById(id) { return this._playerManager ? this._playerManager.getPlayer(id) : null }
  getNearestPlayer(pos, r) { if (!vecOK(pos, 3) || typeof r !== 'number' || !Number.isFinite(r)) return null; const id = this._playerIndex?.nearest(pos, r); if (id != null) return this._playerManager?.getPlayer(id) || null; let n=null,md=r*r; for (const p of this.getPlayers()) { const pp=p.state?.position; if (!pp) continue; const dx=pp[0]-pos[0],dy=pp[1]-pos[1],dz=pp[2]-pos[2],d=dx*dx+dy*dy+dz*dz; if (d<md) { md=d; n=p } } return n }
  // rollback-resimulate-duplicate-emission-suppression: both network-send entry points are the ONE choke
  // point every app-triggered outbound message passes through (ctx.network.broadcast/sendTo ->
  // runtime.broadcastToPlayers/sendToPlayer above -- see AppContext.js's `network` getter), so gating here
  // covers every app regardless of how many distinct call sites it has. `_resimSuppressed` (see
  // setResimSuppressed below) is set true by RollbackLoop.resimulateFrom for every NON-FINAL corrective
  // pass over a given tick range -- see that flag's own header comment for why "final pass only" is the
  // correct policy, not "first pass only" or "every pass".
  broadcastToPlayers(m) { if (this._resimSuppressed) return; if (this._connections) this._connections.broadcast(MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.broadcast(m) }
  sendToPlayer(id, m) { if (this._resimSuppressed) return; if (this._connections) this._connections.send(id, MSG.APP_EVENT, m); else if (this._playerManager) this._playerManager.sendToPlayer(id, m) }
  setPlayerPosition(id, p) { if (!vecOK(p, 3)) return; this._physicsIntegration?.setPlayerPosition(id, p); if (this._playerManager) { const pl=this._playerManager.getPlayer(id); if (pl) pl.state.position=[...p] } }
  setPlayerName(id, name) { if (typeof name !== 'string') return false; const pl = this._playerManager?.getPlayer(id); if (!pl) return false; pl.name = name.trim().slice(0, 32) || pl.name; return true }
  // Server-authoritative equipped-weapon signal (animation-weapon-signal-clientside-wiring). Written
  // straight onto pl.state.weapon -- the SAME `st` object TickHandler.js's per-tick loop already reads
  // st.expr/st.crouch off (see TickHandler.js's `st.weapon||0` read into networkState.updatePlayer) --
  // NOT a one-off broadcastToPlayers APP_EVENT like setPlayerAppearance/setPlayerModel above, since this
  // needs to ride the SAME per-tick snapshot wire ps.expr/ps.crouch already use (so tickPlayerAnimators,
  // client/app.js, can read it every frame off the live ps=pm.playerStates.get(id) track, exactly like
  // the existing ps._aiming/ps.crouch reads beside it -- not a separate one-shot event listener). Name is
  // resolved to a compact u8 code via src/shared/WeaponCodes.js's weaponNameToCode (dual-imported,
  // server+client share one code table so neither end can drift). An unrecognised name resolves to
  // WEAPON_UNARMED (0) rather than throwing -- mirrors setPlayerModel's type-check-then-false-return
  // shape for a bad input, but weapon codes have a real "valid but unarmed" state so a bad name silently
  // degrading to unarmed (rather than rejecting the call) matches PlayerAnimator.setWeapon's own
  // graceful-fallback discipline for the no-trio-resolved case.
  setPlayerWeapon(id, name) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.state.weapon = weaponNameToCode(name)
    return true
  }
  setPlayerAppearance(id, appearance = {}) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.appearance = { ...(pl.appearance || {}), ...appearance }   // remembered so a late-joiner can be re-sent it
    this.broadcastToPlayers({ type: 'player_appearance', playerId: id, tint: pl.appearance.tint, nameTag: pl.appearance.nameTag })
    return true
  }
  // Per-player MODEL swap: broadcast a model url so every client rebuilds THAT player's avatar from it (skins,
  // unlockable characters, team models, a boss transform). Remembered on the player so a late-joiner is re-sent it.
  setPlayerModel(id, url) {
    if (typeof url !== 'string' || !url) return false
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    pl.modelUrl = url
    this.broadcastToPlayers({ type: 'player_model', playerId: id, url })
    return true
  }
  setPlayerMovementOverride(id, overrides) { return this._playerManager ? this._playerManager.setMovementOverride(id, overrides) : false }
  // Attach an entity so it follows a player each tick at `offset` (flag carry, escorted object, held tool).
  // Kinematic move via setEntityPosition keeps the collider in sync. detach stops the follow (entity stays put).
  attachEntityToPlayer(entityId, playerId, offset = [0, 1, 0]) {
    if (!this.entities.has(entityId)) return false
    this._attachments.set(entityId, { playerId, offset: vecOK(offset, 3) ? [...offset] : [0, 1, 0] })
    return true
  }
  detachEntityFromPlayer(entityId) { return this._attachments.delete(entityId) }
  _tickAttachments() {
    if (this._attachments.size === 0) return
    for (const [entityId, att] of this._attachments) {
      const e = this.entities.get(entityId); if (!e) { this._attachments.delete(entityId); continue }
      const pl = this._playerManager?.getPlayer(att.playerId); const pp = pl?.state?.position
      if (!pp) continue
      const pos = [pp[0] + att.offset[0], pp[1] + att.offset[1], pp[2] + att.offset[2]]
      if (this.setEntityPosition) this.setEntityPosition(entityId, pos, e.rotation)
      else { e.position[0] = pos[0]; e.position[1] = pos[1]; e.position[2] = pos[2] }
    }
  }
  // Server-authoritative player lifecycle: 'alive' | 'frozen' | 'spectator'. Broadcast so the owning client
  // freezes input ('frozen'/'spectator') and switches to a spectate follow-cam ('spectator'). The primitive
  // elimination games / red-light-green-light / musical-chairs / freeze-tag need without hand-rolled per-client wiring.
  setPlayerLifecycle(id, state, opts = {}) {
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    if (state !== 'alive' && state !== 'frozen' && state !== 'spectator') return false
    pl.lifecycle = state
    this.broadcastToPlayers({ type: 'player_lifecycle', playerId: id, state, spectateTarget: opts.spectateTarget ?? null })
    return true
  }
  // Force a one-shot/looping animation clip on a player's avatar (dance/emote/stagger/death pose). Broadcast so
  // every client plays it on that player's animator. loop/fade in opts.
  playPlayerAnimation(id, clip, opts = {}) {
    if (typeof clip !== 'string' || !clip) return false
    const pl = this._playerManager?.getPlayer(id); if (!pl) return false
    this.broadcastToPlayers({ type: 'player_anim', playerId: id, clip, loop: !!opts.loop, fade: opts.fade ?? 0.2 })
    return true
  }
  queueReload(n, d, cb) { this._hotReload.enqueue(n, d, cb) }
  _drainReloadQueue() { this._hotReload.drain() }
  hotReload(n, d) { this._hotReload._execute(n, d) }
  _spatialInsert(entity) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage && !stage.hasEntity(entity.id)) { stage.entityIds.add(entity.id); stage.spatial.insert(entity.id, entity.position); if (entity.bodyType==='static') stage._staticIds.add(entity.id) } }
  _spatialRemove(entityId) { if (!this._stageLoader) return; const stage=this._stageLoader.getActiveStage(); if (stage) { stage.spatial.remove(entityId); stage._staticIds.delete(entityId); stage.entityIds.delete(entityId) } }
  _spatialSync() { if (this._stageLoader) this._stageLoader.syncAllPositions() }
  nearbyEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getNearbyEntities(position, radius) }
  relevantEntities(position, radius) { if (!this._stageLoader) return Array.from(this.entities.keys()); return this._stageLoader.getRelevantEntities(position, radius) }
  // rollback-resimulate-duplicate-emission-suppression: gated the SAME way broadcastToPlayers/sendToPlayer
  // are above -- a resimulated non-final pass must not leave a duplicate audit record for a tick range
  // that will be re-run again by a later corrective pass. Covers both this internal call site (entity_spawn/
  // entity_destroy/app_error/bus_event, see the `_eventBus.on('*', ...)` mirror in the constructor) and
  // every app's own DIRECT ctx.eventLog.record(...) call (apps/tps-game/server.js's hit_registered, e.g.)
  // by gating EventLog.record itself via _eventLog.pause()/resume() (src/netcode/EventLog.js -- a real,
  // already-shipped, previously-unused primitive on that class) rather than only checking the flag here,
  // since a raw ctx.eventLog.record() call from app code never passes through this method at all.
  _log(type, data, meta = {}) { if (this._eventLog) this._eventLog.record(type, data, { ...meta, tick: this.currentTick }) }
  _logAppError(l, e) {
    console.error(`[AppRuntime] ${l}: ${e.message}`)
    // Every app lifecycle call (setup/update/onMessage/onCollision/...) routes through here, so
    // this is the ONE place a broken app's throw becomes discoverable outside server stdout --
    // same event-log channel EditorEventLog already polls (see _attachApp's app_load_missing).
    this._log('app_error', { label: l, message: e.message, stack: e.stack }, {})
  }
  _safeCall(o, m, a, l) {
    if (!o?.[m]) return Promise.resolve()
    try { const r = o[m](...a); if (r?.catch) return r.catch(e => this._logAppError(l, e)); return Promise.resolve() }
    catch (e) { this._logAppError(l, e); return Promise.reject(e) }
  }

  // ---- Rollback-netcode primitive (rollback-entity-gamestate-snapshot) --------------------------------
  // PhysicsWorld.snapshotBodies/restoreBodies + snapshotCharacters/restoreCharacters (World.js) already
  // cover Jolt-simulated dynamics state. That is necessary but not sufficient for a correct rewind: a
  // tick can also mutate plain-JS entity/app state that lives entirely OUTSIDE Jolt (entity.custom the
  // maker/editor sees, entity._appState an app's own `ctx.state` closure, position/rotation/scale/
  // velocity/bodyType on entities Jolt never simulates at all -- e.g. a kinematic moving-platform driven
  // by app code, not physics -- plus the _respawnTimer/_timers countdown state AppRuntimeTick.js mutates
  // every tick). A correct resimulate pass needs to rewind THIS too, or replaying ticks 41-65 forward
  // after restoring only the physics bodies would replay against whatever score/ammo/timer state tick 65
  // ALREADY left behind the first time -- silently wrong, not merely incomplete.
  //
  // AUDIT: which per-tick mutations are safe to include (pure functions of (state, input), safe to
  // capture+restore+resimulate) vs which are NOT (one-shot/non-idempotent side effects a restore+replay
  // would double-fire or corrupt) -- required by this row's own spec before writing the capture set:
  //
  //   SAFE, INCLUDED below:
  //     - entity.position/rotation/scale/velocity/bodyType: plain per-tick simulation output (moving
  //       platforms, app-driven kinematics, _tickRespawn's teleport-back). Pure state, deep-copied.
  //     - entity.custom / entity._appState (ctx.state): app-owned data mutated by update()/onCollision/
  //       onInteract handlers (score, ammo, captured-flag state, buff stacks, FSM phase, ...). This is
  //       exactly the "app custom fields" this row's own detail text names. Deep-cloned (JSON round-trip,
  //       same discipline duplicateEntity already uses for entity.custom) since these are plain nested
  //       objects mutated in place -- a shallow copy would alias the live object.
  //     - _respawnTimer (id -> {startTime, lastRespawn}): pure countdown state compared against
  //       Date.now() to decide WHEN to respawn, not a one-shot side effect itself -- restoring the
  //       countdown and replaying ticks re-derives the identical respawn-or-not decision each tick made
  //       the first time (the actual teleport this timer gates IS itself idempotent: it unconditionally
  //       sets position/velocity to fixed values, safe to re-run any number of times).
  //     - _timers (eid -> [{remaining, fn, repeat, interval}]): remaining/repeat/interval are pure
  //       countdown state safe to rewind. `fn` (the callback closure) is NOT re-created by a restore --
  //       it is the SAME closure reference the original addTimer call captured, so restoring only rewinds
  //       WHEN it will next fire, never re-runs it during restore itself. A resimulate pass re-ticking
  //       dt forward will re-fire it at the correct rewound remaining, exactly once, same as any other
  //       per-tick countdown -- this is why a fresh `fn` capture is unnecessary and would be wrong.
  //
  //     - _interactCooldowns (key -> expiresAtTick, a runtime.currentTick-relative simulation-tick
  //       number): originally keyed by Date.now() wall-clock (UNSAFE to rewind -- see AppRuntimeTick.js's
  //       _tickInteractables header comment for the full original-bug writeup, kept there since that is
  //       where the clock source lives), fixed by converting to a tick-indexed "expires at tick X" scheme
  //       computed from the SAME per-tick dt driving both the original run and any resimulate pass. Now
  //       pure tick-relative state, safe to deep-copy/restore/resimulate exactly like _respawnTimer.
  //
  //   UNSAFE, DELIBERATELY EXCLUDED (the caller must not treat this snapshot as a complete world-state
  //   restore for these):
  //     - Any ALREADY-FIRED one-shot side effect: event-bus emissions (_eventBus.emit), the EventLog
  //       (_log/_eventLog.record), and outbound network sends (playerManager.broadcast/sendToPlayer) are
  //       never captured or replayed by this primitive at all -- they are not "state" in the rewindable
  //       sense, they are OUTPUT a tick produces once. A caller resimulating ticks after a restore will
  //       naturally re-produce fresh emissions/logs/sends as those ticks re-run (correct -- a client DOES
  //       need the corrected snapshot re-sent), but nothing here attempts to suppress or de-duplicate a
  //       resimulated tick's SECOND round of these side effects (e.g. a kill-feed onCollision handler
  //       firing again for the resimulated tick). That double-fire hazard is real and is explicitly the
  //       orchestration row's problem to solve (e.g. only actually flushing network sends/broadcasts for
  //       the FINAL resimulate pass over a given tick, not every corrective pass over it) -- a
  //       snapshot/restore primitive has no way to solve it by itself, since suppression is a property of
  //       the CALLER's resimulate loop, not of what gets captured here.
  //     - Entity/app POPULATION changes (spawnEntity/destroyEntity/attachApp/detachApp between the save
  //       point and the restore point): this snapshot only round-trips fields on entities that exist in
  //       BOTH the saved snapshot and the live world at restore time (same defensive-membership
  //       discipline as PhysicsWorld.restoreBodies/CharacterManager.restoreAll) -- an entity destroyed
  //       mid-window is silently left destroyed, one spawned mid-window is silently left spawned. A
  //       correct full rewind of entity population itself (undoing a destroy, re-removing a spawn) is
  //       real additional scope this slice does not attempt, since it interacts with async setup()/
  //       physics-body creation in ways that need the orchestration row's design first.
  //
  // Static entities (bodyType==='static') are skipped by default (matching PhysicsWorld.snapshotBodies'
  // own static-body skip) since nothing mutates a static entity's transform under normal play -- pass
  // {includeStatic:true} for a caller that specifically needs it (e.g. an editor-driven static move).
  snapshotGameState(opts = {}) {
    const includeStatic = !!opts.includeStatic
    const entities = new Map()
    for (const [id, e] of this.entities) {
      if (!includeStatic && e.bodyType === 'static') continue
      entities.set(id, {
        position: [...e.position],
        rotation: [...e.rotation],
        scale: [...e.scale],
        velocity: [...(e.velocity || [0, 0, 0])],
        bodyType: e.bodyType,
        custom: e.custom ? JSON.parse(JSON.stringify(e.custom)) : null,
        appState: tagAppState(e._appState)
      })
    }
    const respawnTimers = new Map()
    for (const [id, t] of this._respawnTimer) respawnTimers.set(id, { startTime: t.startTime, lastRespawn: t.lastRespawn })
    const timers = new Map()
    for (const [eid, list] of this._timers) timers.set(eid, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval, fn: t.fn })))
    const interactCooldowns = new Map(this._interactCooldowns)
    return { tick: this.currentTick, entities, respawnTimers, timers, interactCooldowns }
  }

  // Restores exactly the entities/timers present in `snap` that still exist live -- an entity destroyed
  // since the snapshot, or one this snapshot never covered (spawned after, or static and the snapshot
  // was taken with includeStatic:false), is silently left as-is. See snapshotGameState's header comment
  // for the full audit of what this primitive intentionally does and does not roll back.
  restoreGameState(snap) {
    for (const [id, s] of snap.entities) {
      const e = this.entities.get(id); if (!e) continue
      e.position[0] = s.position[0]; e.position[1] = s.position[1]; e.position[2] = s.position[2]
      e.rotation[0] = s.rotation[0]; e.rotation[1] = s.rotation[1]; e.rotation[2] = s.rotation[2]; e.rotation[3] = s.rotation[3]
      e.scale[0] = s.scale[0]; e.scale[1] = s.scale[1]; e.scale[2] = s.scale[2]
      e.velocity[0] = s.velocity[0]; e.velocity[1] = s.velocity[1]; e.velocity[2] = s.velocity[2]
      e.bodyType = s.bodyType
      e.custom = s.custom ? JSON.parse(JSON.stringify(s.custom)) : null
      e._appState = untagAppState(s.appState)
      // AppContext caches `this._state = entity._appState` at construction time -- a live ctx object
      // holds its OWN reference, not a live read of entity._appState, so simply reassigning
      // entity._appState above would leave any already-constructed ctx.state pointing at the STALE
      // pre-restore object. Re-point the live context's cached reference too, or every subsequent
      // update()/onMessage/onInteract call for this entity would keep mutating the orphaned object.
      const ctx = this.contexts.get(id)
      if (ctx) ctx._state = e._appState
      this._markDirty(id)
    }
    for (const [id, t] of snap.respawnTimers) this._respawnTimer.set(id, { startTime: t.startTime, lastRespawn: t.lastRespawn })
    for (const [eid, list] of snap.timers) {
      if (!this.entities.has(eid)) continue
      this._timers.set(eid, list.map(t => ({ remaining: t.remaining, repeat: t.repeat, interval: t.interval, fn: t.fn })))
    }
    // interactCooldowns is optional on the snapshot shape (older snapshots taken before this row shipped
    // won't carry it) -- restoring is a no-op rather than a throw for a snapshot missing the field.
    if (snap.interactCooldowns) this._interactCooldowns = new Map(snap.interactCooldowns)
  }

  // rollback-resimulate-duplicate-emission-suppression: the orchestration-loop-owned lever named by that
  // row's own detail text ("tagging emissions with a resimulate-pass generation counter ... not something
  // a snapshot primitive can enforce on its own"). RollbackLoop.resimulateFrom (src/netcode/RollbackLoop.js)
  // is the ONLY intended caller: it calls setResimSuppressed(true) before every NON-FINAL corrective
  // resimulate pass over a tick range (a misprediction detector invoking resimulateFrom again before an
  // in-flight earlier correction's ticks have been superseded -- see rollback-misprediction-detector,
  // still pending, for the real trigger), and setResimSuppressed(false) for the actual FINAL pass whose
  // output a client should receive, or once the tick range has caught back up to newestTick with nothing
  // left to correct. "Final pass only", not "first pass only" or "every pass": an EARLIER pass over the
  // same range is the one guaranteed to be stale (a later correction is, by construction, superseding it),
  // so suppressing every pass except the last is the only policy that (a) never drops a real gameplay
  // event a client legitimately needs (the final pass's re-run still fires everything once) and (b) never
  // double-delivers one (every superseded pass's own copy is swallowed at the source before it reaches
  // broadcastToPlayers/sendToPlayer/EventLog.record). Bus emits (ctx.bus.emit, EventBus.js) are
  // DELIBERATELY NOT gated by this flag -- see this method's own inline note below -- because they drive
  // in-process cross-app state mutation (button->trigger-volume, capture-zone ownership, etc) that IS part
  // of simulateTick's deterministic per-tick simulation, identical in kind to a fireEvent(onCollision) call;
  // re-running that identically on every resimulate pass is the CORRECT replay behavior (the same reason
  // fireEvent itself is never suppressed), not a duplicate-output hazard. The one real duplicate-output
  // hazard bus emits DO carry -- the `_eventBus.on('*', ...)` auto-mirror into EventLog (see constructor) --
  // is already closed by gating EventLog.record itself below, with no need to touch bus dispatch at all.
  setResimSuppressed(v) {
    const was = this._resimSuppressed
    this._resimSuppressed = !!v
    // EventLog.pause()/resume() (src/netcode/EventLog.js) were shipped but never called anywhere in src/
    // until this row -- exactly the primitive a generation-scoped suppression needs, since it closes BOTH
    // this runtime's own internal _log() calls AND an app's direct ctx.eventLog.record() call (e.g.
    // apps/tps-game/server.js's hit_registered) with the same one flag, without needing every record() call
    // site to separately check runtime._resimSuppressed.
    if (this._eventLog) { if (this._resimSuppressed) this._eventLog.pause(); else this._eventLog.resume() }
    // rollback-entity-population-rewind: un-suppressing is exactly the "final pass settled" moment (see
    // that row's own header comment on spawnEntity/destroyEntity above) -- flush any spawn/destroy that
    // was requested WHILE suppressed now, through the real (no-longer-suppressed) methods. Only fires on
    // an actual true->false transition, not a redundant false->false call (RollbackLoop's finally-block
    // unconditionally calls setResimSuppressed(false) on every resimulateFrom exit, including a caller
    // that was never suppressed to begin with -- e.g. appRuntime omitted -- so this must not re-flush an
    // already-empty/already-flushed queue every single normal tick that happens to call this defensively).
    // rollback-population-inflight-async-commitment-at-suppression-start: _flushDeferredCommitmentOps
    // MUST run AFTER _flushDeferredPopulationOps, not before/interleaved -- a commitment continuation (an
    // _attachApp setup() resolving, an autoTrimesh resolving) that closes over an entityId which was ITSELF
    // only a deferred (queued) spawn needs that spawn's real spawnEntity(...) call -- and its resulting
    // this.entities.set(entityId,...) -- to have already run before the continuation's own
    // `this.entities.has(entityId)` liveness check can see it as live.
    if (was && !this._resimSuppressed) { this._flushDeferredPopulationOps(); this._flushDeferredCommitmentOps() }
  }
}
