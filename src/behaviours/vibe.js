export class VibeError extends Error {
  constructor(reasonCode, detail) {
    super(`[vibe] ${reasonCode}: ${detail}`)
    this.name = 'VibeError'
    this.reasonCode = reasonCode
  }
}

export function parseVibe(spec, samples) {
  if (spec === null || typeof spec !== 'object') throw new VibeError('spec-invalid', 'pattern must be an object')
  if (!(samples instanceof Set)) throw new VibeError('samples-invalid', 'samples must be a Set of sample names')
  const { bpm, swing = 0, length, steps } = spec
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new VibeError('bpm-invalid', 'bpm must be in [20, 300]')
  if (typeof swing !== 'number' || !Number.isFinite(swing) || swing < 0 || swing > 0.5) throw new VibeError('swing-invalid', 'swing must be in [0, 0.5]')
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1) throw new VibeError('length-invalid', 'length must be a positive integer number of beats')
  if (!Array.isArray(steps)) throw new VibeError('steps-invalid', 'steps must be an array')
  const parsed = steps.map((step, i) => {
    if (step === null || typeof step !== 'object') throw new VibeError('step-invalid', `steps[${i}] must be an object`)
    if (!samples.has(step.sample)) throw new VibeError('unknown-sample', `steps[${i}] names sample "${step.sample}" which is not in the manifest`)
    if (typeof step.beat !== 'number' || !Number.isFinite(step.beat) || step.beat < 0 || step.beat >= length) throw new VibeError('beat-invalid', `steps[${i}].beat must be in [0, length)`)
    return Object.freeze({ sample: step.sample, beat: step.beat })
  })
  return Object.freeze({ bpm, swing, length, steps: Object.freeze(parsed) })
}

export function eventsBetween(pattern, fromBeat, toBeat) {
  if (!(toBeat >= fromBeat)) throw new VibeError('range-invalid', 'toBeat must be at least fromBeat')
  const out = []
  const firstLoop = Math.floor(fromBeat / pattern.length)
  const lastLoop = Math.floor(toBeat / pattern.length)
  for (let loop = firstLoop; loop <= lastLoop; loop++) {
    for (const step of pattern.steps) {
      const shift = step.beat % 1 === 0.5 ? pattern.swing : 0
      const at = loop * pattern.length + step.beat + shift
      if (at >= fromBeat && at < toBeat) out.push({ sample: step.sample, beat: at, seconds: at * 60 / pattern.bpm })
    }
  }
  return out.sort((a, b) => a.beat - b.beat)
}
