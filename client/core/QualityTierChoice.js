export class QualityTierError extends Error {
  constructor(reasonCode, value) {
    super(`[quality-tier] ${reasonCode}`)
    this.name = 'QualityTierError'
    this.reasonCode = reasonCode
    this.value = value
  }
}

export function resolveQualityTier(requested, creatorMaxTier) {
  if (!Number.isInteger(creatorMaxTier) || creatorMaxTier < 0) throw new QualityTierError('bad-ceiling', creatorMaxTier)
  if (requested === null) return null
  if (!Number.isInteger(requested)) throw new QualityTierError('bad-request', requested)
  if (requested < 0 || requested > creatorMaxTier) throw new QualityTierError('out-of-range', requested)
  return requested
}
