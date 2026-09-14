import { createServer, buildStaticDirs } from './server.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

export class RoomDirectory {
  constructor({ sdkRoot, projectRoot, portRange = [19000, 19999] } = {}) {
    if (!sdkRoot) throw new Error('RoomDirectory requires { sdkRoot }')
    this.sdkRoot = sdkRoot
    this.projectRoot = projectRoot || sdkRoot
    this.portRange = portRange
    this.rooms = new Map()
    this._reservedPorts = new Set()
  }

  async _loadWorldDef(worldName) {
    const localWorld = resolve(this.projectRoot, `apps/world/${worldName}.js`)
    const fallbackLocal = resolve(this.projectRoot, 'apps/world/index.js')
    const worldPath = existsSync(localWorld) ? localWorld
      : existsSync(fallbackLocal) ? fallbackLocal
      : resolve(this.sdkRoot, 'apps/world/index.js')
    const worldDef = (await import(pathToFileURL(worldPath).href + `?t=${Date.now()}`)).default || {}
    return worldDef
  }

  _nextFreePort() {
    const [min, max] = this.portRange
    for (let p = min; p <= max; p++) {
      if (this._reservedPorts.has(p)) continue
      let inUse = false
      for (const r of this.rooms.values()) { if (r.port === p) { inUse = true; break } }
      if (!inUse) return p
    }
    throw new Error(`RoomDirectory: port range [${min},${max}] exhausted (${this.rooms.size} room(s) already hosted)`)
  }

  async createRoom(roomId, worldName, opts = {}) {
    if (this.rooms.has(roomId)) throw new Error(`RoomDirectory: roomId "${roomId}" already exists -- stop it first or choose a different id`)
    const port = opts.port ?? this._nextFreePort()
    if (this._reservedPorts.has(port)) throw new Error(`RoomDirectory: port ${port} already reserved by an in-flight createRoom() call`)
    this._reservedPorts.add(port)
    try {
      const worldDef = await this._loadWorldDef(worldName)
      const appsDirs = [resolve(this.projectRoot, 'apps')]
      const config = {
        port, tickRate: worldDef.tickRate || 60, appsDirs, sdkRoot: this.sdkRoot,
        gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
        physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0,
        entityTickRate: worldDef.entityTickRate,
        staticDirs: buildStaticDirs(this.sdkRoot, this.projectRoot, appsDirs),
        ...opts.configOverrides,
      }
      const server = await createServer(config)
      await server.loadWorld(worldDef)
      const info = await server.start()
      const handle = { roomId, worldName, port: info.port, server, bootedAt: Date.now() }
      this.rooms.set(roomId, handle)
      return handle
    } finally {
      this._reservedPorts.delete(port)
    }
  }

  getRoom(roomId) { return this.rooms.get(roomId) }

  listRooms() { return [...this.rooms.values()] }

  async stopRoom(roomId) {
    const handle = this.rooms.get(roomId)
    if (!handle) return false
    await handle.server.flushAll().catch(e => console.error(`[RoomDirectory] flushAll error for room "${roomId}":`, e?.message || e))
    handle.server.stop()
    this.rooms.delete(roomId)
    return true
  }

  async stopAll() {
    await Promise.allSettled([...this.rooms.keys()].map(id => this.stopRoom(id)))
  }

  getStatus() {
    return this.listRooms().map(r => {
      const ts = r.server.tickSystem
      const budgets = ts._tickBudgetMs || []
      const avgTickMs = budgets.length ? ts._tickBudgetSum / budgets.length : 0
      return {
        roomId: r.roomId, worldName: r.worldName, port: r.port,
        uptimeMs: Date.now() - r.bootedAt,
        tick: ts.currentTick,
        players: r.server.playerManager.getPlayerCount(),
        entities: r.server.runtime.entities.size,
        avgTickMs, dilationFactor: ts.dilationFactor,
      }
    })
  }
}
