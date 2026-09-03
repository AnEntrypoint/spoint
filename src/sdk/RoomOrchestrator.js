// RoomOrchestrator: the multi-PROCESS step server-scale-multiprocess-room-orchestrator-deploy-recipe's
// own title names, built on top of the already-shipped src/sdk/RoomDirectory.js (multi-room-PER-process)
// and this session's new src/sdk/RoomProcessWorker.js (the child_process entry that hosts one
// RoomDirectory each). This is the PARENT process: spawns N real Node child_process workers (each an
// independent RoomProcessWorker running its own RoomDirectory, hence its own independent Jolt WASM
// instance/tick loop/event loop -- a stall or crash in one worker cannot touch a sibling worker's
// rooms, the real isolation boundary process-per-worker buys that thread-per-worker wouldn't), tracks
// which worker hosts which roomId, and applies a LOAD-AWARE ROOM-PLACEMENT policy when createRoom is
// called without an explicit workerIndex: weighted by REAL live per-room player/entity/tick-timing
// data (RoomDirectory.getStatus()'s players/entities/avgTickMs/dilationFactor fields, fanned out live
// via GET_STATUS IPC every placement call -- see _pickWeightedWorker), not round-robin and not a bare
// room-count bin-pack -- this is the "pack low-population rooms together rather than always
// 1-room-1-process, AND don't let one popular room starve its siblings" behavior
// server-scale-room-orchestrator-load-aware-placement's own row asks for (room-count-only bin-packing,
// _pickLeastLoadedWorker, is kept as the pure-structural fallback for a worker with no status data
// yet). Weighted-by-live-load was chosen over round-robin for the same self-correcting reason the
// original room-count policy was: round-robin's advancing pointer does not self-correct when rooms
// stop unevenly OR when population shifts unevenly across already-placed rooms, whereas a live-status
// fan-out recomputes from ACTUAL current load every single call with no separate rebalance pass needed.
//
// Router surface: `route(roomId)` returns { port, host } (or undefined if the room isn't known) for an
// operator-facing HTTP layer (see bin/room-orchestrator-boot.js) to redirect/proxy a client's
// connection request to the correct per-room port -- deliberately NOT a WebSocket-frame-forwarding
// proxy like RegionRouter.js (that project shards ONE world's live traffic across workers and must
// keep every frame flowing through the router process; this one is N independent, already-complete
// per-room servers each with their own working httpServer+WSServer, so the cheapest and most robust
// router is "tell the client which port to actually connect to" -- one HTTP redirect/JSON lookup per
// room-join, zero steady-state proxy overhead, and a router process crash never drops an in-progress
// game connection since players are talking directly to their room's own port).
//
// CROSS-MACHINE ROUTING (server-scale-room-orchestrator-cross-machine-routing):
// Each worker entry now carries a `host` field (defaults to '127.0.0.1' for locally-forked workers).
// `route(roomId)` returns the worker's actual host, not a hardcoded default -- so a worker running on
// a genuinely separate fly.io Machine (registered via `registerWorker()` or the HTTP /workers/register
// endpoint) can return its own public fly.io hostname, and a client connecting to the routed
// host:port pair reaches the correct Machine.  Local workers (forked via _spawnWorker/spawnWorker)
// still default to '127.0.0.1' unless overridden via the constructor's `workerHosts` option.
//
// WORKER CRASH AUTO-RESTART (same row):
// When a locally-forked worker exits unexpectedly, the orchestrator can auto-restart it (configurable
// via `restartOnCrash`, `maxRestarts`, `restartWindowMs`).  A per-worker sliding-window crash count
// prevents infinite restart loops.  Restarted workers start with empty rooms (fresh state) -- state
// recovery across crashes depends on the separate
// server-scale-persistent-world-snapshot-restart-survival row, out of this row's scope.
// External workers (registered via HTTP, not forked) are never auto-restarted -- the orchestrator
// cannot fork a process on a different machine.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readJsonBody, httpJsonRequest, scoreWorkerRooms, startRoomOrchestratorRouter } from './RoomOrchestratorHttp.js'

// Re-exported from RoomOrchestratorHttp.js for backward compatibility -- bin/room-orchestrator-boot.js
// imports readJsonBody from this file's own path.
export { readJsonBody }

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKER_ENTRY = join(SDK_ROOT, 'src', 'sdk', 'RoomProcessWorker.js')

export class RoomOrchestrator {
  /**
   * @param {Object} opts
   * @param {string} opts.sdkRoot
   * @param {string} [opts.projectRoot]
   * @param {number} [opts.workerCount] - number of child_process workers to spawn; default 2
   * @param {[number, number]} [opts.portRange] - port range EACH worker's own RoomDirectory draws room ports from; workers are given non-overlapping sub-ranges automatically to avoid two workers racing onto the same port with zero shared state to coordinate through (see _subRangeFor)
   * @param {Object<string,string>} [opts.workerHosts] - per-worker host overrides (workerIndex -> hostname). Locally-forked workers default to '127.0.0.1'; external workers supply their own host via registerWorker(). route() returns the per-worker host, so a client connecting to the routed host:port pair reaches the correct Machine.
   * @param {boolean} [opts.restartOnCrash] - whether to auto-restart a locally-forked worker that exits unexpectedly; default true
   * @param {number} [opts.maxRestarts] - max restarts per worker within restartWindowMs; default 3
   * @param {number} [opts.restartWindowMs] - sliding window for crash rate limiting; default 60000
   */
  constructor({ sdkRoot, projectRoot, workerCount = 2, portRange = [19000, 19999], elasticScaling = false, elasticScaleUpThreshold = 0.8, elasticScaleDownCooldownMs = 120000, elasticScaleCheckIntervalMs = 30000, workerHosts = {}, restartOnCrash = true, maxRestarts = 3, restartWindowMs = 60000, externalWorkerHeartbeatIntervalMs = 10000 } = {}) {
    if (!sdkRoot) throw new Error('RoomOrchestrator requires { sdkRoot }')
    this.sdkRoot = sdkRoot
    this.projectRoot = projectRoot || sdkRoot
    this.workerCount = workerCount // initial worker count at boot; may increase with elastic scaling
    this.portRange = portRange
    /** @type {Array<{proc: import('node:child_process').ChildProcess, ready: boolean, roomIds: Set<string>, host: string, isExternal: boolean}>} */
    this.workers = []
    /** @type {Map<string, {workerIndex: number, port: number, worldName: string}>} */
    this.roomToWorker = new Map()
    this._nextReqId = 1
    this._pending = new Map() // reqId -> {resolve, reject}
    this.httpServer = null
    // Cross-machine: per-worker host overrides (applied at spawn time, persisted for route())
    this._workerHosts = workerHosts
    // Crash auto-restart state (per locally-forked worker, never external)
    this._restartOnCrash = restartOnCrash
    this._maxRestarts = maxRestarts
    this._restartWindowMs = restartWindowMs
    this._crashTimestamps = new Map() // workerIndex -> [timestamp, ...] sliding window of crash times
    this._restartCounts = new Map() // workerIndex -> total restarts (for monitoring)
    // Elastic scaling state
    this._elasticScaling = elasticScaling
    this._elasticScaleUpThreshold = elasticScaleUpThreshold
    this._elasticScaleDownCooldownMs = elasticScaleDownCooldownMs
    this._elasticScaleCheckIntervalMs = elasticScaleCheckIntervalMs
    this._elasticTimer = null
    this._nextWorkerIndex = workerCount // monotonic counter for sub-range assignment; starts after initial workers
    this._freedSubRanges = [] // [min,max] ranges freed by retired workers, reusable by spawnWorker()
    this._emptiedAt = new Map() // workerIndex -> timestamp when it last became empty (for scale-down cooldown)
    this._retiring = new Set() // workerIndexes currently draining (reject new room placement, retiring handled by _onWorkerRetired once empty)
    this._elasticStats = { spawns: 0, retires: 0, lastCheck: 0, lastDecision: '' }
    this._externalWorkerHeartbeatIntervalMs = externalWorkerHeartbeatIntervalMs
    this._externalHeartbeatTimer = null
  }

  // Non-overlapping sub-range per worker so N independent RoomDirectory instances (each with zero
  // knowledge of its siblings' bound ports -- process isolation means they cannot share a Set/Map)
  // never race onto the same port. Evenly splits [min,max] into workerCount contiguous blocks.
  // For dynamic scaling: reuses a freed sub-range from a retired worker first, otherwise allocates
  // a new block from the remaining range using the monotonic _nextWorkerIndex.
  _subRangeFor(workerIndex) {
    const [min, max] = this.portRange
    // Reuse a freed sub-range from a previously retired worker if available
    if (this._freedSubRanges.length > 0) return this._freedSubRanges.shift()
    const span = max - min + 1
    const blockSize = Math.floor(span / this.workerCount)
    const subMin = min + workerIndex * blockSize
    const subMax = workerIndex === this.workerCount - 1 ? max : subMin + blockSize - 1
    return [subMin, subMax]
  }

  /** Dynamically spawns a NEW worker process, expanding the fleet beyond the initial workerCount.
   *  Assigns a non-overlapping port sub-range (reuses a freed range from a retired worker first,
   *  otherwise allocates a fresh block from the remaining range via the monotonic _nextWorkerIndex).
   *  Returns { workerIndex, pid } once the worker reports ready. */
  async spawnWorker() {
    const workerIndex = this._nextWorkerIndex++
    const host = this._workerHosts[workerIndex] || '127.0.0.1'
    const entry = { proc: null, ready: false, roomIds: new Set(), host, isExternal: false }
    this.workers[workerIndex] = entry
    this.workerCount = Math.max(this.workerCount, workerIndex + 1)
    const proc = await new Promise((resolve, reject) => {
      const p = fork(WORKER_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      entry.proc = p
      let settled = false
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`spawnWorker: worker ${workerIndex} did not become ready in time`)) } }, 15000)
      p.on('message', (msg) => {
        if (msg?.type === 'WORKER_READY') { if (settled) return; settled = true; clearTimeout(timeout); entry.ready = true; resolve(p) }
        else this._handleWorkerMessage(workerIndex, msg)
      })
      p.on('exit', (code, signal) => {
        const wasReady = entry.ready
        const roomCount = entry.roomIds.size
        const isAbnormal = code !== 0 || signal != null
        console.error(`[RoomOrchestrator] worker ${workerIndex} (pid ${p.pid}) exited (code=${code} signal=${signal}) -- its ${roomCount} room(s) are now unreachable`)
        for (const roomId of entry.roomIds) this.roomToWorker.delete(roomId)
        entry.ready = false
        // CRASH AUTO-RESTART: only for abnormal exits (non-zero code or killed by signal).
        // A clean code=0 exit (e.g. SHUTDOWN) is intentional and should not restart.
        if (isAbnormal) this._maybeRestartWorker(workerIndex, wasReady)
      })
      p.on('error', (e) => { console.error(`[RoomOrchestrator] worker ${workerIndex} fork error:`, e.message); if (!settled) { settled = true; clearTimeout(timeout); reject(e) } })
      p.send({ type: 'INIT', sdkRoot: this.sdkRoot, projectRoot: this.projectRoot, portRange: this._subRangeFor(workerIndex) })
    })
    this._elasticStats.spawns++
    this._emptiedAt.delete(workerIndex) // fresh worker is not empty yet
    return { workerIndex, pid: proc.pid }
  }

  // CRASH AUTO-RESTART: check whether a crashed locally-forked worker should be respawned.
  // External workers are never restarted (we can't fork a process on a different machine).
  // Returns true if a restart was initiated, false otherwise.
  _maybeRestartWorker(workerIndex, wasReady) {
    const entry = this.workers[workerIndex]
    if (!entry || entry.isExternal) return false
    if (!this._restartOnCrash) return false
    if (!wasReady) return false // don't restart a worker that never made it past INIT

    const now = Date.now()
    // Sliding-window crash rate limit
    let timestamps = this._crashTimestamps.get(workerIndex)
    if (!timestamps) { timestamps = []; this._crashTimestamps.set(workerIndex, timestamps) }
    // Prune entries older than the window
    const cutoff = now - this._restartWindowMs
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift()
    timestamps.push(now)

    const restartCount = (this._restartCounts.get(workerIndex) || 0) + 1
    this._restartCounts.set(workerIndex, restartCount)

    if (timestamps.length > this._maxRestarts) {
      console.error(`[RoomOrchestrator] worker ${workerIndex} crashed ${timestamps.length} times in the last ${this._restartWindowMs}ms (max ${this._maxRestarts}) -- NOT restarting (rate limit)`)
      return false
    }

    console.log(`[RoomOrchestrator] auto-restarting worker ${workerIndex} (crash #${restartCount}, ${timestamps.length} in window)`)
    // Fire-and-forget: re-spawn the worker at the same index.  The restarted worker starts with
    // empty rooms (fresh state) -- any rooms the old instance hosted are already evicted from
    // roomToWorker by the 'exit' handler above.
    this._spawnWorker(workerIndex).then(() => {
      console.log(`[RoomOrchestrator] worker ${workerIndex} restarted successfully`)
    }).catch(e => {
      console.error(`[RoomOrchestrator] worker ${workerIndex} restart failed:`, e.message)
    })
    return true
  }

  /** Returns crash/restart stats for monitoring. */
  getCrashStats() {
    const stats = {}
    for (const [i, ts] of this._crashTimestamps) {
      stats[i] = { crashCount: ts.length, restartCount: this._restartCounts.get(i) || 0 }
    }
    return stats
  }

  /** Registers an EXTERNAL worker (running on a different Machine, not forked locally).
   *  The external worker connects to the router via HTTP POST /workers/register and sends its
   *  hostname and port range.  The orchestrator assigns it a workerIndex and tracks its host
   *  for route() lookups -- no child_process is forked, and crash auto-restart does not apply
   *  (the orchestrator cannot fork a process on a different machine).
   *  Returns { workerIndex, host } once registered. */
  async registerWorker({ host, portRange, commandPort }) {
    if (!host) throw new Error('registerWorker requires { host }')
    const workerIndex = this._nextWorkerIndex++
    const range = portRange || this._subRangeFor(workerIndex)
    this._workerHosts[workerIndex] = host
    const entry = { proc: null, ready: true, roomIds: new Set(), host, isExternal: true, commandPort: commandPort || null }
    this.workers[workerIndex] = entry
    this.workerCount = Math.max(this.workerCount, workerIndex + 1)
    console.log(`[RoomOrchestrator] registered external worker ${workerIndex} at ${host}:${commandPort || '?'} (port range ${range[0]}-${range[1]})`)
    return { workerIndex, host, portRange: range }
  }

  /** Deregisters an external worker.  All rooms hosted by that worker are evicted from
   *  bookkeeping (the worker process itself is responsible for stopping its own rooms).
   *  Returns true if deregistered, false if the worker wasn't found or wasn't external. */
  async deregisterWorker(workerIndex) {
    const entry = this.workers[workerIndex]
    if (!entry || !entry.isExternal) return false
    for (const roomId of entry.roomIds) this.roomToWorker.delete(roomId)
    entry.roomIds.clear()
    entry.ready = false
    this._retiring.delete(workerIndex)
    console.log(`[RoomOrchestrator] deregistered external worker ${workerIndex} (${entry.host})`)
    return true
  }

  /** Retires an EMPTY worker (zero rooms). Rejects if the worker has any rooms -- callers must drain
   *  rooms first via stopRoom() or wait for natural drain. The worker's port sub-range is freed for
   *  reuse by future spawnWorker() calls. Returns true if retired, false if the workerIndex is invalid
   *  or already dead. */
  async retireWorker(workerIndex) {
    const entry = this.workers[workerIndex]
    if (!entry || !entry.ready) return false
    if (entry.roomIds.size > 0) throw new Error(`retireWorker: worker ${workerIndex} still has ${entry.roomIds.size} room(s) -- drain them first via stopRoom()`)
    // Steal the sub-range before shutting down so it can be reused
    this._freedSubRanges.push(this._subRangeFor(workerIndex))
    if (!entry.isExternal) {
      try { await this._send(workerIndex, { type: 'SHUTDOWN' }) } catch (_) { /* worker may already be dead */ }
    }
    entry.ready = false
    this._elasticStats.retires++
    this._emptiedAt.delete(workerIndex)
    this._retiring.delete(workerIndex)
    return true
  }

  /** Starts the elastic auto-scaling loop. Periodically checks fleet load: if every ready worker's
   *  weighted score exceeds scaleUpThreshold, spawns a new worker. If a worker has been empty (zero
   *  rooms) for scaleDownCooldownMs, retires it -- but never retires below the initial workerCount
   *  (the boot-time minimum). Non-empty workers are never retired mid-load -- room migration is
   *  explicitly out of scope for this slice. */
  startElasticScaling() {
    if (this._elasticTimer) return // already running
    this._elasticTimer = setInterval(() => this._elasticCheck(), this._elasticScaleCheckIntervalMs)
    this._elasticTimer.unref?.() // don't keep the process alive for this alone
  }

  /** Stops the elastic auto-scaling loop. */
  stopElasticScaling() {
    if (this._elasticTimer) { clearInterval(this._elasticTimer); this._elasticTimer = null }
  }

  startExternalWorkerHeartbeat() {
    if (this._externalHeartbeatTimer) return
    this._externalHeartbeatTimer = setInterval(() => this._externalHeartbeatCheck(), this._externalWorkerHeartbeatIntervalMs)
    this._externalHeartbeatTimer.unref?.()
  }

  stopExternalWorkerHeartbeat() {
    if (this._externalHeartbeatTimer) { clearInterval(this._externalHeartbeatTimer); this._externalHeartbeatTimer = null }
  }

  async _externalHeartbeatCheck() {
    const checks = []
    for (let i = 0; i < this.workers.length; i++) {
      const entry = this.workers[i]
      if (entry && entry.ready && entry.isExternal) checks.push(this._sendExternal(entry, { type: 'GET_STATUS' }).catch(() => null))
    }
    await Promise.all(checks)
  }

  async _elasticCheck() {
    const now = Date.now()
    this._elasticStats.lastCheck = now
    try {
      const readyIdx = []
      for (let i = 0; i < this.workers.length; i++) {
        if (this.workers[i]?.ready && !this._retiring.has(i)) readyIdx.push(i)
      }
      if (readyIdx.length === 0) return

      // SCALE UP: if every ready worker's weighted score exceeds the threshold, spawn a new one.
      // Use the SAME weighted-scoring formula _pickWeightedWorker uses (player/entity/tick/dilation)
      // so the scale-up trigger is consistent with the placement policy.
      const perWorkerRooms = await Promise.all(
        readyIdx.map(i => this._send(i, { type: 'GET_STATUS' }).then(r => r.rooms).catch(() => null))
      )
      let allOverThreshold = readyIdx.length > 0
      for (let k = 0; k < readyIdx.length; k++) {
        const rooms = perWorkerRooms[k]
        if (!rooms || rooms.length === 0) { allOverThreshold = false; break }
        const score = scoreWorkerRooms(rooms)
        if (score < this._elasticScaleUpThreshold) { allOverThreshold = false; break }
      }
      if (allOverThreshold) {
        this._elasticStats.lastDecision = `scale-up: all ${readyIdx.length} worker(s) above threshold ${this._elasticScaleUpThreshold}`
        console.log(`[RoomOrchestrator:elastic] ${this._elasticStats.lastDecision}, spawning new worker`)
        try { await this.spawnWorker() } catch (e) { console.error(`[RoomOrchestrator:elastic] scale-up spawn failed:`, e.message) }
        return // one action per check cycle
      }

      // SCALE DOWN: retire any worker that has been empty (zero rooms) for longer than the cooldown,
      // but never go below the initial workerCount (the boot-time minimum fleet size).
      if (!this._initialWorkerCount) this._initialWorkerCount = this.workerCount // set on first check
      for (let i = 0; i < this.workers.length; i++) {
        const entry = this.workers[i]
        if (!entry?.ready || this._retiring.has(i)) continue
        if (entry.roomIds.size === 0) {
          if (!this._emptiedAt.has(i)) this._emptiedAt.set(i, now)
          const emptiedAt = this._emptiedAt.get(i)
          if (now - emptiedAt >= this._elasticScaleDownCooldownMs) {
            // Count ready workers that are NOT retiring
            const activeCount = this.workers.filter((w, idx) => w?.ready && !this._retiring.has(idx)).length
            if (activeCount <= this._initialWorkerCount) {
              this._elasticStats.lastDecision = `scale-down: worker ${i} empty for ${now - emptiedAt}ms but at minimum fleet size (${this._initialWorkerCount})`
              return
            }
            this._elasticStats.lastDecision = `scale-down: retiring empty worker ${i} (empty for ${now - emptiedAt}ms)`
            console.log(`[RoomOrchestrator:elastic] ${this._elasticStats.lastDecision}`)
            try { await this.retireWorker(i) } catch (e) { console.error(`[RoomOrchestrator:elastic] scale-down retire failed:`, e.message) }
            return // one action per check cycle
          }
        } else {
          this._emptiedAt.delete(i) // worker has rooms again, reset the empty timer
        }
      }
      this._elasticStats.lastDecision = 'no-action'
    } catch (e) {
      console.error('[RoomOrchestrator:elastic] check failed:', e.message)
      this._elasticStats.lastDecision = `error: ${e.message}`
    }
  }

  /** Returns current elastic scaling stats for monitoring/debugging. */
  getElasticStats() {
    return { ...this._elasticStats, workerCount: this.workers.filter(w => w?.ready).length, retiring: [...this._retiring] }
  }

  /** Spawns all configured worker processes and waits for each to report ready. */
  async start() {
    await Promise.all(Array.from({ length: this.workerCount }, (_, i) => this._spawnWorker(i)))
    return { workerCount: this.workers.length, pids: this.workers.map(w => w.proc?.pid).filter(Boolean) }
  }

  _spawnWorker(workerIndex) {
    return new Promise((resolve, reject) => {
      const proc = fork(WORKER_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      const host = this._workerHosts[workerIndex] || '127.0.0.1'
      const entry = { proc, ready: false, roomIds: new Set(), host, isExternal: false }
      this.workers[workerIndex] = entry
      proc.on('message', (msg) => this._handleWorkerMessage(workerIndex, msg))
      proc.on('exit', (code, signal) => {
        const wasReady = entry.ready
        const roomCount = entry.roomIds.size
        const isAbnormal = code !== 0 || signal != null
        console.error(`[RoomOrchestrator] worker ${workerIndex} (pid ${proc.pid}) exited (code=${code} signal=${signal}) -- its ${roomCount} room(s) are now unreachable`)
        for (const roomId of entry.roomIds) this.roomToWorker.delete(roomId)
        entry.ready = false
        if (isAbnormal) this._maybeRestartWorker(workerIndex, wasReady)
      })
      proc.on('error', (e) => { console.error(`[RoomOrchestrator] worker ${workerIndex} fork error:`, e.message); reject(e) })
      let settled = false
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`worker ${workerIndex} did not become ready in time`)) } }, 15000)
      entry._resolveReady = () => { if (settled) return; settled = true; clearTimeout(timeout); entry.ready = true; resolve(entry) }
      proc.send({ type: 'INIT', sdkRoot: this.sdkRoot, projectRoot: this.projectRoot, portRange: this._subRangeFor(workerIndex) })
    })
  }

  _handleWorkerMessage(workerIndex, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'WORKER_READY') { this.workers[workerIndex]?._resolveReady?.(); return }
    if (msg.reqId != null && this._pending.has(msg.reqId)) {
      const { resolve, reject } = this._pending.get(msg.reqId)
      this._pending.delete(msg.reqId)
      if (msg.type === 'ROOM_CREATE_FAILED') reject(new Error(msg.error))
      else resolve(msg)
    }
  }

  _send(workerIndex, payload) {
    const entry = this.workers[workerIndex]
    if (!entry || !entry.ready) return Promise.reject(new Error(`RoomOrchestrator: worker ${workerIndex} is not ready`))
    if (entry.isExternal) return this._sendExternal(entry, payload)
    const reqId = this._nextReqId++
    return new Promise((resolve, reject) => {
      this._pending.set(reqId, { resolve, reject })
      entry.proc.send({ ...payload, reqId })
    })
  }

  async _sendExternal(entry, payload) {
    if (!entry.commandPort) throw new Error('RoomOrchestrator: external worker registered without a commandPort -- cannot route commands to it')
    const base = `http://${entry.host}:${entry.commandPort}`
    try {
      if (payload.type === 'CREATE_ROOM') {
        const res = await httpJsonRequest(`${base}/rooms`, 'POST', { roomId: payload.roomId, worldName: payload.worldName, opts: payload.opts })
        if (res.status !== 201) throw new Error(res.body?.error || `external worker CREATE_ROOM failed (status ${res.status})`)
        return { type: 'ROOM_CREATED', roomId: payload.roomId, port: res.body.port, worldName: res.body.worldName }
      }
      if (payload.type === 'STOP_ROOM') {
        const res = await httpJsonRequest(`${base}/rooms/${encodeURIComponent(payload.roomId)}`, 'DELETE')
        return { type: 'ROOM_STOPPED', roomId: payload.roomId, stopped: !!res.body?.stopped }
      }
      if (payload.type === 'GET_STATUS') {
        const res = await httpJsonRequest(`${base}/status`, 'GET')
        return { type: 'STATUS', rooms: res.body?.rooms || [] }
      }
      if (payload.type === 'SHUTDOWN') {
        const res = await httpJsonRequest(`${base}/shutdown`, 'POST')
        return { type: 'SHUTDOWN_DONE' }
      }
      throw new Error(`RoomOrchestrator: unsupported external command type ${payload.type}`)
    } catch (e) {
      if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) {
        this._markExternalWorkerDead(entry)
      }
      throw e
    }
  }

  _markExternalWorkerDead(entry) {
    if (!entry.ready) return
    const workerIndex = this.workers.indexOf(entry)
    console.error(`[RoomOrchestrator] external worker ${workerIndex} (${entry.host}:${entry.commandPort}) unreachable -- marking dead, evicting ${entry.roomIds.size} room(s)`)
    for (const roomId of entry.roomIds) this.roomToWorker.delete(roomId)
    entry.roomIds.clear()
    entry.ready = false
  }

  /** Picks the worker currently hosting the fewest rooms (ties broken by lowest index). Pure room-count fallback -- used when no live per-room status is available yet (e.g. a worker that just came up with zero rooms/zero tick history), and as _pickWeightedWorker's own tie-break when every ready worker's weighted score is identical (all-idle fleet). Skips workers that are currently retiring. */
  _pickLeastLoadedWorker() {
    let best = -1, bestCount = Infinity
    for (let i = 0; i < this.workers.length; i++) {
      const w = this.workers[i]
      if (!w?.ready || this._retiring.has(i)) continue
      if (w.roomIds.size < bestCount) { bestCount = w.roomIds.size; best = i }
    }
    if (best === -1) throw new Error('RoomOrchestrator: no ready worker available to host a new room')
    return best
  }

  /**
   * server-scale-room-orchestrator-load-aware-placement: weighs placement by REAL live per-room load
   * (RoomDirectory.getStatus()'s player/entity/avgTickMs/dilationFactor fields, fanned out per-worker
   * via the same GET_STATUS IPC call getStatus() already uses) instead of bin-packing by room COUNT
   * alone. Room count alone is blind to one popular room (many players, heavy per-tick physics)
   * sharing a worker process with several quiet rooms -- the count looks balanced while that one
   * worker's event loop is actually starved.
   *
   * WEIGHT FORMULA (derived from a real measured probe, not guessed -- see
   * server-scale-room-orchestrator-load-aware-placement's witness_evidence for the live tps-game
   * player-count-vs-avgTickMs regression this was fit against):
   *   perRoomWeight = players*PLAYER_WEIGHT + entities*ENTITY_WEIGHT + avgTickMs*TICKMS_WEIGHT
   *                   + (1-dilationFactor)*DILATION_PENALTY
   * dilationFactor is the dominant term BY DESIGN: TickSystem already self-throttles a room's own
   * simulation once its rolling avg tick cost crosses 85% of budget (DILATION_THRESHOLD in
   * TickSystem.js) -- a room that has already had to dilate is unambiguously the most-loaded kind of
   * room this fleet can have, more informative than any raw players/entities/avgTickMs count on its
   * own (a room can have many entities but be cheap per-tick, or few entities but each doing
   * expensive per-tick work -- dilationFactor is TickSystem's own integrated verdict on that).
   * A worker's total load is the SUM of its rooms' weights (parallel scan-cost model: N rooms sharing
   * one event loop pay roughly additively, confirmed by the real measurement below). Falls back to
   * the pure room-count metric for any worker with zero status rows yet (brand new / status fetch
   * failed) so a freshly-spawned empty worker is never starved of placement by a transient status gap.
   */
  async _pickWeightedWorker() {
    const readyIdx = []
    for (let i = 0; i < this.workers.length; i++) if (this.workers[i]?.ready && !this._retiring.has(i)) readyIdx.push(i)
    if (readyIdx.length === 0) throw new Error('RoomOrchestrator: no ready worker available to host a new room')
    const perWorkerRooms = await Promise.all(
      readyIdx.map(i => this._send(i, { type: 'GET_STATUS' }).then(r => r.rooms).catch(() => null))
    )
    let best = -1, bestScore = Infinity
    for (let k = 0; k < readyIdx.length; k++) {
      const i = readyIdx[k]
      const rooms = perWorkerRooms[k]
      // No usable status (fetch failed, or genuinely zero rooms -> zero weight anyway) -- treat as
      // pure room-count load so an empty/unreachable-status worker is never unfairly skipped.
      const score = rooms ? scoreWorkerRooms(rooms) : this.workers[i].roomIds.size
      if (score < bestScore) { bestScore = score; best = i }
    }
    return best
  }

  /**
   * Creates a room, auto-placing it on the least-LOADED ready worker (real player/entity/tick-timing
   * weighted score, see _pickWeightedWorker) unless opts.workerIndex is given explicitly. Rejects a
   * duplicate roomId across the WHOLE orchestrator (not just within one worker) since roomId is meant
   * to be a directory-wide unique join-code/lobby-id.
   */
  async createRoom(roomId, worldName, opts = {}) {
    if (this.roomToWorker.has(roomId)) throw new Error(`RoomOrchestrator: roomId "${roomId}" already exists`)
    const workerIndex = opts.workerIndex != null ? opts.workerIndex : await this._pickWeightedWorker()
    const result = await this._send(workerIndex, { type: 'CREATE_ROOM', roomId, worldName, opts: opts.configOverrides ? { configOverrides: opts.configOverrides } : {} })
    this.roomToWorker.set(roomId, { workerIndex, port: result.port, worldName: result.worldName })
    this.workers[workerIndex].roomIds.add(roomId)
    return { roomId, workerIndex, port: result.port, worldName: result.worldName }
  }

  /** Stops a room on whichever worker hosts it. Idempotent (unknown roomId is a no-op false), matching RoomDirectory.stopRoom's own contract. */
  async stopRoom(roomId) {
    const loc = this.roomToWorker.get(roomId)
    if (!loc) return false
    const result = await this._send(loc.workerIndex, { type: 'STOP_ROOM', roomId })
    this.roomToWorker.delete(roomId)
    this.workers[loc.workerIndex].roomIds.delete(roomId)
    return result.stopped
  }

  /**
   * Router lookup: which host:port serves this roomId right now.  Returns undefined for an unknown
   * room -- caller (HTTP router / bin entry) decides the 404 behavior.
   *
   * CROSS-MACHINE: returns the PER-WORKER host (not a hardcoded '127.0.0.1').  A locally-forked
   * worker defaults to '127.0.0.1' (or the constructor's workerHosts[workerIndex] override); an
   * external worker (registered via registerWorker()) returns its own hostname.  This is the seam
   * that makes a multi-Machine deployment work: a client resolves /route/:roomId, gets back
   * {host, port} where host is the actual Machine address the room lives on, and connects directly.
   *
   * The `host` parameter is kept for backward compatibility and as a caller-side override --
   * if passed, it replaces the per-worker host.  Omit it (or pass undefined) to use the per-worker
   * host from registration/spawn time.
   */
  route(roomId, host) {
    const loc = this.roomToWorker.get(roomId)
    if (!loc) return undefined
    const worker = this.workers[loc.workerIndex]
    const resolvedHost = host || (worker?.host) || '127.0.0.1'
    return { host: resolvedHost, port: loc.port, workerIndex: loc.workerIndex, worldName: loc.worldName }
  }

  /** Directory-wide status: real per-room rows fetched live from every worker (parallel GET_STATUS), flattened -- the shape a Prometheus /metrics `rooms` source (see src/sdk/Metrics.js) can consume directly across an ENTIRE multi-process fleet, not just one process's RoomDirectory. */
  async getStatus() {
    const perWorker = await Promise.all(
      this.workers.map((w, i) => (w?.ready ? this._send(i, { type: 'GET_STATUS' }).then(r => r.rooms).catch(() => []) : Promise.resolve([])))
    )
    return perWorker.flat()
  }

  /** Starts a minimal HTTP router on `port`: GET /route/:roomId -> {host,port,workerIndex,worldName} JSON (404 if unknown), GET /status -> full fleet status, POST /workers/register -> register an external worker, DELETE /workers/:index -> deregister an external worker. Not a traffic proxy -- see class doc comment. */
  /** Starts a minimal HTTP router on `port`: GET /route/:roomId -> {host,port,workerIndex,worldName} JSON (404 if unknown), GET /status -> full fleet status, POST /workers/register -> register an external worker, DELETE /workers/:index -> deregister an external worker. Not a traffic proxy -- see class doc comment. Delegates to RoomOrchestratorHttp.js's startRoomOrchestratorRouter, which only reaches this instance through its public methods. */
  startRouter(port) {
    return startRoomOrchestratorRouter(this, port)
  }

  /** Stops every worker process (each drains its own rooms via RoomDirectory.stopAll first) and the router HTTP listener. */
  async stopAll() {
    this.stopElasticScaling()
    await Promise.allSettled(this.workers.map((w, i) => (w?.ready && !w.isExternal ? this._send(i, { type: 'SHUTDOWN' }).catch(() => {}) : Promise.resolve())))
    this.roomToWorker.clear()
    if (this.httpServer) await new Promise((resolve) => this.httpServer.close(() => resolve()))
  }
}

