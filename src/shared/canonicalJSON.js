function sortedKeysReplacer(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const sorted = Object.create(null)
  for (const k of Object.keys(value).sort()) sorted[k] = value[k]
  return sorted
}

export function canonicalJSON(value) {
  return JSON.stringify(value, sortedKeysReplacer)
}

const _hotSwapCanonicalJSON = (next) => {
  canonicalJSON = next.canonicalJSON
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapCanonicalJSON)
