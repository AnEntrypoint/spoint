import { createServer, buildStaticDirs } from './server.js'
import { resolve } from 'node:path'
import { locateWorld, loadWorldModule } from './WorldLocator.js'
import { worldTickRate } from '../shared/worldDefaults.js'

const MAX_PORT = 65535

class RoomDirectoryError extends Error {
  constructor(reasonCode, message) {
    super(`RoomDirectory: ${message}`)
    this.name = 'RoomDirectoryError'
    this.reasonCode = reasonCode
  }
}

const isPort = (value, min) => Number.isInteger(value) && value >= min && value <= MAX_PORT

function parsePortRange(range) {
  if (!Array.isArray(range) || range.length !== 2 || !isPort(range[0], 1) || !isPort(range[1], 1) || range[0] > range[1]) {
    throw new RoomDirectoryError('room-port-range-invalid', `portRange must be [min, max] integers in 1..${MAX_PORT} with min <= max, got ${JSON.stringify(range)}`)
  }
  return [range[0], range[1]]
}

function parseHost(host) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new RoomDirectoryError('room-host-invalid', `host must be a non-empty string, got ${typeof host} ${String(host)}`)
  }
  return host
}

export class RoomDirectory {
  constructor({ sdkRoot = null, projectRoot = null, portRange = [19000, 19999], host = '0.0.0.0' } = {}) {
    if (!sdkRoot) throw new Error('RoomDirectory requires { sdkRoot }')
    this.sdkRoot = sdkRoot
    this.projectRoot = projectRoot || sdkRoot
    this.portRange = parsePortRange(portRange)
    this.host = parseHost(host)
    this.rooms = new Map()
    this.testers = new Map()
    this._reservedPorts = new Set()
  }

  async _locateWorld(worldName) {
    const located = await locateWorld({ project: this.projectRoot, sdkRoot: this.sdkRoot, name: worldName || null })
    return { name: located.name, path: located.path, worldDef: await loadWorldModule(located.path) }
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

  _resolvePort(requested) {
    if (requested == null) return this._nextFreePort()
    if (!isPort(requested, 0)) throw new RoomDirectoryError('room-port-invalid', `port must be an integer in 0..${MAX_PORT} (0 asks the OS for a free port), got ${typeof requested} ${String(requested)}`)
    if (requested === 0) return 0
    for (const r of this.rooms.values()) {
      if (r.port === requested) throw new RoomDirectoryError('room-port-in-use', `port ${requested} is already hosted by room "${r.roomId}"`)
    }
    if (this._reservedPorts.has(requested)) throw new RoomDirectoryError('room-port-in-use', `port ${requested} already reserved by an in-flight createRoom() call`)
    return requested
  }

  async createRoom(roomId, worldName, opts = {}) {
    if (this.rooms.has(roomId)) throw new Error(`RoomDirectory: roomId "${roomId}" already exists -- stop it first or choose a different id`)
    const port = this._resolvePort(opts.port)
    if (port !== 0) this._reservedPorts.add(port)
    try {
      const { name: resolvedWorldName, path: worldPath, worldDef } = await this._locateWorld(worldName)
      const appsDirs = [resolve(this.projectRoot, 'apps')]
      const config = {
        port, host: this.host, tickRate: worldTickRate(worldDef), appsDirs, sdkRoot: this.sdkRoot,
        gravity: worldDef.gravity, movement: worldDef.movement, playerConfig: worldDef.player,
        physicsRadius: worldDef.physicsRadius || 0, physicsBodyBudget: worldDef.physicsBodyBudget || 0,
        entityTickRate: worldDef.entityTickRate,
        staticDirs: buildStaticDirs(this.sdkRoot, this.projectRoot, appsDirs),
        worldName: resolvedWorldName, worldPath,
        ...opts.configOverrides,
      }
      const server = await createServer(config)
      try {
        await server.loadWorld(worldDef, resolvedWorldName)
        const info = await server.start()
        const handle = { roomId, worldName: resolvedWorldName, port: info.port, server, bootedAt: Date.now(), requestedWorldName: worldName || null, configOverrides: opts.configOverrides || {} }
        this.rooms.set(roomId, handle)
        return handle
      } catch (e) {
        try { server.stop() } catch (stopErr) { console.error(`[RoomDirectory] stop after a failed world load for room "${roomId}" failed:`, stopErr?.message || stopErr) }
        throw e
      }
    } finally {
      this._reservedPorts.delete(port)
    }
  }

  getRoom(roomId) { return this.rooms.get(roomId) }

  listRooms() { return [...this.rooms.values()] }

  joinTester(roomId, testerId) {
    if (!this.rooms.has(roomId)) throw new Error(`RoomDirectory: cannot join tester "${testerId}" to unknown room "${roomId}"`)
    if (typeof testerId !== 'string' || testerId.length === 0) throw new Error('RoomDirectory: testerId must be a non-empty string')
    const record = { testerId, roomId, joinedAt: Date.now() }
    this.testers.set(testerId, record)
    return record
  }

  leaveTester(testerId) { return this.testers.delete(testerId) }

  listTesters(roomId = null) {
    return [...this.testers.values()].filter(t => roomId === null || t.roomId === roomId)
  }

  async stopRoom(roomId) {
    const handle = this.rooms.get(roomId)
    if (!handle) return false
    await handle.server.flushAll().catch(e => console.error(`[RoomDirectory] flushAll error for room "${roomId}":`, e?.message || e))
    handle.server.stop()
    this.rooms.delete(roomId)
    for (const t of this.listTesters(roomId)) this.testers.delete(t.testerId)
    return true
  }

  async resetRoom(roomId) {
    const handle = this.rooms.get(roomId)
    if (!handle) return null
    const { port, requestedWorldName, configOverrides } = handle
    await this.stopRoom(roomId)
    return this.createRoom(roomId, requestedWorldName, { port, configOverrides })
  }

  async stopAll() {
    await Promise.allSettled([...this.rooms.keys()].map(id => this.stopRoom(id)))
  }

  getRoomStatus(roomId) {
    const r = this.rooms.get(roomId)
    if (!r) return null
    const ts = r.server.tickSystem
    const budgets = ts._tickBudgetMs || []
    const avgTickMs = budgets.length ? ts._tickBudgetSum / budgets.length : 0
    return {
      roomId: r.roomId, worldName: r.worldName, port: r.port,
      bootedAt: r.bootedAt,
      uptimeMs: Date.now() - r.bootedAt,
      tick: ts.currentTick,
      players: r.server.playerManager.getPlayerCount(),
      entities: r.server.runtime.entities.size,
      avgTickMs, dilationFactor: ts.dilationFactor,
    }
  }

  getStatus() {
    return this.listRooms().map(r => this.getRoomStatus(r.roomId))
  }
}
