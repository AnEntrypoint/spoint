export const MIN_SAMPLES_FOR_P50 = 30
export const MIN_SAMPLES_FOR_ONE_PERCENT_LOW = 200
export const GATED_ARMS = ['static', 'orbit']
export const ADMISSIBLE_RASTERIZERS = ['accelerated', 'software']

export function worstPercentWindow(sampleCount) {
  return Math.max(1, Math.floor(sampleCount * 0.01))
}

export function unsupportedStatistics(sampleCount) {
  const unsupported = []
  if (!(sampleCount >= MIN_SAMPLES_FOR_P50)) {
    unsupported.push(`p50 needs at least ${MIN_SAMPLES_FOR_P50} samples, has ${sampleCount}`)
  }
  if (!(sampleCount >= MIN_SAMPLES_FOR_ONE_PERCENT_LOW)) {
    unsupported.push(`onePercentLow needs at least ${MIN_SAMPLES_FOR_ONE_PERCENT_LOW} samples to hold a ${worstPercentWindow(sampleCount)}-frame window wider than the single worst frame, has ${sampleCount}`)
  }
  return unsupported
}

export function baselineRefusals(baseline, metrics = null) {
  if (baseline == null) return ['no baseline present']

  const reasons = []
  const rasterizer = baseline.rasterizer

  if (!ADMISSIBLE_RASTERIZERS.includes(rasterizer)) {
    reasons.push(rasterizer === undefined
      ? 'baseline has no rasterizer field, so its frame times are of unrecorded class'
      : `baseline rasterizer is ${JSON.stringify(rasterizer)}, not one of ${ADMISSIBLE_RASTERIZERS.join('/')}`)
  } else if (metrics && metrics.rasterizer !== rasterizer) {
    reasons.push(`baseline was captured on ${rasterizer}, this run measured ${metrics.rasterizer} (${metrics.gpu || 'no gpu strings exposed'})`)
  }

  for (const arm of GATED_ARMS) {
    const entry = baseline[arm]
    if (entry == null) {
      reasons.push(`baseline has no ${arm} arm`)
      continue
    }
    const unsupported = unsupportedStatistics(entry.sampleCount)
    if (unsupported.length) reasons.push(`baseline ${arm} arm: ${unsupported.join('; ')}`)
  }

  return reasons
}
