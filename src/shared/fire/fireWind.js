const MIX_A = 0x85ebca6b
const MIX_B = 0xc2b2ae35
const PHASE_PRIME = 0x9e3779b1
const AXIS_SPLIT_A = 0x27d4eb2f
const AXIS_SPLIT_B = 0x165667b1

function mix32(h) {
  h ^= h >>> 16
  h = Math.imul(h, MIX_A)
  h ^= h >>> 13
  h = Math.imul(h, MIX_B)
  return (h ^ (h >>> 16)) >>> 0
}

export function createWindField({ seed = 1, amplitude = 4, periodSteps = 1 } = {}) {
  const span = amplitude * 2 + 1
  return (step, out) => {
    const phase = periodSteps > 1 ? Math.floor(step / periodSteps) : step
    let h = mix32((seed ^ Math.imul(phase | 0, PHASE_PRIME)) | 0)
    out[0] = (h % span) - amplitude
    h = mix32(h ^ AXIS_SPLIT_A)
    out[1] = (h % span) - amplitude
    h = mix32(h ^ AXIS_SPLIT_B)
    out[2] = (h % span) - amplitude
    return out
  }
}
