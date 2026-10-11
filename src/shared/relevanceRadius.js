export const DEFAULT_RELEVANCE_RADIUS_M = 200

export function resolveRelevanceRadius(value) {
  return typeof value === 'number' && value > 0 ? value : DEFAULT_RELEVANCE_RADIUS_M
}
