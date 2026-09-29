const MAX_CATCH_UP_STEPS = 4
const FINE_TIMER_MS = 2
const TIMER_PROBE_SAMPLES = 5
const DEFAULT_COARSE_TIMER_MS = 16

const _yield = typeof setImmediate === 'function' ? setImmediate : null

let _timerGranularityMs = null
let _timerProbe = null
function probeTimerGranularity() {
  if (_timerGranularityMs !== null) return Promise.resolve(_timerGranularityMs)
  if (_timerProbe) return _timerProbe
  _timerProbe = (async () => {
    let worst = 0
    for (let i = 0; i < TIMER_PROBE_SAMPLES; i++) {
      const t = performance.now()
      await new Promise(r => setTimeout(r, 1))
      worst = Math.max(worst, performance.now() - t)
    }
    _timerGranularityMs = worst
    return worst
  })()
  return _timerProbe
}

export class TickSystemBase {
  constructor(tickRate = 60) {
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this.currentTick = 0
    this.lastTickTime = 0
    this.callbacks = []
    this._state = 'stopped'
    this._reloadResolve = null
    this._tickInProgress = false
    this.dilationFactor = 1.0
    this._dilationCallbacks = []
    this._nextDueMs = 0
    this._timer = null
    this._spinArmed = false
    this.precise = typeof process !== 'undefined' && process.env?.SPOINT_PRECISE_TICKS === '1'
    this.schedulerStats = { ticks: 0, droppedMs: 0, maxLateMs: 0, spinWakeups: 0, timerWakeups: 0 }
  }

  get running() { return this._state === 'running' }

  setTickRate(tickRate) {
    if (!Number.isFinite(tickRate) || tickRate <= 0) return
    const phase = this.running ? (this._nextDueMs - performance.now()) / this.tickDuration : 1
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    if (this.running) this._nextDueMs = performance.now() + Math.max(0, phase) * this.tickDuration
  }

  onDilation(cb) { this._dilationCallbacks.push(cb) }

  onTick(callback) {
    if (this.callbacks.includes(callback)) return
    this.callbacks.push(callback)
  }

  _usePreciseWait() {
    return !!this.precise && !!_yield && (_timerGranularityMs ?? DEFAULT_COARSE_TIMER_MS) > FINE_TIMER_MS
  }

  _earlyToleranceMs() {
    if (this._usePreciseWait()) return 0
    return Math.min(this.tickDuration / 2, (_timerGranularityMs ?? DEFAULT_COARSE_TIMER_MS) / 2)
  }

  start() {
    if (this.running) return
    this._state = 'running'
    this.lastTickTime = performance.now()
    this._nextDueMs = this.lastTickTime + this.tickDuration
    probeTimerGranularity()
    this._schedule()
  }

  _schedule() {
    if (!this.running && this._state !== 'paused') return
    if (this._timer || this._spinArmed) return
    const remaining = this._nextDueMs - performance.now()
    const precise = this._usePreciseWait()
    const granularity = _timerGranularityMs ?? DEFAULT_COARSE_TIMER_MS
    if (precise && remaining <= granularity + FINE_TIMER_MS) {
      this._spinArmed = true
      _yield(() => { this._spinArmed = false; this.schedulerStats.spinWakeups++; this._onWake() })
      return
    }
    const wait = precise ? remaining - granularity - FINE_TIMER_MS : remaining - this._earlyToleranceMs()
    this._timer = setTimeout(() => { this._timer = null; this.schedulerStats.timerWakeups++; this._onWake() }, Math.max(0, wait))
    if (this._timer.unref) this._timer.unref()
  }

  _onWake() {
    if (this._state === 'stopped') return
    if (this._state === 'running') this._runDueTicks()
    this._schedule()
  }

  _runDueTicks() {
    let now = performance.now()
    if (now - this._nextDueMs > this.tickDuration * MAX_CATCH_UP_STEPS) {
      const drop = now - this._nextDueMs - this.tickDuration * MAX_CATCH_UP_STEPS
      this.schedulerStats.droppedMs += drop
      this._nextDueMs += drop
    }
    let steps = 0
    const early = this._earlyToleranceMs()
    while (now >= this._nextDueMs - early && steps < MAX_CATCH_UP_STEPS && this._state === 'running') {
      const late = now - this._nextDueMs
      if (late > this.schedulerStats.maxLateMs) this.schedulerStats.maxLateMs = late
      this._nextDueMs += this.tickDuration
      this._runOneTick()
      steps++
      now = performance.now()
    }
  }

  _runOneTick() {
    const dt = this._computeDt()
    this._tickInProgress = true
    this.currentTick++
    this.lastTickTime = performance.now()
    this.schedulerStats.ticks++
    const t0 = this.lastTickTime
    for (const callback of this.callbacks) {
      try {
        callback(this.currentTick, dt)
      } catch (e) {
        console.error(this._tickErrorTag, e?.stack || e?.message || e)
      }
    }
    this._onTickMeasured(performance.now() - t0)
    this._tickInProgress = false
    if (this._reloadResolve) {
      this._reloadResolve()
      this._reloadResolve = null
    }
  }

  pauseForReload() {
    this._state = 'paused'
    if (!this._tickInProgress) return Promise.resolve()
    return new Promise(resolve => { this._reloadResolve = resolve })
  }

  resumeAfterReload() {
    this._state = 'running'
    this.lastTickTime = performance.now()
    this._nextDueMs = this.lastTickTime + this.tickDuration
    this._schedule()
  }

  stop() {
    this._state = 'stopped'
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
  }

  getTick() {
    return this.currentTick
  }
}

export { probeTimerGranularity }
