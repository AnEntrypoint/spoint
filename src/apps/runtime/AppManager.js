import { AppContext } from '../AppContext.js'

export class AppManager {
  constructor(runtime) {
    this._runtime = runtime
    this.apps = new Map()
    this.contexts = new Map()
    this._appDefs = new Map()
    this._updateList = []
  }

  registerApp(name, appDef) { this._appDefs.set(name, appDef) }

  async attachApp(entityId, appName) {
    const entity = this._runtime.entities.get(entityId)
    const appDef = this._appDefs.get(appName)
    if (!entity || !appDef) return
    const ctx = new AppContext(entity, this._runtime)
    this.contexts.set(entityId, ctx); this.apps.set(entityId, appDef)
    await this._runtime._safeCall(appDef.server || appDef, 'setup', [ctx], `setup(${appName})`)
    this._rebuildUpdateList()
    this._runtime._rebuildCollisionList()
  }

  detachApp(entityId) {
    const appDef = this.apps.get(entityId), ctx = this.contexts.get(entityId)
    if (appDef && ctx) this._runtime._safeCall(appDef.server || appDef, 'teardown', [ctx], 'teardown')
    this._runtime._eventBus.destroyScope(entityId)
    this._runtime.clearTimers(entityId); this.apps.delete(entityId); this.contexts.delete(entityId)
    this._rebuildUpdateList()
    this._runtime._rebuildCollisionList()
  }

  _rebuildUpdateList() {
    this._updateList = []
    for (const [entityId, appDef] of this.apps) {
      const ctx = this.contexts.get(entityId); if (!ctx) continue
      const server = appDef.server || appDef
      if (typeof server.update === 'function') this._updateList.push([entityId, server, ctx])
    }
  }
}
