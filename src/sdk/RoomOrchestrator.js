import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readJsonBody, httpJsonRequest, scoreWorkerRooms, startRoomOrchestratorRouter } from './RoomOrchestratorHttp.js'

export { readJsonBody }

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKER_ENTRY = join(SDK_ROOT, 'src', 'sdk', 'RoomProcessWorker.js')
const DEFAULT_LOCAL_WORKER_HOST = '127.0.0.1'

export class RoomOrchestrator {
  constructor({ sdkRoot, projectRoot, workerCount = 2, portRange = [19000, 19999], elasticScaling = false, elasticScaleUpThreshold = 0.8, elasticScaleDownCooldownMs = 120000, elasticScaleCheckIntervalMs = 30000, workerHosts = {}, restartOnCrash = true, maxRestarts = 3, restartWindowMs = 60000, externalWorkerHeartbeatIntervalMs = 10000 } = {}) {
    if (!sdkRoot) throw new Error('RoomOrchestrator requires { sdkRoot }')
    this.sdkRoot = sdkRoot
    this.projectRoot = projectRoot || sdkRoot
    this.workerCount = workerCount
    this.portRange = portRange
    this.workers = []
    this.roomToWorker = new Map()
    this._nextReqId = 1
    this._pending = new Map()
    this.httpServer = null
    this._workerHosts = workerHosts
    this._restartOnCrash = restartOnCrash
    this._maxRestarts = maxRestarts
    this._restartWindowMs = restartWindowMs
    this._crashTimestamps = new Map()
    this._restartCounts = new Map()
    this._elasticScaling = elasticScaling
    this._elasticScaleUpThreshold = elasticScaleUpThreshold
    this._elasticScaleDownCooldownMs = elasticScaleDownCooldownMs
    this._elasticScaleCheckIntervalMs = elasticScaleCheckIntervalMs
    this._elasticTimer = null
    this._nextWorkerIndex = workerCount
    this._freedSubRanges = []
    this._emptiedAt = new Map()
    this._retiring = new Set()
    this._elasticStats = { spawns: 0, retires: 0, lastCheck: 0, lastDecision: '' }
    this._externalWorkerHeartbeatIntervalMs = externalWorkerHeartbeatIntervalMs
    this._externalHeartbeatTimer = null
  }

  _subRangeFor(workerIndex) {
    const [min, max] = this.portRange
    if (this._freedSubRanges.length > 0) return this._freedSubRanges.shift()
    const span = max - min + 1
    const blockSize = Math.floor(span / this.workerCount)
    const subMin = min + workerIndex * blockSize
    const subMax = workerIndex === this.workerCount - 1 ? max : subMin + blockSize - 1
    return [subMin, subMax]
  }

  async spawnWorker() {
    const workerIndex = this._nextWorkerIndex++
    const host = this._workerHosts[workerIndex] || DEFAULT_LOCAL_WORKER_HOST
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
        if (isAbnormal) this._maybeRestartWorker(workerIndex, wasReady)
      })
      p.on('error', (e) => { console.error(`[RoomOrchestrator] worker ${workerIndex} fork error:`, e.message); if (!settled) { settled = true; clearTimeout(timeout); reject(e) } })
      p.send({ type: 'INIT', sdkRoot: this.sdkRoot, projectRoot: this.projectRoot, portRange: this._subRangeFor(workerIndex) })
    })
    this._elasticStats.spawns++
    this._emptiedAt.delete(workerIndex)
    return { workerIndex, pid: proc.pid }
  }

  _maybeRestartWorker(workerIndex, wasReady) {
    const entry = this.workers[workerIndex]
    if (!entry || entry.isExternal) return false
    if (!this._restartOnCrash) return false
    if (!wasReady) return false

    const now = Date.now()
    let timestamps = this._crashTimestamps.get(workerIndex)
    if (!timestamps) { timestamps = []; this._crashTimestamps.set(workerIndex, timestamps) }
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
    this._spawnWorker(workerIndex).then(() => {
      console.log(`[RoomOrchestrator] worker ${workerIndex} restarted successfully`)
    }).catch(e => {
      console.error(`[RoomOrchestrator] worker ${workerIndex} restart failed:`, e.message)
    })
    return true
  }

  getCrashStats() {
    const stats = {}
    for (const [i, ts] of this._crashTimestamps) {
      stats[i] = { crashCount: ts.length, restartCount: this._restartCounts.get(i) || 0 }
    }
    return stats
  }

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

  async retireWorker(workerIndex) {
    const entry = this.workers[workerIndex]
    if (!entry || !entry.ready) return false
    if (entry.roomIds.size > 0) throw new Error(`retireWorker: worker ${workerIndex} still has ${entry.roomIds.size} room(s) -- drain them first via stopRoom()`)
    this._freedSubRanges.push(this._subRangeFor(workerIndex))
    if (!entry.isExternal) {
      try { await this._send(workerIndex, { type: 'SHUTDOWN' }) } catch (_) { }
    }
    entry.ready = false
    this._elasticStats.retires++
    this._emptiedAt.delete(workerIndex)
    this._retiring.delete(workerIndex)
    return true
  }

  startElasticScaling() {
    if (this._elasticTimer) return
    this._elasticTimer = setInterval(() => this._elasticCheck(), this._elasticScaleCheckIntervalMs)
    this._elasticTimer.unref?.()
  }

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
        return
      }

      if (!this._initialWorkerCount) this._initialWorkerCount = this.workerCount
      for (let i = 0; i < this.workers.length; i++) {
        const entry = this.workers[i]
        if (!entry?.ready || this._retiring.has(i)) continue
        if (entry.roomIds.size === 0) {
          if (!this._emptiedAt.has(i)) this._emptiedAt.set(i, now)
          const emptiedAt = this._emptiedAt.get(i)
          if (now - emptiedAt >= this._elasticScaleDownCooldownMs) {
            const activeCount = this.workers.filter((w, idx) => w?.ready && !this._retiring.has(idx)).length
            if (activeCount <= this._initialWorkerCount) {
              this._elasticStats.lastDecision = `scale-down: worker ${i} empty for ${now - emptiedAt}ms but at minimum fleet size (${this._initialWorkerCount})`
              return
            }
            this._elasticStats.lastDecision = `scale-down: retiring empty worker ${i} (empty for ${now - emptiedAt}ms)`
            console.log(`[RoomOrchestrator:elastic] ${this._elasticStats.lastDecision}`)
            try { await this.retireWorker(i) } catch (e) { console.error(`[RoomOrchestrator:elastic] scale-down retire failed:`, e.message) }
            return
          }
        } else {
          this._emptiedAt.delete(i)
        }
      }
      this._elasticStats.lastDecision = 'no-action'
    } catch (e) {
      console.error('[RoomOrchestrator:elastic] check failed:', e.message)
      this._elasticStats.lastDecision = `error: ${e.message}`
    }
  }

  getElasticStats() {
    return { ...this._elasticStats, workerCount: this.workers.filter(w => w?.ready).length, retiring: [...this._retiring] }
  }

  async start() {
    await Promise.all(Array.from({ length: this.workerCount }, (_, i) => this._spawnWorker(i)))
    return { workerCount: this.workers.length, pids: this.workers.map(w => w.proc?.pid).filter(Boolean) }
  }

  _spawnWorker(workerIndex) {
    return new Promise((resolve, reject) => {
      const proc = fork(WORKER_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      const host = this._workerHosts[workerIndex] || DEFAULT_LOCAL_WORKER_HOST
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
      const score = rooms ? scoreWorkerRooms(rooms) : this.workers[i].roomIds.size
      if (score < bestScore) { bestScore = score; best = i }
    }
    return best
  }

  async createRoom(roomId, worldName, opts = {}) {
    if (this.roomToWorker.has(roomId)) throw new Error(`RoomOrchestrator: roomId "${roomId}" already exists`)
    const workerIndex = opts.workerIndex != null ? opts.workerIndex : await this._pickWeightedWorker()
    const result = await this._send(workerIndex, { type: 'CREATE_ROOM', roomId, worldName, opts: opts.configOverrides ? { configOverrides: opts.configOverrides } : {} })
    this.roomToWorker.set(roomId, { workerIndex, port: result.port, worldName: result.worldName })
    this.workers[workerIndex].roomIds.add(roomId)
    return { roomId, workerIndex, port: result.port, worldName: result.worldName }
  }

  async stopRoom(roomId) {
    const loc = this.roomToWorker.get(roomId)
    if (!loc) return false
    const result = await this._send(loc.workerIndex, { type: 'STOP_ROOM', roomId })
    this.roomToWorker.delete(roomId)
    this.workers[loc.workerIndex].roomIds.delete(roomId)
    return result.stopped
  }

  route(roomId, host) {
    const loc = this.roomToWorker.get(roomId)
    if (!loc) return undefined
    const worker = this.workers[loc.workerIndex]
    const resolvedHost = host || (worker?.host) || DEFAULT_LOCAL_WORKER_HOST
    return { host: resolvedHost, port: loc.port, workerIndex: loc.workerIndex, worldName: loc.worldName }
  }

  async getStatus() {
    const perWorker = await Promise.all(
      this.workers.map((w, i) => (w?.ready ? this._send(i, { type: 'GET_STATUS' }).then(r => r.rooms).catch(() => []) : Promise.resolve([])))
    )
    return perWorker.flat()
  }

  startRouter(port) {
    return startRoomOrchestratorRouter(this, port)
  }

  async stopAll() {
    this.stopElasticScaling()
    await Promise.allSettled(this.workers.map((w, i) => (w?.ready && !w.isExternal ? this._send(i, { type: 'SHUTDOWN' }).catch(() => {}) : Promise.resolve())))
    this.roomToWorker.clear()
    if (this.httpServer) await new Promise((resolve) => this.httpServer.close(() => resolve()))
  }
}

