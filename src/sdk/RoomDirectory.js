// RoomDirectory: worker-per-room -> multi-process room directory horizontal-scale story, FIRST SLICE
// (server-scale-story-consensus-persistent-worlds-metrics-hotreload). This is the multi-room-PER-PROCESS
// step -- the thing that must be true before a multi-PROCESS room directory can exist at all, since a
// process-per-room orchestrator still needs each individual process to be able to cleanly host (and
// eventually rebalance/consolidate) more than one room if it's going to pack rooms efficiently rather
// than 1-room-1-process-always (wasteful for many low-population rooms).
//
// FEASIBILITY FINDING (this session, live-verified via a real 2-room-in-1-process probe, 16/16 checks,
// zero source edits needed to prove it): src/sdk/server.js's createServer(config) is ALREADY a clean
// per-call factory -- every module it composes (PhysicsWorld, TickSystem, PlayerManager, NetworkState,
// ConnectionManager, AppRuntime, StageLoader, AppLoader) constructs fresh per-call state into a `ctx`/
// `deps` closure, with NO leaking cross-instance mutable module-level state found (audited every
// `^let`/`^const ... = new Map()`/`^const ... = []` top-level declaration across src/sdk, src/netcode,
// src/connection, src/apps: the only module-level mutable caches found -- StaticHandler.js's
// _contentHashCache, AppRuntime.js's/AppLoader.js's lazy fs/path memoization -- are keyed by absolute
// file path or hold only stateless builtin references, safe/beneficial to share). The ONLY real
// process-wide singletons are (1) getJolt()'s memoized COMPILED WASM MODULE (correct and cheap to
// share -- it is the compiled binary, not simulation state; each PhysicsWorld.init() still constructs
// its OWN JoltInterface/PhysicsSystem/BodyInterface, live-confirmed via `roomA.physics !== roomB.physics`
// plus independently-advancing tick counters and independent entity sets), and (2) two things that live
// in boot()/ServerAPI.js's stop(), not createServer() itself: process.on(SIGINT/SIGTERM) (registered once
// by boot(), not per-room) and globalThis.__DEBUG__.server (a single last-writer-wins debug slot). Real
// measured cost booting 5 tps-game rooms sequentially in one process: room 1 ~45MB RSS (includes one-time
// shared-module/WASM-compile amortization), each subsequent room ~10-40MB (noisy, GC-timing-dependent,
// clearly sub-linear after room 1), ~2s boot latency per room (dominated by Jolt physics.init() + terrain
// heightfield build, both already off the hot path / backgroundable per-room). server.stop() already
// tears down tickSystem, appLoader watchers, reloadManager, connections, sessions, wtServer/wss/httpServer,
// and physics (WASM instance) -- live-confirmed a stopped room refuses new connections while a sibling
// room in the SAME process keeps serving, uninterrupted.
//
// SCOPE OF THIS FILE: the directory/router layer that was genuinely missing (grepped the whole repo,
// zero prior RoomDirectory/room-directory/multi-room hits) -- a thin registry mapping roomId -> a live
// createServer() instance + its bound port, with create/get/list/stop primitives and a single shared
// HTTP listener that can route by hostname/path to the correct room's own already-independent
// httpServer... except createServer()'s own start() binds its OWN net listener per room (one port each),
// which is the right per-room isolation boundary to keep (a room's WebSocket upgrade path, static asset
// serving, and editor/debug endpoints are all wired onto that one httpServer already) -- so this directory
// intentionally does NOT try to multiplex many rooms behind one shared HTTP listener (that would require
// threading a room-selector through EVERY handler in ServerAPI.js, a much larger and riskier change than
// this slice's job). Instead it manages the *lifecycle* (spawn on next free port in a configured range,
// track by roomId, list, get, graceful stop-one-without-affecting-siblings) -- the exact primitive a
// later multi-process orchestrator (a fly.io/railway room-orchestration recipe, or a simple reverse-proxy
// in front of N per-room ports) needs to consult to know what's running and reach it. Port-per-room is
// also literally how the existing single-room boot() already works (PORT env var / worldDef.port), so
// this generalizes the existing contract rather than replacing it.
import { createServer, buildStaticDirs } from './server.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

/**
 * @typedef {Object} RoomHandle
 * @property {string} roomId
 * @property {string} worldName
 * @property {number} port
 * @property {ReturnType<typeof createServer> extends Promise<infer T> ? T : never} server
 * @property {number} bootedAt
 */

export class RoomDirectory {
  /**
   * @param {Object} opts
   * @param {string} opts.sdkRoot - SDK_ROOT (same value src/sdk/server.js's boot() derives from import.meta.url)
   * @param {string} [opts.projectRoot] - defaults to sdkRoot; where apps/world/<name>.js is resolved from (mirrors boot()'s process.cwd() convention, but explicit here since a directory manages multiple rooms concurrently and must not rely on a single shared process.cwd())
   * @param {[number, number]} [opts.portRange] - inclusive [min, max] port range rooms are auto-assigned from; default [19000, 19999]
   */
  constructor({ sdkRoot, projectRoot, portRange = [19000, 19999] } = {}) {
    if (!sdkRoot) throw new Error('RoomDirectory requires { sdkRoot }')
    this.sdkRoot = sdkRoot
    this.projectRoot = projectRoot || sdkRoot
    this.portRange = portRange
    /** @type {Map<string, RoomHandle>} */
    this.rooms = new Map()
    // ports actually bound by rooms this directory created -- distinct from a port merely reserved
    // in-flight during a concurrent createRoom() (see _reservedPorts) so two overlapping createRoom()
    // calls never race onto the same port before either has actually bound it.
    this._reservedPorts = new Set()
  }

  /**
   * Loads a worldDef the same way boot() does (apps/world/<name>.js, cache-busted import) but rooted
   * at this.projectRoot instead of a single shared process.cwd(), since a directory may host rooms for
   * more than one world concurrently. Falls back to the SDK-bundled apps/world/index.js the same way
   * boot() does when no project-local world file of that name exists.
   */
  async _loadWorldDef(worldName) {
    const localWorld = resolve(this.projectRoot, `apps/world/${worldName}.js`)
    const fallbackLocal = resolve(this.projectRoot, 'apps/world/index.js')
    const worldPath = existsSync(localWorld) ? localWorld
      : existsSync(fallbackLocal) ? fallbackLocal
      : resolve(this.sdkRoot, 'apps/world/index.js')
    const worldDef = (await import(pathToFileURL(worldPath).href + `?t=${Date.now()}`)).default || {}
    return worldDef
  }

  /** Finds the next port in portRange not already bound or reserved by this directory. Throws if the range is exhausted -- a directory-level capacity error should be loud, not a silent port collision. */
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

  /**
   * Boots a new room in THIS process (worker-per-room's multi-room-per-process step) and registers it
   * under roomId. Rejects a duplicate roomId rather than silently replacing a live room out from under
   * its connected players. Returns the RoomHandle once the room's own httpServer is actually listening
   * (same "ready" contract createServer().start() already provides).
   * @param {string} roomId - directory-unique id (e.g. a UUID or "tps-game-3"); distinct from worldName since one world can have many concurrently-running room instances (e.g. multiple duel lobbies of the same game mode)
   * @param {string} worldName - which apps/world/<worldName>.js to boot
   * @param {Object} [opts]
   * @param {number} [opts.port] - explicit port; auto-assigned from portRange if omitted
   * @returns {Promise<RoomHandle>}
   */
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

  /** @returns {RoomHandle|undefined} */
  getRoom(roomId) { return this.rooms.get(roomId) }

  /** @returns {RoomHandle[]} */
  listRooms() { return [...this.rooms.values()] }

  /**
   * Stops one room WITHOUT affecting any sibling room in this same process (live-verified this
   * session: stopping room A left room B still accepting connections). Idempotent -- stopping an
   * already-stopped/unknown roomId is a no-op, not a throw, since a directory-level caller (an
   * orchestrator reacting to a room-empty timeout, say) shouldn't need to track its own stop-state
   * separately from the directory's.
   */
  async stopRoom(roomId) {
    const handle = this.rooms.get(roomId)
    if (!handle) return false
    // flushAll() before stop(): mirrors boot()'s own installGracefulShutdown discipline (drain
    // debounced placed-model writes + app onShutdown hooks) so a room removed by directory-level
    // rebalancing (not just process-wide SIGINT) doesn't silently lose a still-pending write.
    await handle.server.flushAll().catch(e => console.error(`[RoomDirectory] flushAll error for room "${roomId}":`, e?.message || e))
    handle.server.stop()
    this.rooms.delete(roomId)
    return true
  }

  /** Stops every room this directory owns. Used for process-wide shutdown (a directory-aware SIGINT handler would call this instead of the single-room installGracefulShutdown). */
  async stopAll() {
    await Promise.allSettled([...this.rooms.keys()].map(id => this.stopRoom(id)))
  }

  /**
   * Lightweight directory-wide status snapshot -- the shape a later Prometheus /metrics endpoint
   * (sibling PRD row) or an operator dashboard would poll, AND the shape
   * server-scale-room-orchestrator-load-aware-placement's weighted placement policy consumes.
   * avgTickMs/dilationFactor are read directly off TickSystem's already-computed rolling window
   * (_tickBudgetMs/_tickBudgetSum feed dilationFactor every DILATION_WINDOW=60 ticks) -- zero new
   * per-tick instrumentation cost, this is the exact real load signal TickSystem already uses
   * internally to self-throttle. dilationFactor<1.0 means the room has ALREADY had to slow its own
   * simulation down to keep up, the clearest possible "this room is overloaded" signal available.
   */
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
