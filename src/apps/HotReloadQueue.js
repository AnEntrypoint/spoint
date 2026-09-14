import { AppContext } from './AppContext.js'

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
          const migrated = migrateFn(ent._appState, fromVersion, toVersion, ent.custom)
          const isDualShapeMigration = migrated !== null && typeof migrated === 'object' && migrated.__hotReloadMigration === true
          if (isDualShapeMigration) {
            if (migrated.appState !== undefined) ent._appState = migrated.appState
            if (migrated.custom !== undefined) {
              ent.custom = migrated.custom
              customMigrated = true
              rt._markDirty(eid)
            }
          } else if (migrated !== undefined) {
            ent._appState = migrated
          }
        } catch (e) {
          rt._logAppError(`migrate(${name})`, e)
        }
      }
      const ctx = new AppContext(ent, rt)
      rt.contexts.set(eid, ctx)
      rt.apps.set(eid, def)
      rt._pendingSetupIds.add(eid)
      Promise.resolve(rt._safeCall(def.server || def, 'setup', [ctx], `hotReload(${name})`)).finally(() => {
        rt._pendingSetupIds.delete(eid)
        rt._flushPendingEvents(eid)
      })
    }
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
