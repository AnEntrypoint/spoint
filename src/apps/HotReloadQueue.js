import { AppContext } from './AppContext.js'

// server-scale-hotreload-migrate-function-tick-fenced: state-preserving hot-reload semantics.
//
// Tick-fencing: HotReloadQueue.drain() is called from EXACTLY ONE place -- TickHandler.js's
// per-tick loop, once per tick, after movement/physics/snapshot have already run for that tick
// (see TickHandler.js's `appRuntime._drainReloadQueue()` call). enqueue() (called from
// AppLoader._onFileChange, itself driven by an async fs.watch callback) only ever pushes onto
// `_queue` -- it never calls _execute directly, so a file-change event landing mid-tick cannot
// tear down/rebuild a live entity's app state while that same tick's movement/physics/collision
// passes are still reading it. drain() itself is also re-entrancy-guarded (`_inProgress`), so a
// reload queued *during* drain() (e.g. a migrate() function that somehow re-triggers a reload)
// is deferred to the NEXT tick's drain() call rather than recursing mid-drain. This means a
// migrate() function is GUARANTEED to observe a fully-settled pre-reload entity state (this
// tick's simulation already finished) and never a torn half-old-half-new state.
//
// migrate() convention: an app module may export `migrate(oldState, fromVersion, toVersion)`
// (checked on `def.server || def`, matching every other lifecycle hook's server-vs-flat lookup)
// to reshape `entity._appState` (the object AppContext exposes as `ctx.state`) across a breaking
// field-shape change instead of losing/mismatching it wholesale. `fromVersion`/`toVersion` are a
// per-app-name monotonic counter (AppRuntime._appVersions, bumped once per real hot-reload of
// that app name -- NOT on every registerApp() call, since the initial loadAll() boot-time
// registration has no live entities/state to migrate and must not burn a version). migrate()'s
// return value REPLACES entity._appState wholesale (return the old state unchanged for a no-op
// migration); a thrown/rejecting migrate() is logged via the same _logAppError channel as any
// other app hook and falls back to leaving the old state untouched, so a broken migrate() can
// never corrupt state into a worse spot than "reload without migration" would have.
//
// hotreload-migrate-entity-custom-field: entity.custom is a SEPARATE data bag from entity._appState
// -- maker/editor-authored (editor inspector writes, data/placed-models.json debounced persist,
// SAVE_WORLD serialization, EditPanelDOM editorProps), not app runtime state -- so a breaking change
// to an app's expected custom.* shape needs its own migration path, not a silent reuse of the
// appState one. Chosen shape: the SAME migrate() export may optionally return a tagged dual-shape
// object `{ __hotReloadMigration: true, appState, custom }` instead of a bare appState, letting one
// export cover both bags without adding a second lifecycle hook. The tag exists so an app whose
// LEGITIMATE appState shape happens to itself be `{appState, custom}`-keyed is never misread as the
// dual-shape wrapper -- only an object carrying the exact marker is unwrapped; anything else
// (including undefined, null, or a plain object missing the marker) is treated as a bare appState
// return, fully backward compatible with every migrate() written before this convention existed.
// migrate() also gains a 4th argument, `oldCustom` (the entity's pre-reload entity.custom) -- without
// it a migrate() has no way to SEE the old custom shape to reshape it at all, only fromVersion/
// toVersion as bare integers. A pure additive signature change: every migrate() written against the
// original 3-arg (oldState, fromVersion, toVersion) convention still works unmodified, since JS
// silently drops an extra argument no parameter list declares.
// `custom` in the tagged return REPLACES entity.custom wholesale via the entity.custom SETTER (never
// a raw field write) so CustomVersion.js's installCustomVersion accessor re-wraps the new value in
// its dirty-tracking Proxy and bumps entity._customV -- SnapshotEncoder.js's custToStr dirty check
// reads _customV directly, so skipping the setter would silently desync the next snapshot's custom
// field from the migrated in-memory value. Same undefined-is-no-op / thrown-is-logged-and-untouched
// discipline as the appState half: a `custom` key present but `undefined` leaves the pre-migration
// custom untouched; a `custom` key present and non-undefined (including null, a real "clear it"
// intent) replaces it. Tick-fencing is inherited for free -- migrate() only ever runs inside
// _execute(), itself only ever reached via drain(), which carries the exact same guarantee this
// file's header comment already documents for _appState (drain() only runs once per tick, after that
// tick's movement/physics/collision/snapshot passes already read whatever custom shape was live at
// the start of the tick). Persistence: a migrated custom shape is correct in-memory immediately, but
// data/placed-models.json only gets rewritten by ctx.placedModelStorage's own 500ms debounce, normally
// triggered only from EditorHandlers.js's editor-mutation call sites -- _execute() below explicitly
// calls persist() itself (via runtime._placedModelStorage, wired by server.js/WorkerEntry.js at boot)
// whenever a migrate() call actually changed an entity's custom, so the migrated shape reaches disk
// on the same debounce cadence an editor edit would, not stuck waiting on the next unrelated edit.
export class HotReloadQueue {
  constructor(runtime) {
    this._runtime = runtime
    this._queue = []
    this._inProgress = false
  }

  enqueue(name, def, callback) {
    this._queue.push({ name, def, callback })
  }

  drain() {
    if (this._inProgress || this._queue.length === 0) return
    this._inProgress = true
    try {
      while (this._queue.length > 0) {
        const { name, def, callback } = this._queue.shift()
        try {
          this._execute(name, def)
          this._resetHeartbeats()
          if (callback) {
            try { callback(name, def) } catch (e) {
              console.error(`[HotReloadQueue] callback error:`, e.message)
            }
          }
        } catch (e) {
          console.error(`[HotReloadQueue] hotReload(${name}) error:`, e.message)
        }
      }
    } finally {
      this._inProgress = false
    }
  }

  _execute(name, def) {
    const rt = this._runtime
    rt._appDefs.set(name, def)
    // Version bump happens once per real _execute() call (i.e. once per genuine hot-reload of an
    // app that already had live entities), not on the initial boot-time registerApp() call -- the
    // very first load has no live entities/state to migrate and must not burn a version number.
    const fromVersion = rt._appVersions?.get(name) || 1
    const toVersion = fromVersion + 1
    if (rt._appVersions) rt._appVersions.set(name, toVersion)
    const migrateFn = (def.server || def)?.migrate
    let customMigrated = false
    for (const [eid, ent] of rt.entities) {
      if (ent._appName !== name) continue
      const old = rt.apps.get(eid), oldCtx = rt.contexts.get(eid)
      if (old && oldCtx) rt._safeCall(old.server || old, 'teardown', [oldCtx], 'teardown')
      rt.clearTimers(eid)
      if (typeof migrateFn === 'function') {
        try {
          // 4th arg (oldCustom) is a pure ADDITION: every migrate() written before this row's own change
          // still declares only (oldState, fromVersion, toVersion) and simply never reads the extra
          // argument JS silently supplies -- no existing call site breaks.
          const migrated = migrateFn(ent._appState, fromVersion, toVersion, ent.custom)
          // Tagged dual-shape return: only an object carrying the exact __hotReloadMigration marker is
          // unwrapped into separate appState/custom halves -- see this file's header comment.
          if (migrated !== null && typeof migrated === 'object' && migrated.__hotReloadMigration === true) {
            // undefined = "migrate ran but has nothing to change" for EITHER half independently (a
            // migrate() touching only custom can omit appState entirely, and vice versa) -- distinct
            // from a real intended null/empty value, so only undefined skips the assignment.
            if (migrated.appState !== undefined) ent._appState = migrated.appState
            if (migrated.custom !== undefined) {
              // Through the real setter (never a raw field write): CustomVersion.js's installCustomVersion
              // accessor re-wraps the new value in its dirty-tracking Proxy and bumps entity._customV, which
              // SnapshotEncoder.js's custToStr reads directly for the next snapshot's dirty check.
              ent.custom = migrated.custom
              customMigrated = true
              // Entity-level dirty bump (_entityVersions), same call restoreGameState already makes
              // after mutating entity.custom -- distinct from the _customV bump the setter above already
              // did (that one drives SnapshotEncoder's custom-field-specific dirty check; this one is the
              // general entity-changed signal other delta-encoding paths consult).
              rt._markDirty(eid)
            }
          } else if (migrated !== undefined) {
            // Bare appState return -- the original, still-supported convention.
            ent._appState = migrated
          }
        } catch (e) {
          rt._logAppError(`migrate(${name})`, e)
        }
      }
      const ctx = new AppContext(ent, rt)
      rt.contexts.set(eid, ctx)
      rt.apps.set(eid, def)
      // Same fire-and-forget-setup race as AppRuntime._attachApp (see its _pendingSetupIds comment):
      // a hot-reloaded app's async setup() (e.g. tps-game's loadScoreboard) can still be in flight when
      // a fireEvent (onMessage/onCollision/onInteract) reaches this entity -- a live server hot-reloading
      // an app while players are connected is exactly the scenario where an in-flight message is likely.
      // Reuses the identical pending/queue/flush mechanism so hot-reload gets the same protection as the
      // initial _attachApp path, not a second bespoke fix.
      rt._pendingSetupIds.add(eid)
      Promise.resolve(rt._safeCall(def.server || def, 'setup', [ctx], `hotReload(${name})`)).finally(() => {
        rt._pendingSetupIds.delete(eid)
        rt._flushPendingEvents(eid)
      })
    }
    // Trigger the SAME debounced placed-models.json persist an editor edit already triggers, once per
    // _execute() call (not per-entity -- matches persist()'s own trailing-debounce/collapse-latest-state
    // discipline) whenever a migrate() call actually replaced at least one entity's custom. A reload with
    // no migrate(), or a migrate() that only touched _appState, never calls persist() -- no on-disk shape
    // changed, so no write is warranted. runtime._placedModelStorage is wired at boot by
    // server.js/WorkerEntry.js (see AppRuntime.setPlacedModelStorage); absent in any harness/host that
    // never wires it (e.g. a scratch test harness), so this stays a no-op there rather than throwing.
    if (customMigrated && rt._placedModelStorage) rt._placedModelStorage.persist(rt)
  }

  _resetHeartbeats() {
    const conn = this._runtime._connections
    if (!conn) return
    for (const client of conn.clients.values()) {
      client.lastHeartbeat = Date.now()
    }
  }

  get pending() {
    return this._queue.length
  }
}
