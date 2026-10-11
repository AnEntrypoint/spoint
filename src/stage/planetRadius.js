const MINTED = new WeakSet()

const FLAT = { resolvedBy: 'flat', meters: 0 }
MINTED.add(FLAT)
Object.freeze(FLAT)

export function flatPlanetRadius() {
  return FLAT
}

export function clusterPlanetRadius(meters) {
  if (!Number.isFinite(meters) || meters <= 0) {
    throw new TypeError(`[stage] a cluster-resolved planet radius is a positive finite number of meters, got ${JSON.stringify(meters)}: resolveClusterConfig is its only source, so a radius it did not resolve is one no cell query origin can sit on`)
  }
  const value = { resolvedBy: 'cluster', meters }
  MINTED.add(value)
  return Object.freeze(value)
}

export function planetRadiusMeters(stageName, declared) {
  if (declared == null) return FLAT.meters
  if (!MINTED.has(declared)) {
    throw new TypeError(`[stage] stage "${stageName}" got planetRadius ${JSON.stringify(declared)}: a stage radius is parsed once at the boundary into flatPlanetRadius() or clusterPlanetRadius(meters), so a bare number no cluster resolved is not one the stage can accept`)
  }
  return declared.meters
}
