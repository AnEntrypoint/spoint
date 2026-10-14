const _isNode = typeof process !== 'undefined' && process.versions?.node
const _splatSpec = _isNode ? 'mapspinner/splat-weights' : '/node_modules/mapspinner/src/splat-weights.js'
const { createSplatWeights, HASH_VERSION_FLOAT } = await import(_splatSpec)

const _byHashVersion = new Map()

export function paintedWeightsFor(hashVersion) {
  const key = hashVersion ?? HASH_VERSION_FLOAT
  let w = _byHashVersion.get(key)
  if (!w) { w = createSplatWeights({ hashVersion: key }); _byHashVersion.set(key, w) }
  return w
}

export function paintedSlopeOf(dHdx, dHdz) {
  return 1 - 1 / Math.sqrt(1 + dHdx * dHdx + dHdz * dHdz)
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
const _hotSwapPaintedWeights = (next) => {
  paintedWeightsFor = next.paintedWeightsFor
  paintedSlopeOf = next.paintedSlopeOf
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapPaintedWeights)
