import { TickSystemBase } from './TickSystemBase.js'

const DILATION_WINDOW = 60
const DILATION_THRESHOLD = 0.85
const DILATION_MIN = 0.1
// Proportional control: adjustment scales with how far load is from the threshold,
// clamped to [MIN_STEP, MAX_STEP] per measurement window instead of a fixed 0.05.
const DILATION_MIN_STEP = 0.01
const DILATION_MAX_STEP = 0.25
const DILATION_GAIN = 0.5

export class TickSystem extends TickSystemBase {
  // 60Hz default (was 128) -- mirrors src/sdk/server.js's config.tickRate||60; every real caller passes
  // tickRate explicitly, this is only a defensive fallback for direct instantiation.
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
      // Overload: scale the step by how far load exceeds the threshold -- heavier
      // overload recovers (dilates down) faster than a bare-threshold breach.
      const overloadRatio = (load - DILATION_THRESHOLD) / DILATION_THRESHOLD
      const step = Math.min(DILATION_MAX_STEP, Math.max(DILATION_MIN_STEP, overloadRatio * DILATION_GAIN))
      this.dilationFactor = Math.max(DILATION_MIN, +(this.dilationFactor - step).toFixed(3))
      for (const cb of this._dilationCallbacks) try { cb(this.dilationFactor) } catch (_) {}
    } else if (load < DILATION_THRESHOLD * 0.7 && this.dilationFactor < 1.0) {
      // Recovery: scale the step by how far below the recovery threshold load is --
      // light load recovers gently, a lot of headroom recovers faster.
      const recoveryRatio = (DILATION_THRESHOLD * 0.7 - load) / (DILATION_THRESHOLD * 0.7)
      const step = Math.min(DILATION_MAX_STEP, Math.max(DILATION_MIN_STEP, recoveryRatio * DILATION_GAIN))
      this.dilationFactor = Math.min(1.0, +(this.dilationFactor + step).toFixed(3))
      for (const cb of this._dilationCallbacks) try { cb(this.dilationFactor) } catch (_) {}
    }
  }

  getTickDuration() {
    return (this.tickDuration * this.dilationFactor) / 1000
  }
}
