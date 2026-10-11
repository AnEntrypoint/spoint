import { isNoGroundHeight } from '/src/terrain/PlanetFrame.js'

export const NO_GROUND_SAMPLE = Object.freeze({ empty: true, y: null })

export function commitGroundSample(sampleGround, x, z) {
  const y = sampleGround(x, z)
  return isNoGroundHeight(y) ? NO_GROUND_SAMPLE : { empty: false, y }
}
