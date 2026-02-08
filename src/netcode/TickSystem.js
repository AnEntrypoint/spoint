export class TickSystem {
  constructor(tickRate = 128) {
    this.tickRate = tickRate
    this.tickDuration = 1000 / tickRate
    this.currentTick = 0
    this.lastTickTime = 0
    this.callbacks = []
    this.running = false
    this._reloadLocked = false
    this._reloadResolve = null
    this._tickInProgress = false
  }

  onTick(callback) {
    this.callbacks.push(callback)
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastTickTime = Date.now()
    this.loop()
  }

  loop() {
    if (!this.running) return
    const now = Date.now()
    const elapsed = now - this.lastTickTime
    if (elapsed >= this.tickDuration && !this._reloadLocked) {
      this._tickInProgress = true
      this.currentTick++
      this.lastTickTime = now
      for (const callback of this.callbacks) {
        callback(this.currentTick, this.tickDuration / 1000)
      }
      this._tickInProgress = false
      if (this._reloadResolve) {
        this._reloadResolve()
        this._reloadResolve = null
      }
    }
    setImmediate(() => this.loop())
  }

  pauseForReload() {
    this._reloadLocked = true
    if (!this._tickInProgress) return Promise.resolve()
    return new Promise(resolve => { this._reloadResolve = resolve })
  }

  resumeAfterReload() {
    this._reloadLocked = false
  }

  stop() {
    this.running = false
  }

  getTick() {
    return this.currentTick
  }

  getTickDuration() {
    return this.tickDuration / 1000
  }
}
