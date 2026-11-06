export let DEFAULT_RELEVANCE_RADIUS_M = 200

export function resolveRelevanceRadius(value) {
  return typeof value === 'number' && value > 0 ? value : DEFAULT_RELEVANCE_RADIUS_M
}

const _hotSwapRelevanceRadius = (next) => {
  resolveRelevanceRadius = next.resolveRelevanceRadius
  DEFAULT_RELEVANCE_RADIUS_M = next.DEFAULT_RELEVANCE_RADIUS_M
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapRelevanceRadius)
