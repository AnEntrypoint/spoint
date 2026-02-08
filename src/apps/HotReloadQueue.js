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
    for (const [eid, ent] of rt.entities) {
      if (ent._appName !== name) continue
      const old = rt.apps.get(eid), oldCtx = rt.contexts.get(eid)
      if (old && oldCtx) rt._safeCall(old.server || old, 'teardown', [oldCtx], 'teardown')
      rt.clearTimers(eid)
      const ctx = new AppContext(ent, rt)
      rt.contexts.set(eid, ctx)
      rt.apps.set(eid, def)
      rt._safeCall(def.server || def, 'setup', [ctx], `hotReload(${name})`)
    }
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
