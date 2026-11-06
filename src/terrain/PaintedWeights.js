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

const _hotSwapPaintedWeights = (next) => {
  paintedWeightsFor = next.paintedWeightsFor
  paintedSlopeOf = next.paintedSlopeOf
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapPaintedWeights)
