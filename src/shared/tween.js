import { easing, EASING_NAMES } from './easing.js'

function refusal(code, message) {
  const err = new TypeError(`[tween] ${message}`)
  err.reasonCode = code
  return err
}

export function createTween({ from, to, durationMs, easingName = 'linear', onUpdate, onComplete = null } = {}) {
  if (!Number.isFinite(from)) throw refusal('tween-from-invalid', `from must be finite, got ${from}`)
  if (!Number.isFinite(to)) throw refusal('tween-to-invalid', `to must be finite, got ${to}`)
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw refusal('tween-duration-invalid', `durationMs must be a finite number above 0, got ${durationMs}`)
  if (typeof easingName !== 'string' || !EASING_NAMES.includes(easingName)) throw refusal('tween-easing-unknown', `unknown easing ${JSON.stringify(easingName)}`)
  if (typeof onUpdate !== 'function') throw refusal('tween-onUpdate-invalid', 'onUpdate must be a function')
  if (onComplete !== null && typeof onComplete !== 'function') throw refusal('tween-onComplete-invalid', 'onComplete must be a function or null')

  let elapsedMs = 0
  let value = from
  let done = false
  let cancelled = false

  return {
    get done() { return done },
    get cancelled() { return cancelled },
    get progress() { return Math.min(1, elapsedMs / durationMs) },
    get value() { return value },
    update(dtMs) {
      if (done || cancelled) return false
      if (!Number.isFinite(dtMs) || dtMs < 0) throw refusal('tween-dt-invalid', `dtMs must be a finite number at least 0, got ${dtMs}`)
      elapsedMs = Math.min(durationMs, elapsedMs + dtMs)
      const t = elapsedMs / durationMs
      value = from + (to - from) * easing(easingName, t)
      onUpdate(value, t)
      if (elapsedMs === durationMs) {
        done = true
        onComplete?.()
        return true
      }
      return false
    },
    cancel() { cancelled = true },
  }
}
