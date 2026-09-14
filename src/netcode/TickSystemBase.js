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

  setTickRate(tickRate) {
    if (!Number.isFinite(tickRate) || tickRate <= 0) return
    const oldDuration = this.tickDuration
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this._accumulator *= this.tickDuration / oldDuration
    if (this.running) {
      clearInterval(this._intervalHandle)
      const intervalMs = Math.max(1, this.tickDuration / 2)
      this._intervalHandle = setInterval(() => this._onInterval(), intervalMs)
      if (this._intervalHandle.unref) this._intervalHandle.unref()
    }
  }

  onDilation(cb) { this._dilationCallbacks.push(cb) }

  onTick(callback) {
    if (this.callbacks.includes(callback)) return
    this.callbacks.push(callback)
  }

  start() {
    if (this.running) return
    this._state = 'running'
    this.lastTickTime = performance.now()
    this._accumulator = 0
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
