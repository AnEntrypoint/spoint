export class WitnessUnreachedError extends Error {
  constructor(label, reasons) {
    super(`witness "${label}" never reached the state it measured: ${reasons.join('; ')}`)
    this.name = 'WitnessUnreachedError'
    this.reasons = reasons
  }
}

function markNames(marks) {
  if (!marks) return new Set()
  if (marks instanceof Set) return marks
  if (Array.isArray(marks)) return new Set(marks.map((m) => (m && typeof m === 'object' ? m.name : m)))
  return new Set(Object.keys(marks))
}

export function unreachedReasons(state = {}) {
  const marks = markNames(state.marks)
  const counts = state.counts || {}
  const reasons = []
  for (const name of state.requiredMarks || []) {
    if (!marks.has(name)) reasons.push(`boot mark "${name}" never fired`)
  }
  for (const name of state.requiredCounts || []) {
    const value = counts[name]
    if (value == null || !Number.isFinite(value) || value <= 0) reasons.push(`count "${name}" is ${JSON.stringify(value ?? null)} instead of a reached time in ms`)
  }
  return reasons
}

export function assertWitnessReached(label, state) {
  const reasons = unreachedReasons(state)
  if (reasons.length) throw new WitnessUnreachedError(label, reasons)
  return true
}
