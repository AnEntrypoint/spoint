import { TickSystemBase } from './TickSystemBase.js'

const DILATION_WINDOW = 60
const DILATION_THRESHOLD = 0.85
const DILATION_RECOVERY_THRESHOLD = DILATION_THRESHOLD * 0.7
const DILATION_MIN = 0.1
const DILATION_MIN_STEP = 0.01
const DILATION_MAX_STEP = 0.25
const DILATION_GAIN = 0.5

export class TickSystem extends TickSystemBase {
  constructor(tickRate = 60) {
    super(tickRate)
    this._tickErrorTag = '[tick]'
    this._tickBudgetMs = []
    this._tickBudgetSum = 0
  }

  _computeDt() {
    return (this.tickDuration * this.dilationFactor) / 1000
  }

  _onTickMeasured(budget) {
    this._tickBudgetMs.push(budget)
    this._tickBudgetSum += budget
    if (this._tickBudgetMs.length > DILATION_WINDOW) {
      this._tickBudgetSum -= this._tickBudgetMs.shift()
    }
    if (this._tickBudgetMs.length < DILATION_WINDOW) return
    const avgMs = this._tickBudgetSum / DILATION_WINDOW
    const load = avgMs / (this.tickDuration * this.dilationFactor)
    if (load > DILATION_THRESHOLD && this.dilationFactor > DILATION_MIN) {
      const overloadRatio = (load - DILATION_THRESHOLD) / DILATION_THRESHOLD
      const step = Math.min(DILATION_MAX_STEP, Math.max(DILATION_MIN_STEP, overloadRatio * DILATION_GAIN))
      this.dilationFactor = Math.max(DILATION_MIN, +(this.dilationFactor - step).toFixed(3))
      for (const cb of this._dilationCallbacks) try { cb(this.dilationFactor) } catch (_) {}
    } else if (load < DILATION_RECOVERY_THRESHOLD && this.dilationFactor < 1.0) {
      const recoveryRatio = (DILATION_RECOVERY_THRESHOLD - load) / DILATION_RECOVERY_THRESHOLD
      const step = Math.min(DILATION_MAX_STEP, Math.max(DILATION_MIN_STEP, recoveryRatio * DILATION_GAIN))
      this.dilationFactor = Math.min(1.0, +(this.dilationFactor + step).toFixed(3))
      for (const cb of this._dilationCallbacks) try { cb(this.dilationFactor) } catch (_) {}
    }
  }

  getTickDuration() {
    return (this.tickDuration * this.dilationFactor) / 1000
  }
}
