// LockstepTickSystem: a fixed-dt tick driver for lockstep game modes (RTS/fighting), API-compatible
// with TickSystem.js's onTick(cb)/start()/stop()/getTick()/getTickDuration() contract so
// TickHandler.js's existing onTick(tick,dt) call shape (src/sdk/TickHandler.js:799) and any consumer
// that only calls the shared surface (ReplayRecorder.js, RollbackLoop.js) work unmodified against
// either driver.
//
// The one deliberate, load-bearing difference from TickSystem: dt is NEVER derived from wall-clock
// measurement. TickSystem's dilationFactor (_onTickMeasured/_onInterval) adaptively shrinks dt under
// server load so ONE authoritative server stays real-time-paced -- exactly the behavior a lockstep
// peer must never exhibit, since every peer has to independently derive the IDENTICAL dt sequence
// from tick number alone (deterministic-fixed-point-lockstep-architecture-for-rts-fighting's own
// multi-process probe proved this: float64 + Jolt is bit-exact across independent OS processes as
// long as dt is a pure function of tick, never wall-clock-adaptive). dt here is always exactly
// tickDuration/1000 (dilationFactor is fixed at 1.0 and has no setter) -- a fresh-every-tick
// perf.now() delta would reintroduce the exact wall-clock leakage this row exists to bypass, so this
// driver intentionally does NOT accumulate/measure real elapsed time to decide dt, only to decide
// WHEN to fire the next already-fixed-size tick (wall clock only paces cadence, never sizes the step).
//
// Shares TickSystemBase's accumulator/catch-up scheduling loop with TickSystem.js verbatim -- only
// _computeDt/_onTickMeasured differ (see that file's header comment for the shared-loop rationale).
import { TickSystemBase } from './TickSystemBase.js'

export class LockstepTickSystem extends TickSystemBase {
  constructor(tickRate = 60) {
    super(tickRate)
    this._tickErrorTag = '[lockstep-tick]'
    // dilationFactor stays fixed at 1.0 permanently -- unlike TickSystem, there is no
    // _onTickMeasured-driven mutation path at all, so this can never silently drift under load.
  }

  // Kept for API parity with TickSystem.onDilation -- lockstep mode never dilates, so a registered
  // callback simply never fires (still pushed into _dilationCallbacks for parity, just never invoked).
  // Real no-op, not a stub thrown away later: any shared caller (TickHandler.js's server.js:297-style
  // wiring) that unconditionally calls tickSystem.onDilation(...) must not throw when handed a
  // LockstepTickSystem instead of a TickSystem.

  _computeDt() {
    // dt is always the fixed, undilated tick duration -- the entire point of this driver. A stall
    // (debugger pause, GC, slow machine) changes HOW MANY fixed-size ticks fire in this catch-up
    // burst (same maxSteps cap as TickSystem), never the SIZE of any individual tick's dt.
    return this.tickDuration / 1000
  }

  _onTickMeasured(_budgetMs) {
    // no-op: this driver never adapts dt to measured tick cost (see header comment)
  }

  getTickDuration() {
    return this.tickDuration / 1000
  }
}
