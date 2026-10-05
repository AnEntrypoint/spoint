import { ReconciliationEngine } from './ReconciliationEngine.js'
import { DEFAULT_MOVEMENT } from '../shared/movement.js'
import { predictCharacterStep } from '../shared/characterStep.js'
import { createStepTrail } from './StepTrail.js'
import { separationPush } from '../netcode/CollisionSystem.js'
import { PLAYER_DEFAULTS } from '../shared/worldDefaults.js'

const PRE_HANDSHAKE_TICK_RATE = 60
const MAX_TRACKED_CONNECTION_DEGRADATION_MS = 10000
const INPUT_HISTORY_FLOOR = 257
const WEDGE_POS_EPS_SQ = 1e-8
const WEDGE_VEL_EPS_SQ = 1e-6
const RECONCILE_POS_EPS_M = 0.015
const SURFACE_MATCH_M = 0.25
const SURFACE_OFFSET_ALPHA = 0.2
const WALL_CACHE_SIZE = 6
const WALL_MATCH_NORMAL = 0.02
const WALL_MATCH_OFFSET_M = 0.05
const WALL_FORGET_M = 6
const WALL_EXTENT_BASE_M = 1
const WALL_PASSED_M = 0.02
const PEER_FRESH_WINDOW_S = 0.15
const ZERO_VELOCITY = [0, 0, 0]
const MOVE_STATE_KEYS =['coyoteRemaining', 'bufferRemaining', '_jumpHeld', '_crouchHeld', 'slideRemaining', 'sliding', '_physCrouch', '_crouchDy']

function isFiniteVec(v, len) {
  return Array.isArray(v) && v.length === len && v.every(Number.isFinite)
}

function isValidPlayerSnapshot(p) {
  return !!p && isFiniteVec(p.position, 3) && isFiniteVec(p.rotation, 4) && isFiniteVec(p.velocity, 3)
}

function makeEntry() {
  return { sequence: -1, data: null, position: [0, 0, 0], velocity: [0, 0, 0], onGround: true, groundY: 0, move: {} }
}

class InputHistory {
  constructor(capacity) { this._buf = []; this._head = 0; this._len = 0; this._grow(capacity) }
  _grow(capacity) {
    const old = this._buf, oldCap = old.length, next = new Array(capacity)
    for (let i = 0; i < this._len; i++) next[i] = old[(this._head + i) % oldCap]
    for (let i = this._len; i < capacity; i++) next[i] = makeEntry()
    this._buf = next; this._head = 0
  }
  get length() { return this._len }
  get capacity() { return this._buf.length }
  at(i) { return i >= 0 && i < this._len ? this._buf[(this._head + i) % this._buf.length] : undefined }
  pushSlot() {
    if (this._len === this._buf.length) { this._head = (this._head + 1) % this._buf.length; this._len-- }
    const e = this._buf[(this._head + this._len) % this._buf.length]
    this._len++
    return e
  }
  dropThrough(sequence) { while (this._len > 0 && this.at(0).sequence <= sequence) { this._head = (this._head + 1) % this._buf.length; this._len-- } }
  indexOf(sequence) {
    if (!this._len) return -1
    const i = sequence - this.at(0).sequence
    return i >= 0 && i < this._len && this.at(i).sequence === sequence ? i : -1
  }
  clear() { this._head = 0; this._len = 0 }
  *[Symbol.iterator]() { for (let i = 0; i < this._len; i++) yield this.at(i) }
  last(n) { const k = Math.min(n, this._len), out = new Array(k); for (let i = 0; i < k; i++) out[i] = this.at(this._len - k + i); return out }
}

function saveEntry(e, state) {
  const sp = state.position, sv = state.velocity
  e.position[0] = sp[0]; e.position[1] = sp[1]; e.position[2] = sp[2]
  e.velocity[0] = sv[0]; e.velocity[1] = sv[1]; e.velocity[2] = sv[2]
  e.onGround = state.onGround; e.groundY = state.groundY
  for (const k of MOVE_STATE_KEYS) e.move[k] = state[k]
}

export class PredictionEngine {
  constructor(tickRate = PRE_HANDSHAKE_TICK_RATE) {
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this.dilation = 1
    this.localPlayerId = null
    this.localState = null
    this.lastServerState = null
    this.horizontallyWedged = false
    this.verticallyBlocked = false
    this._teleportTick = -1
    this.inputHistory = new InputHistory(this.inputHistoryHardCap())
    this._inputSeq = 1
    this._lastAckedSeq = 0
    this.reconciliationEngine = new ReconciliationEngine()
    this.movement = { ...DEFAULT_MOVEMENT }
    this.gravityY = -9.81
    this._ground = null
    this._surface = null
    this._pendingKnockback = null
    this._knockbackWindow = 200
    this._enableKnockbackPreservation = true
    this.stats = { acks: 0, corrections: 0, lastCorrectionM: 0, maxCorrectionM: 0 }
    this.walls = []
    this._env = { gravityY: this.gravityY, ground: null, wedged: false, groundNormal: null, walls: null, wallExtentM: WALL_EXTENT_BASE_M, collider: null }
    this._mirror = null
    this._trail = createStepTrail()
    this._trailPos = [0, 0, 0]
    this._peers = null
    this._pushOut = [0, 0, 0, 0]
    this.separationDistM = PLAYER_DEFAULTS.capsuleRadius * 2
  }

  setMovement(m) { Object.assign(this.movement, m) }

  setCollisionMirror(mirror) { this._mirror = mirror || null }

  collisionMirrorStats() { return this._mirror ? this._mirror.getStats() : null }

  setGravity(g) { if (g && g[1] != null) this.gravityY = g[1] }

  setGroundProvider(fn) { this._ground = typeof fn === 'function' ? fn : null }

  setGroundSurface(surfaceHeightAt) {
    if (typeof surfaceHeightAt !== 'function') { this._surface = null; this.setGroundProvider(null); return }
    this._surface = { heightAt: surfaceHeightAt, standOffset: NaN, onSurface: false }
    const s = this._surface
    this.setGroundProvider((x, z) => {
      if (!s.onSurface) return null
      const h = s.heightAt(x, z)
      return Number.isFinite(h) ? h + s.standOffset : null
    })
  }

  _calibrateSurface(server) {
    const s = this._surface
    if (!s || !server.onGround) return
    const h = s.heightAt(server.position[0], server.position[2])
    if (!Number.isFinite(h)) { s.onSurface = false; return }
    const offset = server.position[1] - h
    if (!Number.isFinite(s.standOffset)) { s.standOffset = offset; s.onSurface = true; return }
    s.onSurface = Math.abs(offset - s.standOffset) <= SURFACE_MATCH_M
    if (s.onSurface) s.standOffset += (offset - s.standOffset) * SURFACE_OFFSET_ALPHA
  }

  setDilation(f) { if (Number.isFinite(f) && f > 0) this.dilation = f }

  recordKnockback(dir, impulse, now = Date.now()) {
    if (!this._enableKnockbackPreservation) return
    this._pendingKnockback = { dir: [...dir], impulse, startTime: now }
  }

  setKnockbackPreservation(enabled) { this._enableKnockbackPreservation = enabled }

  setTickRate(rate) {
    if (!(rate > 0)) return
    this.tickRate = rate; this.tickDuration = 1000 / rate
    const cap = this.inputHistoryHardCap()
    if (cap > this.inputHistory.capacity) this.inputHistory._grow(cap)
  }

  inputHistoryHardCap() {
    if (!Number.isFinite(this.tickDuration) || this.tickDuration <= 0) return INPUT_HISTORY_FLOOR
    return Math.max(INPUT_HISTORY_FLOOR, Math.ceil(MAX_TRACKED_CONNECTION_DEGRADATION_MS / this.tickDuration))
  }

  init(playerId, initialState = {}) {
    this.localPlayerId = playerId
    const pos = initialState.position || [0, 0, 0]
    const rot = initialState.rotation || [0, 0, 0, 1]
    const vel = initialState.velocity || [0, 0, 0]
    const health = initialState.health || 100
    this.localState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, groundY: pos[1], health, coyoteRemaining: 0, bufferRemaining: 0, _jumpHeld: false }
    this.lastServerState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health }
    this._renderState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health }
    this.reconciliationEngine.reset()
    this._pendingKnockback = null
    this.horizontallyWedged = false
    this.walls.length = 0
    this._hasServerState = false
    this._trail.reset()
  }

  teleport(position, velocity, tick) {
    const v = velocity || [0, 0, 0]
    for (const s of [this.localState, this.lastServerState, this._renderState]) {
      if (!s) continue
      s.position[0] = position[0]; s.position[1] = position[1]; s.position[2] = position[2]
      s.velocity[0] = v[0]; s.velocity[1] = v[1]; s.velocity[2] = v[2]
    }
    if (this.localState) { this.localState.groundY = position[1]; this.localState.onGround = false }
    this.inputHistory.clear()
    this._lastAckedSeq = this._inputSeq - 1
    this.reconciliationEngine.reset()
    this._pendingKnockback = null
    this.horizontallyWedged = false
    this.walls.length = 0
    this._teleportTick = tick ?? -1
    this._trail.reset()
  }

  addInput(input, stepAt, periodMs) {
    const seq = this._inputSeq++
    const timed = Number.isFinite(stepAt) && periodMs > 0
    const p = this.localState.position
    if (!timed) this._trail.reset()
    else if (this._trail.length === 0) this._trail.push(stepAt, p[0], p[1], p[2])
    this._step(input, seq)
    if (timed) this._trail.push(stepAt + periodMs, p[0], p[1], p[2])
    const e = this.inputHistory.pushSlot()
    e.sequence = seq; e.data = input
    saveEntry(e, this.localState)
    return seq
  }

  getUnackedInputs(max = 4) { return this.inputHistory.last(max) }

  predictedAt(sequence) {
    const i = this.inputHistory.indexOf(sequence)
    return i < 0 ? null : this.inputHistory.at(i)
  }

  _step(input, seq) {
    const env = this._env
    env.gravityY = this.gravityY; env.ground = this._ground; env.wedged = this.horizontallyWedged; env.groundNormal = this.lastServerState?.groundNormal || null; env.walls = this.walls
    const dt = (this.tickDuration * this.dilation) / 1000, v = this.localState.velocity
    env.wallExtentM = WALL_EXTENT_BASE_M + Math.hypot(v[0], v[2]) * (this.inputHistory.length + 1) * dt
    const m = this._mirror
    env.collider = m && m.ready && m.covers(this.localState.position) ? m : null
    if (m && m.ready && !env.collider) m.noteUncovered()
    predictCharacterStep(this.localState, input, this.movement, dt, env)
    if ((this._inputSeq - 1 - this._lastAckedSeq) * dt <= PEER_FRESH_WINDOW_S) this._separateFromPeers(dt, seq === undefined ? 1 : seq - this._lastAckedSeq)
  }

  _separateFromPeers(dt, ticksPastSnapshot) {
    const peers = this._peers
    if (!peers) return
    const ls = this.localState, p = ls.position, v = ls.velocity, out = this._pushOut
    const lead = Math.max(ticksPastSnapshot, 0) * dt
    for (const [pid, peer] of peers) {
      if (pid === this.localPlayerId || !isFiniteVec(peer.position, 3)) continue
      const q = peer.position, w = isFiniteVec(peer.velocity, 3) ? peer.velocity : ZERO_VELOCITY
      if (!separationPush(q[0] + w[0] * lead - p[0], q[1] + w[1] * lead - p[1], q[2] + w[2] * lead - p[2], this.separationDistM, dt, out)) continue
      p[0] -= out[0]; p[2] -= out[1]; v[0] -= out[2]; v[2] -= out[3]
    }
  }

  setPeers(playerStates) { this._peers = playerStates || null }

  setPlayerRadius(radius) { if (Number.isFinite(radius) && radius > 0) this.separationDistM = radius * 2 }

  predict(input) { this._step(input) }

  getRenderState(renderAt) {
    const ls = this.localState
    if (!ls) return null
    const offset = this.reconciliationEngine.decay(performance.now())
    const r = this._renderState || (this._renderState = { id: ls.id, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, health: 100 })
    this._copyState(ls, r)
    const src = this._trail.sample(renderAt, this._trailPos) ? this._trailPos : ls.position
    r.position[0] = src[0] - offset[0]
    r.position[1] = src[1] - offset[1]
    r.position[2] = src[2] - offset[2]
    return r
  }

  _copyState(src, dst) {
    dst.id = src.id; dst.onGround = src.onGround; dst.health = src.health; dst.inputSequence = src.inputSequence
    const sp = src.position, dp = dst.position; dp[0] = sp[0]; dp[1] = sp[1]; dp[2] = sp[2]
    const sr = src.rotation, dr = dst.rotation; dr[0] = sr[0]; dr[1] = sr[1]; dr[2] = sr[2]; dr[3] = sr[3]
    const sv = src.velocity, dv = dst.velocity; dv[0] = sv[0]; dv[1] = sv[1]; dv[2] = sv[2]
    if (src.groundNormal) { const g = dst.groundNormal || (dst.groundNormal = [0, 1, 0]); g[0] = src.groundNormal[0]; g[1] = src.groundNormal[1]; g[2] = src.groundNormal[2] }
  }

  _rememberWalls(server) {
    const planes = server.wallPlanes, sp = server.position, walls = this.walls
    for (let i = 0; planes && i + 2 < planes.length; i += 3) {
      const nx = planes[i], nz = planes[i + 1], d = planes[i + 2]
      let w = walls.find(x => Math.abs(x.nx - nx) < WALL_MATCH_NORMAL && Math.abs(x.nz - nz) < WALL_MATCH_NORMAL && Math.abs(x.d - d) < WALL_MATCH_OFFSET_M)
      const t = nx * sp[2] - nz * sp[0]
      if (!w) {
        if (walls.length >= WALL_CACHE_SIZE) walls.shift()
        w = { nx, nz, d, ay: 0, tMin: t, tMax: t }
        walls.push(w)
      }
      w.nx = nx; w.nz = nz; w.d = d; w.ay = sp[1]
      if (t < w.tMin) w.tMin = t
      if (t > w.tMax) w.tMax = t
    }
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i]
      const t = w.nx * sp[2] - w.nz * sp[0], off = w.nx * sp[0] + w.nz * sp[2] - w.d
      if (off > WALL_FORGET_M || off < -WALL_PASSED_M || t < w.tMin - WALL_FORGET_M || t > w.tMax + WALL_FORGET_M) walls.splice(i, 1)
    }
  }

  onServerSnapshot(snapshot, tick) {
    if (!Array.isArray(snapshot.players)) return
    if (tick <= this._teleportTick) return
    for (const serverPlayer of snapshot.players) {
      if (!serverPlayer || serverPlayer.id !== this.localPlayerId) continue
      if (!isValidPlayerSnapshot(serverPlayer)) continue
      this._reconcile(serverPlayer)
    }
  }

  _reconcile(serverPlayer) {
    const prevX = this.lastServerState.position[0], prevY = this.lastServerState.position[1], prevZ = this.lastServerState.position[2]
    this._copyState(serverPlayer, this.lastServerState)
    this._rememberWalls(serverPlayer)
    const sv = this.lastServerState
    const dx = sv.position[0] - prevX, dy = sv.position[1] - prevY, dz = sv.position[2] - prevZ
    this.horizontallyWedged = sv.onGround && (dx * dx + dz * dz) < WEDGE_POS_EPS_SQ && (sv.velocity[0] ** 2 + sv.velocity[2] ** 2) > WEDGE_VEL_EPS_SQ
    this.verticallyBlocked = !sv.onGround && dy * dy < WEDGE_POS_EPS_SQ && sv.velocity[1] < -Math.sqrt(WEDGE_VEL_EPS_SQ)
    this._calibrateSurface(sv)
    const ackedSeq = serverPlayer.inputSequence ?? -1
    const firstContact = !this._hasServerState
    this._hasServerState = true
    if (ackedSeq <= this._lastAckedSeq && !firstContact) return
    const ackIdx = this.inputHistory.indexOf(ackedSeq)
    const predicted = ackIdx >= 0 ? this.inputHistory.at(ackIdx) : null
    if (ackedSeq > this._lastAckedSeq) this._lastAckedSeq = ackedSeq
    this.stats.acks++
    let err = Infinity
    if (predicted) {
      const p = predicted.position, s = sv.position
      err = Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2])
    }
    this.inputHistory.dropThrough(ackedSeq)
    if (firstContact) {
      this._rebaseAndReplay(sv, predicted, false)
      this.reconciliationEngine.reset()
      this._trail.reset()
      return
    }
    if (err <= RECONCILE_POS_EPS_M) return
    this.stats.corrections++
    this._rebaseAndReplay(sv, predicted)
  }

  _rebaseAndReplay(server, predictedAtAck, recordCorrection = true) {
    const ls = this.localState
    const beforeX = ls.position[0], beforeY = ls.position[1], beforeZ = ls.position[2]
    const sp = server.position, sv = server.velocity
    ls.position[0] = sp[0]; ls.position[1] = sp[1]; ls.position[2] = sp[2]
    ls.velocity[0] = sv[0]; ls.velocity[1] = sv[1]; ls.velocity[2] = sv[2]
    ls.onGround = server.onGround
    ls.groundY = server.onGround || this.verticallyBlocked ? sp[1] : NaN
    if (predictedAtAck) for (const k of MOVE_STATE_KEYS) ls[k] = predictedAtAck.move[k]
    for (const e of this.inputHistory) { this._step(e.data, e.sequence); saveEntry(e, ls) }
    this._preserveKnockbackVelocity(Date.now())
    const jump = Math.hypot(ls.position[0] - beforeX, ls.position[1] - beforeY, ls.position[2] - beforeZ)
    if (recordCorrection) {
      this.stats.lastCorrectionM = jump
      if (jump > this.stats.maxCorrectionM) this.stats.maxCorrectionM = jump
    }
    this.reconciliationEngine.absorb(ls.position[0] - beforeX, ls.position[1] - beforeY, ls.position[2] - beforeZ, ls.onGround)
    this._trail.shift(ls.position[0] - beforeX, ls.position[1] - beforeY, ls.position[2] - beforeZ)
  }

  resimulate() { this._rebaseAndReplay(this.lastServerState, null, false) }

  _preserveKnockbackVelocity(now) {
    if (!this._enableKnockbackPreservation || !this._pendingKnockback) return
    const kb = this._pendingKnockback
    if (now - kb.startTime > this._knockbackWindow) { this._pendingKnockback = null; return }
    const vel = this.localState.velocity, dir = kb.dir
    const component = vel[0] * dir[0] + vel[2] * dir[2]
    if (component < kb.impulse) {
      vel[0] += (kb.impulse - component) * dir[0]
      vel[2] += (kb.impulse - component) * dir[2]
    }
  }

  getInputHistory() { return [...this.inputHistory] }

  calculateDivergence() {
    if (!this.lastServerState || !this.localState) return 0
    const a = this.localState.position, b = this.lastServerState.position
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  }
}
