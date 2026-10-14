function sortedKeysReplacer(key, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const sorted = Object.create(null)
  for (const k of Object.keys(value).sort()) sorted[k] = value[k]
  return sorted
}

export function canonicalJSON(value) {
  return JSON.stringify(value, sortedKeysReplacer)
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapCanonicalJSON = (next) => {
  canonicalJSON = next.canonicalJSON
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapCanonicalJSON)
