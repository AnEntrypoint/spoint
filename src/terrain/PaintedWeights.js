import { createSplatWeights, HASH_VERSION_FLOAT } from 'mapspinner/splat-weights'

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
