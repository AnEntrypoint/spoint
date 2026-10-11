export const PLANET_RADIUS_M = 6360000.0

export function resolvePlanetRadiusM(opts = {}, label = 'mapspinner') {
  const given = opts.radiusM != null ? opts.radiusM : opts.radius
  if (given != null && (!Number.isFinite(given) || given <= 0)) {
    throw new TypeError(`${label}: planet radius must be a positive finite number of metres (opts.radiusM), got ${given}`)
  }
  return given != null ? given : PLANET_RADIUS_M
}
