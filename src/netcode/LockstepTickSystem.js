import { TickSystemBase } from './TickSystemBase.js'

export class LockstepTickSystem extends TickSystemBase {
  constructor(tickRate = 60) {
    super(tickRate)
    this._tickErrorTag = '[lockstep-tick]'
  }

  _computeDt() {
    return this.tickDuration / 1000
  }

  _onTickMeasured(_budgetMs) {
  }

  getTickDuration() {
    return this.tickDuration / 1000
  }
}
