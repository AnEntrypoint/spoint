import { ReconciliationEngine } from './ReconciliationEngine.js'
import { applyMovement, DEFAULT_MOVEMENT } from '../shared/movement.js'

class RingBuffer {
  constructor(capacity = 512) {
    this._buf = new Array(capacity)
    this._head = 0
    this._tail = 0
    this._capacity = capacity
  }
  get length() { return this._tail - this._head }
  push(v) {
    if (this._tail - this._head >= this._capacity) {
      const newCap = this._capacity * 2
      const newBuf = new Array(newCap)
      for (let i = this._head; i < this._tail; i++) newBuf[i - this._head] = this._buf[i % this._capacity]
      this._buf = newBuf; this._capacity = newCap
      this._tail -= this._head; this._head = 0
    }
    this._buf[this._tail % this._capacity] = v
    this._tail++
  }
  shift() {
    if (this._head >= this._tail) return undefined
    this._head++
  }
  *[Symbol.iterator]() {
    for (let i = this._head; i < this._tail; i++) yield this._buf[i % this._capacity]
  }
  at(i) {
    if (i < 0) i = this.length + i
    if (i < 0 || i >= this.length) return undefined
    return this._buf[(this._head + i) % this._capacity]
  }
  last(n) {
    n = Math.min(n, this.length)
    const out = new Array(n)
    for (let i = 0; i < n; i++) out[i] = this._buf[(this._tail - n + i) % this._capacity]
    return out
  }
}

export class PredictionEngine {
  // 60Hz default (was 128) -- mirrors the server's default; the real value always arrives from the
  // server's HANDSHAKE_ACK/RECONNECT_ACK payload.tickRate (see MessageHandler.js), this is a pre-handshake
  // fallback only.
  constructor(tickRate = 60) {
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this.localPlayerId = null
    this.localState = null
    this.lastServerState = null
    this.inputHistory = new RingBuffer()
    this._inputSeq = 0
    this._lastAckedSeq = -1
    this.reconciliationEngine = new ReconciliationEngine()
    this.movement = { ...DEFAULT_MOVEMENT }
    this.gravityY = -9.81
    this._pendingKnockback = null // { dir, impulse, startTime }
    this._knockbackWindow = 200
    this._enableKnockbackPreservation = true
  }

  setMovement(m) { Object.assign(this.movement, m) }

  setGravity(g) { if (g && g[1] != null) this.gravityY = g[1] }

  recordKnockback(dir, impulse, now = Date.now()) {
    if (!this._enableKnockbackPreservation) return
    this._pendingKnockback = { dir: [...dir], impulse, startTime: now }
  }

  setKnockbackPreservation(enabled) {
    this._enableKnockbackPreservation = enabled
  }

  // must integrate at the server's real tick rate or every snapshot triggers a reconciliation correction
  setTickRate(rate) { if (rate > 0) { this.tickRate = rate; this.tickDuration = 1000 / rate } }

  init(playerId, initialState = {}) {
    this.localPlayerId = playerId
    const pos = initialState.position || [0, 0, 0]
    const rot = initialState.rotation || [0, 0, 0, 1]
    const vel = initialState.velocity || [0, 0, 0]
    // coyoteRemaining/bufferRemaining/_jumpHeld are client-only accumulated state, deliberately preserved by _copyState (not overwritten on resimulate)
    this.localState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health: initialState.health || 100, coyoteRemaining: 0, bufferRemaining: 0, _jumpHeld: false }
    this.lastServerState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health: initialState.health || 100 }
    this.reconciliationEngine.reset()
    this._renderState = { id: playerId, position: [...pos], rotation: [...rot], velocity: [...vel], onGround: true, health: initialState.health || 100 }
    this._pendingKnockback = null
  }

  // sequence is client-owned (server echoes highest applied) so acks stay meaningful across packet loss
  addInput(input) {
    const seq = this._inputSeq++
    this.inputHistory.push({ sequence: seq, data: input })
    // only drop the oldest entry once it's also acked -- shifting an unacked input causes a permanent desync
    if (this.inputHistory.length > 256 &&
        this.inputHistory.at(0).sequence <= this._lastAckedSeq) {
      this.inputHistory.shift()
    }
    this.predict(input)
    return seq
  }

  getUnackedInputs(max = 4) {
    return this.inputHistory.last(max)
  }

  predict(input) {
    const dt = this.tickDuration / 1000
    const state = this.localState
    applyMovement(state, input, this.movement, dt)
    state.velocity[1] += this.gravityY * dt
    state.position[0] += state.velocity[0] * dt
    state.position[1] += state.velocity[1] * dt
    state.position[2] += state.velocity[2] * dt
    if (state.position[1] < 0) {
      state.position[1] = 0
      state.velocity[1] = 0
      state.onGround = true
    }
  }

  // display-only: localState stays exact for logic/aim/spawn; call once per render frame (decay is frame-rate-driven)
  getRenderState() {
    const ls = this.localState
    if (!ls) return null
    const offset = this.reconciliationEngine.decay()
    const r = this._renderState || (this._renderState = { id: ls.id, position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], onGround: true, health: 100 })
    this._copyState(ls, r)
    r.position[0] = ls.position[0] - offset[0]
    r.position[1] = ls.position[1] - offset[1]
    r.position[2] = ls.position[2] - offset[2]
    // rotation glides toward the (exact) predicted rotation separately from position, on its own
    // smoothing constant -- decayRotation returns null once settled or if no glide is in progress,
    // in which case r.rotation (already copied exact from ls above) is correct as-is
    const rotGlide = this.reconciliationEngine.decayRotation(ls.rotation)
    if (rotGlide) { r.rotation[0] = rotGlide[0]; r.rotation[1] = rotGlide[1]; r.rotation[2] = rotGlide[2]; r.rotation[3] = rotGlide[3] }
    return r
  }

  // does NOT copy ephemeral movement timers (coyoteRemaining/bufferRemaining/_jumpHeld) -- do not add them here
  _copyState(src, dst) {
    dst.id = src.id; dst.onGround = src.onGround; dst.health = src.health; dst.inputSequence = src.inputSequence
    const sp = src.position, dp = dst.position; dp[0] = sp[0]; dp[1] = sp[1]; dp[2] = sp[2]
    const sr = src.rotation, dr = dst.rotation; dr[0] = sr[0]; dr[1] = sr[1]; dr[2] = sr[2]; dr[3] = sr[3]
    const sv = src.velocity, dv = dst.velocity; dv[0] = sv[0]; dv[1] = sv[1]; dv[2] = sv[2]
  }

  onServerSnapshot(snapshot, tick) {
    for (const serverPlayer of snapshot.players) {
      if (serverPlayer.id === this.localPlayerId) {
        this._copyState(serverPlayer, this.lastServerState)
        const ackedSeq = serverPlayer.inputSequence ?? -1
        // only advance on a newer ack -- a reordered snapshot must not move _lastAckedSeq backward
        if (ackedSeq > this._lastAckedSeq) {
          this._lastAckedSeq = ackedSeq
          while (this.inputHistory.length > 0 && this.inputHistory.at(0).sequence <= ackedSeq) {
            this.inputHistory.shift()
          }
        }
        const reconciliation = this.reconciliationEngine.reconcile(
          this.lastServerState, this.localState, tick
        )
        if (reconciliation.needsCorrection) {
          this.reconciliationEngine.applyCorrection(this.localState, reconciliation.correction)
          this.resimulate()
        }
      }
    }
  }

  resimulate() {
    this._copyState(this.lastServerState, this.localState)
    // Indexed walk instead of for-of over RingBuffer's generator iterator: a rollback replay is one
    // generator object plus one resume + {value,done} step per unacked input, per misprediction.
    const hist = this.inputHistory
    for (let i = 0, n = hist.length; i < n; i++) {
      this.predict(hist.at(i).data)
    }
    this._preserveKnockbackVelocity(Date.now())
  }

  _preserveKnockbackVelocity(now) {
    if (!this._enableKnockbackPreservation || !this._pendingKnockback) return
    const kb = this._pendingKnockback
    const elapsed = now - kb.startTime
    if (elapsed > this._knockbackWindow) {
      this._pendingKnockback = null
      return
    }
    const vel = this.localState.velocity
    const dir = kb.dir
    const component = vel[0] * dir[0] + vel[2] * dir[2]
    if (component < kb.impulse) {
      vel[0] += (kb.impulse - component) * dir[0]
      vel[2] += (kb.impulse - component) * dir[2]
    }
  }

  getInputHistory() { return [...this.inputHistory] }

  calculateDivergence() {
    if (!this.lastServerState || !this.localState) return 0
    const dx = this.localState.position[0] - this.lastServerState.position[0]
    const dy = this.localState.position[1] - this.lastServerState.position[1]
    const dz = this.localState.position[2] - this.lastServerState.position[2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
}
