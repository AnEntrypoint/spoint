// Shared fixed-timestep tick-scheduling base for TickSystem.js (adaptive, wall-clock-dilated) and
// LockstepTickSystem.js (fixed-dt, deterministic). Both drivers need the IDENTICAL accumulator/catch-up
// scheduling loop (a single setInterval at ~half the tick duration, consuming whole accumulated ticks
// per firing, capped at maxSteps=4 so a stall's catch-up burst is bounded) -- what differs is ONLY how
// each computes the dt handed to callbacks and whether it measures tick cost to adapt dilationFactor.
// Subclasses override _computeDt() (the per-tick dt in seconds) and _onTickMeasured(budgetMs) (called
// with each tick's real wall-clock cost, a no-op for the deterministic lockstep driver).

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
    this._accumulator = 0
    this._intervalHandle = null
  }

  get running() { return this._state === 'running' }

  onDilation(cb) { this._dilationCallbacks.push(cb) }

  onTick(callback) {
    // dedup by identity: re-registering the same callback must not fire it N times/tick
    if (this.callbacks.includes(callback)) return
    this.callbacks.push(callback)
  }

  start() {
    if (this.running) return
    this._state = 'running'
    this.lastTickTime = performance.now()
    this._accumulator = 0
    // Fixed-timestep scheduling: a single setInterval at roughly half the tick
    // duration drives the loop; each firing consumes as many whole ticks as have
    // accumulated (accumulator-based catch-up), instead of a setTimeout(...,1)/
    // setImmediate busy-loop that drifts and burns CPU re-scheduling every ~1ms.
    const intervalMs = Math.max(1, this.tickDuration / 2)
    this._intervalHandle = setInterval(() => this._onInterval(), intervalMs)
    if (this._intervalHandle.unref) this._intervalHandle.unref()
  }

  _onInterval() {
    if (!this.running) return
    const now = performance.now()
    this._accumulator += now - this.lastTickTime
    this.lastTickTime = now
    const maxSteps = 4
    // Cap the catch-up burst so a long stall (debugger pause, GC, reload) doesn't
    // try to replay an unbounded backlog of ticks in one go.
    const maxAccumulated = this.tickDuration * maxSteps
    if (this._accumulator > maxAccumulated) this._accumulator = maxAccumulated
    let steps = 0
    const isPaused = this._state === 'paused'
    while (this._accumulator >= this.tickDuration && !isPaused && steps < maxSteps) {
      const dt = this._computeDt()
      this._tickInProgress = true
      this.currentTick++
      this._accumulator -= this.tickDuration
      const t0 = performance.now()
      for (const callback of this.callbacks) {
        // a throwing callback must not abort the loop / wedge pauseForReload's _tickInProgress
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
      steps++
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
  }

  stop() {
    this._state = 'stopped'
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle)
      this._intervalHandle = null
    }
  }

  getTick() {
    return this.currentTick
  }
}
