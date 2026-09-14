export const DEFAULT_ANALOG_TOLERANCE_RAD = 0.02
const BOOLEAN_FIELDS = ['forward', 'backward', 'left', 'right', 'jump', 'crouch']
const EXACT_VALUE_FIELDS = ['expr']
const ANALOG_FIELDS = ['yaw', 'pitch']

export function inputsDiffer(a, b, analogToleranceRad = DEFAULT_ANALOG_TOLERANCE_RAD) {
  if (a == null && b == null) return false
  if (a == null || b == null) return true
  for (const f of BOOLEAN_FIELDS) {
    if (!!a[f] !== !!b[f]) return true
  }
  for (const f of EXACT_VALUE_FIELDS) {
    if ((a[f] || 0) !== (b[f] || 0)) return true
  }
  for (const f of ANALOG_FIELDS) {
    const av = a[f] || 0, bv = b[f] || 0
    if (Math.abs(av - bv) > analogToleranceRad) return true
  }
  return false
}

export function createMispredictionDetector({ windowSize = 16, analogToleranceRad = DEFAULT_ANALOG_TOLERANCE_RAD } = {}) {
  const predicted = new Map()

  function _ringFor(playerId) {
    let m = predicted.get(playerId)
    if (!m) { m = new Map(); predicted.set(playerId, m) }
    return m
  }

  function recordPredicted(playerId, tick, inputData) {
    const ring = _ringFor(playerId)
    ring.set(tick, inputData)
    if (ring.size > windowSize) {
      const oldestKey = ring.keys().next().value
      ring.delete(oldestKey)
    }
  }

  function predictedAt(playerId, tick) {
    const ring = predicted.get(playerId)
    return ring && ring.has(tick) ? ring.get(tick) : undefined
  }

  function onRemoteInputArrived(playerId, tick, arrivedInput, currentTick) {
    const pred = predictedAt(playerId, tick)
    if (pred === undefined) return null
    if (!inputsDiffer(pred, arrivedInput, analogToleranceRad)) return null

    _ringFor(playerId).set(tick, arrivedInput)

    const fromTick = tick - 1
    const toTick = currentTick != null ? currentTick : tick
    const correctedInputs = (t, pid) => (t === tick && pid === playerId) ? arrivedInput : null
    return { fromTick, correctedInputs, toTick, playerId, tick, predicted: pred, arrived: arrivedInput }
  }

  return { recordPredicted, predictedAt, onRemoteInputArrived, windowSize, analogToleranceRad }
}
