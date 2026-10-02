import { TERRAIN_DEFAULTS as TD } from './terrain-defaults.js'
import { compileSnoise3 } from './tsl/ops-jsgen.js'
export { HASH_VERSION_FLOAT } from './tsl/height-spec.js'

const SAND_REGION_SLOPE = [0.18, 0.55]
const SAND_SLOPE_FADE = [0.30, 0.70]
const DRY_HOT_ARIDITY = [0.60, 0.85]
const DRY_HOT_TEMP = [0.42, 0.62]
const ROCK_BAND_SNOW_FRAC = [0.7, 0.9]
const SNOW_SUPPRESSED_BY_ROCK = 0.6
const BAND_WARP_FREQ = [1100.0, 2580.0]
const WEIGHT_EPS = 1e-4

const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => a + (b - a) * t

export function createSplatWeights({ hashVersion }) {
  const snoise3 = compileSnoise3({ hashVersion })
  const srLo = Math.max(TD.slopeRock[0], 0.05), srHi = Math.max(TD.slopeRock[1], srLo + 0.25)
  const sn = TD.snowEdges
  const out = { grass: 0, rock: 0, sand: 0, snow: 0 }

  return function splatWeights(dir, h, slope, temp, humid) {
    const bandWarp = (snoise3(dir[0] * BAND_WARP_FREQ[0], dir[1] * BAND_WARP_FREQ[0], dir[2] * BAND_WARP_FREQ[0])
      + 0.5 * snoise3(dir[0] * BAND_WARP_FREQ[1], dir[1] * BAND_WARP_FREQ[1], dir[2] * BAND_WARP_FREQ[1])) * TD.bandWarp * 0.25
    const dryHot = smoothstep(DRY_HOT_ARIDITY[0], DRY_HOT_ARIDITY[1], 1 - humid) * smoothstep(DRY_HOT_TEMP[0], DRY_HOT_TEMP[1], temp)
    const bwPos = Math.max(bandWarp, 0)
    const beach = (1 - smoothstep(bwPos, bwPos + TD.beachTop * TD.beachWidth, h)) * (1 - smoothstep(SAND_REGION_SLOPE[0], SAND_REGION_SLOPE[1], slope))
    const sandRegion = Math.min(Math.max(Math.max(dryHot, beach), 0), 1)
    const wRockSlope = smoothstep(mix(srLo, 0.50, sandRegion), mix(srHi, 0.70, sandRegion), slope)
    const snowHi = smoothstep(bandWarp + sn[0], bandWarp + sn[1], h)
    const rockBand = smoothstep(bandWarp + sn[0] * ROCK_BAND_SNOW_FRAC[0], bandWarp + sn[0] * ROCK_BAND_SNOW_FRAC[1], h) * (1 - snowHi)
    const wRock = Math.max(wRockSlope, rockBand)
    const wSnow = Math.min(Math.max(snowHi, 0), 1) * (1 - SNOW_SUPPRESSED_BY_ROCK * wRock)
    const wSand = sandRegion * (1 - wRock) * (1 - wSnow) * (1 - smoothstep(SAND_SLOPE_FADE[0], SAND_SLOPE_FADE[1], slope))
    const wGrass = Math.max(1 - wRock - wSnow - wSand, 0)
    const uwM = 1 - smoothstep(TD.beachTop * 0.3, TD.beachTop, h)
    const wz = wSand + (wGrass + wSnow) * uwM
    const wx = wGrass * (1 - uwM), ww = wSnow * (1 - uwM)
    const sum = wx + wRock + wz + ww + WEIGHT_EPS
    out.grass = wx / sum; out.rock = wRock / sum; out.sand = wz / sum; out.snow = ww / sum
    return out
  }
}
